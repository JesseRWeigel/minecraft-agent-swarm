"""Restore pinned backups into a new private, not-yet-started server runtime."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import tarfile
import tempfile
import time

from tools.pilot import prepare as prep

WORLD_ROOTS = {"ai-world", "ai-world_nether", "ai-world_the_end"}
DISCARDED = {"server.properties", "usercache.json", "ops.json", "whitelist.json"}
MAX_ARCHIVE = 8 * 1024**3
MAX_JAR = 512 * 1024**2
MAX_EXPANDED = 4 * 1024**3
MAX_MEMBERS = 100_000
RESERVE = 40 * 1024**3
CLAIM_LIMIT = 'Bytes restored and hashed only; Minecraft format, server version, readiness and trial validity are unverified.'
PROPERTIES = """server-ip=127.0.0.1
server-port=25585
level-name=ai-world
enable-rcon=false
enable-query=false
enable-status=false
online-mode=true
enforce-secure-profile=true
max-players=5
view-distance=4
simulation-distance=4
enable-command-block=false
sync-chunk-writes=true
"""


class RestoreError(ValueError):
    """The restoration inputs or runtime cannot be verified."""


def _pin(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise RestoreError("explicit lowercase SHA-256 pin required")


def _eula(raw):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeError as exc:
        raise RestoreError("EULA input must be UTF-8") from exc
    settings = []
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#"):
            settings.append(line)
    if settings != ["eula=true"]:
        raise RestoreError("existing operator-accepted eula=true file required; no acceptance is generated")


def _space(parent, needed, reserve):
    if shutil.disk_usage(parent).free - needed < reserve:
        raise RestoreError("insufficient free space for copy and configured reserve")


def _copy_pinned(source, target, expected, maximum, private, reserve):
    _pin(expected)
    fd, initial = prep._open_regular(source, "pinned input", maximum)
    try:
        _space(private, initial.st_size, reserve)
        digest, size = prep._copy_archive_fd(fd, target, initial.st_size, private)
        if digest != expected or prep._archive_signature(initial) != prep._archive_signature(os.fstat(fd)):
            raise RestoreError("pinned input hash mismatch or source changed during copy")
        return size
    finally:
        os.close(fd)


def _decompress(source, target, limit, deadline_seconds, reserve):
    zstd = shutil.which("zstd")
    if not zstd:
        raise RestoreError("zstd is required for compressed backups")
    started = time.monotonic()
    with source.open("rb") as compressed, target.open("xb") as output:
        os.chmod(target, 0o600)
        child = subprocess.Popen([zstd, "-dc"], stdin=compressed, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C"}, start_new_session=True)
        selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
        total = 0
        try:
            while True:
                remaining = deadline_seconds - (time.monotonic() - started)
                if remaining <= 0:
                    raise RestoreError("archive decompression deadline exceeded")
                if not selector.select(min(remaining, 0.2)):
                    continue
                chunk = os.read(child.stdout.fileno(), 1024 * 1024)
                if not chunk: break
                total += len(chunk)
                if total > limit:
                    raise RestoreError("decompressed archive exceeds safety limit")
                _space(target.parent, len(chunk), reserve)
                output.write(chunk)
            remaining = deadline_seconds - (time.monotonic() - started)
            if remaining <= 0 or child.wait(timeout=remaining) != 0:
                raise RestoreError("archive decompression failed")
        finally:
            selector.close(); child.stdout.close()
            if child.poll() is None: child.kill()
            child.wait()


def _member_path(member):
    name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
    parts = name.split("/")
    if not name or len(name) > 1024 or len(parts) > 32 or any(not x or x in {".", ".."} for x in parts) or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise RestoreError("unsafe or excessive archive path")
    if parts[0] in WORLD_ROOTS:
        if len(parts) == 1 and not member.isdir():
            raise RestoreError("world root must be a directory")
        return name, True
    if len(parts) == 1 and name in DISCARDED and member.isfile() and member.size <= 1024 * 1024:
        return name, False
    raise RestoreError("archive member outside allowed world trees")


def _walk_tar(stream):
    while True:
        header = prep._read_exact(stream, 512, "header")
        if header == b"\0" * 512: return
        member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        yield member
        # The consumer must read all member bytes before requesting another.
        prep._read_exact(stream, (-member.size) % 512, "padding")


def _inspect(archive, max_expanded_bytes):
    with archive.open("rb") as stream:
        scan = prep._scan_tar_stream(stream, MAX_MEMBERS, max_expanded_bytes)
    roots = set(); names = {}; discarded = []; path_bytes = 0
    with archive.open("rb") as stream:
        for member in _walk_tar(stream):
            name, keep = _member_path(member)
            path_bytes += len(name.encode("utf-8"))
            if path_bytes > 16 * 1024**2: raise RestoreError("archive path metadata exceeds bound")
            if keep:
                roots.add(name.split("/")[0])
                # Reject regular-file ancestors and a file replacing a directory.
                parts = name.split("/")
                for index in range(1, len(parts)):
                    ancestor = "/".join(parts[:index])
                    if names.get(ancestor) == "file": raise RestoreError("archive path prefix conflict")
                    names.setdefault(ancestor, "implicit_dir")
                if name in names and (not member.isdir() or names[name] != "implicit_dir"):
                    raise RestoreError("archive path collision")
                names[name] = "dir" if member.isdir() else "file"
                if len(names) > MAX_MEMBERS: raise RestoreError("archive directory expansion exceeds bound")
            else: discarded.append(name)
            prep._consume_exact(stream, member.size, "member")
    if roots != WORLD_ROOTS or names.get("ai-world/level.dat") != "file":
        raise RestoreError("backup must contain all three world roots and overworld level.dat")
    return scan, sorted(discarded)


def _extract(archive, output):
    records = []
    with archive.open("rb") as stream:
        for member in _walk_tar(stream):
            name, keep = _member_path(member)
            if not keep:
                prep._consume_exact(stream, member.size, "discarded metadata"); continue
            path = output / name
            if member.isdir():
                prep._ensure_private_directory(path, output); continue
            prep._ensure_private_directory(path.parent, output)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            digest = hashlib.sha256()
            try:
                with os.fdopen(fd, "wb", closefd=False) as target:
                    remaining = member.size
                    while remaining:
                        chunk = prep._read_exact(stream, min(1024 * 1024, remaining), "file")
                        target.write(chunk); digest.update(chunk); remaining -= len(chunk)
                os.fchmod(fd, 0o600)
            finally: os.close(fd)
            records.append({"path": name, "sha256": digest.hexdigest(), "bytes": member.size})
    return records


def restore(archive, archive_sha256, jar, jar_sha256, eula, output, *, reserve_bytes=RESERVE, max_expanded_bytes=MAX_EXPANDED, bootstrap=None):
    archive, jar, eula, output = map(Path, (archive, jar, eula, output))
    try:
        _pin(archive_sha256); _pin(jar_sha256)
        if type(reserve_bytes) is not int or reserve_bytes < 0 or type(max_expanded_bytes) is not int or not 0 < max_expanded_bytes <= MAX_EXPANDED:
            raise RestoreError("invalid storage bounds")
        parent = prep._validate_destination(output, [archive, jar, eula] + ([Path(bootstrap)] if bootstrap is not None else []))
        eula_file = prep._capture_file(eula, "existing accepted EULA", 64 * 1024); _eula(eula_file.raw)
        if not (archive.name.endswith(".tar") or archive.name.endswith(".tar.zst")):
            raise RestoreError("backup must be .tar or .tar.zst")
        with tempfile.TemporaryDirectory(prefix="pilot-restore-", dir=parent) as staging:
            private = Path(staging)
            copied = private / "snapshot.archive"
            _copy_pinned(archive, copied, archive_sha256, MAX_ARCHIVE, private, reserve_bytes)
            copied_jar = private / "server.jar"
            jar_bytes = _copy_pinned(jar, copied_jar, jar_sha256, MAX_JAR, private, reserve_bytes)
            bootstrap_record = None
            if bootstrap is not None:
                from tools.pilot.bootstrap import inspect_bootstrap
                bootstrap_record = inspect_bootstrap(copied_jar)
                if bootstrap_record is None:
                    raise RestoreError("pinned JAR declares no supported bootstrap dependency")
                bootstrap_record = dict(bootstrap_record)
                bootstrap_record["bytes"] = _copy_pinned(Path(bootstrap), private / "bootstrap.jar", bootstrap_record["sha256"], MAX_JAR, private, reserve_bytes)
            tar_path = copied
            if archive.name.endswith(".tar.zst"):
                tar_path = private / "snapshot.tar"
                _decompress(copied, tar_path, max_expanded_bytes + MAX_MEMBERS * 1024 + prep.MAX_TAR_ZERO_PADDING, 300, reserve_bytes)
            scan, discarded = _inspect(tar_path, max_expanded_bytes)
            _space(parent, scan["expanded_bytes"] + jar_bytes + (bootstrap_record["bytes"] if bootstrap_record else 0) + len(eula_file.raw) + 16 * 1024**2, reserve_bytes)
            prep._mkdir_private(output)
            records = _extract(tar_path, output)
            # Copy the already verified private jar; no original input is reopened.
            _copy_pinned(copied_jar, output / "server.jar", jar_sha256, MAX_JAR, output, reserve_bytes)
            for name, raw in [("eula.txt", eula_file.raw), ("server.properties", PROPERTIES.encode())]:
                prep._write_private(output / name, raw, output)
                records.append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
            records.append({"path": "server.jar", "sha256": jar_sha256, "bytes": jar_bytes})
            if bootstrap_record:
                _copy_pinned(private / "bootstrap.jar", output / bootstrap_record["path"], bootstrap_record["sha256"], MAX_JAR, output, reserve_bytes)
                records.append(bootstrap_record)
            manifest = {"bootstrap": bootstrap_record, "schema_version": 1, "kind": "isolated_minecraft_runtime", "status": "restored_not_started", "snapshot_sha256": archive_sha256, "server_jar_sha256": jar_sha256, "world_name": "ai-world", "world_roots": sorted(WORLD_ROOTS), "isolated_network_required": True, "eula_source": "existing_operator_accepted_file", "discarded_archive_entries": discarded, "archive_scan": scan, "files": sorted(records, key=lambda x: x["path"]), "claim_limit": CLAIM_LIMIT}
            prep._write_private(output / "runtime-manifest.json", (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode(), output)
            return manifest
    except (prep.PreparationError, OSError, ValueError, UnicodeError, tarfile.TarError, subprocess.TimeoutExpired) as exc:
        if isinstance(exc, RestoreError): raise
        raise RestoreError(str(exc)) from exc


def verify_runtime(runtime_dir, manifest_sha256):
    runtime = Path(runtime_dir)
    try:
        _pin(manifest_sha256); prep._reject_symlink_components(runtime, "runtime")
        if runtime.stat().st_mode & 0o077: raise RestoreError("runtime root must be private")
        captured = prep._capture_file(runtime / "runtime-manifest.json", "runtime manifest", 32 * 1024**2)
        if captured.sha256 != manifest_sha256: raise RestoreError("runtime manifest hash mismatch")
        manifest = prep._parse_json(captured, "runtime manifest")
        fields = {"bootstrap", "schema_version", "kind", "status", "snapshot_sha256", "server_jar_sha256", "world_name", "world_roots", "isolated_network_required", "eula_source", "discarded_archive_entries", "archive_scan", "files", "claim_limit"}
        if set(manifest) not in (fields, fields - {"bootstrap"}) or manifest.get("eula_source") != "existing_operator_accepted_file" or manifest.get("claim_limit") != CLAIM_LIMIT:
            raise RestoreError("invalid runtime manifest claims")
        discarded = manifest["discarded_archive_entries"]
        if not isinstance(discarded, list) or any(not isinstance(item, str) or item not in DISCARDED for item in discarded) or len(discarded) != len(set(discarded)):
            raise RestoreError("invalid discarded archive entries")
        scan = manifest["archive_scan"]
        if not isinstance(scan, dict) or set(scan) != {"member_count", "regular_file_count", "expanded_bytes"} or any(type(value) is not int or value < 0 for value in scan.values()) or not 1 <= scan["regular_file_count"] <= scan["member_count"] <= MAX_MEMBERS or scan["expanded_bytes"] > MAX_EXPANDED:
            raise RestoreError("invalid archive scan metadata")
        if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1 or manifest.get("kind") != "isolated_minecraft_runtime" or manifest.get("status") != "restored_not_started" or manifest.get("isolated_network_required") is not True or manifest.get("world_name") != "ai-world" or manifest.get("world_roots") != sorted(WORLD_ROOTS):
            raise RestoreError("unsupported runtime manifest")
        _pin(manifest["snapshot_sha256"]); _pin(manifest["server_jar_sha256"])
        bootstrap_record = manifest.get("bootstrap")
        if bootstrap_record is not None:
            if not isinstance(bootstrap_record, dict) or set(bootstrap_record) != {"path", "sha256", "bytes"} or not isinstance(bootstrap_record["path"], str) or not re.fullmatch(r"cache/mojang_[0-9]+\.[0-9]+(?:\.[0-9]+)?\.jar", bootstrap_record["path"]) or type(bootstrap_record["bytes"]) is not int or not 0 < bootstrap_record["bytes"] <= MAX_JAR:
                raise RestoreError("invalid bootstrap record")
            _pin(bootstrap_record["sha256"])
        extra_paths = {bootstrap_record["path"]} if bootstrap_record else set()
        entries = manifest["files"]
        if not isinstance(entries, list) or not 4 <= len(entries) <= MAX_MEMBERS + 4: raise RestoreError("invalid runtime file count")
        expected = set(); total = 0
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes"}: raise RestoreError("invalid runtime file record")
            name = entry["path"]
            if not isinstance(name, str) or name in expected or name.startswith("/") or "\\" in name or any(part in {"", ".", ".."} for part in name.split("/")): raise RestoreError("invalid runtime file path")
            if name not in {"server.jar", "server.properties", "eula.txt"} | extra_paths and name.split("/")[0] not in WORLD_ROOTS: raise RestoreError("unexpected runtime file")
            _pin(entry["sha256"])
            if type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= MAX_EXPANDED: raise RestoreError("invalid runtime file size")
            total += entry["bytes"]
            if total > MAX_EXPANDED + 2 * MAX_JAR + 1024**2: raise RestoreError("runtime exceeds safety bound")
            fd, info = prep._open_regular(runtime / name, "runtime file", entry["bytes"])
            try:
                if info.st_mode & 0o077 or info.st_size != entry["bytes"]: raise RestoreError("runtime file privacy or size mismatch")
                digest = hashlib.sha256(); remaining = info.st_size
                while remaining:
                    chunk = os.read(fd, min(1024**2, remaining))
                    if not chunk: raise RestoreError("runtime file shrank")
                    digest.update(chunk); remaining -= len(chunk)
                if os.read(fd, 1) or digest.hexdigest() != entry["sha256"] or prep._archive_signature(info) != prep._archive_signature(os.fstat(fd)): raise RestoreError("runtime file hash mismatch or changed")
            finally: os.close(fd)
            expected.add(name)
        if bootstrap_record:
            from tools.pilot.bootstrap import inspect_bootstrap
            declared = inspect_bootstrap(runtime / "server.jar")
            if declared != {key: bootstrap_record[key] for key in ("path", "sha256")} or bootstrap_record not in entries:
                raise RestoreError("bootstrap record disagrees with pinned JAR or files")
        world_records = [entry for entry in entries if entry["path"].split("/")[0] in WORLD_ROOTS]
        world_bytes = sum(entry["bytes"] for entry in world_records)
        if scan["regular_file_count"] != len(world_records) + len(discarded) or not world_bytes <= scan["expanded_bytes"] <= world_bytes + len(discarded) * 1024**2:
            raise RestoreError("archive scan does not match restored world files")
        if not {"server.jar", "server.properties", "eula.txt", "ai-world/level.dat"} <= expected: raise RestoreError("required runtime files missing")
        if next(e["sha256"] for e in entries if e["path"] == "server.jar") != manifest["server_jar_sha256"]: raise RestoreError("server jar identity mismatch")
        properties = prep._capture_file(runtime / "server.properties", "properties", 65536)
        if properties.raw != PROPERTIES.encode(): raise RestoreError("runtime properties differ from fixed isolation configuration")
        _eula(prep._capture_file(runtime / "eula.txt", "EULA", 65536).raw)
        seen = set(); count = 0
        for directory, dirs, files in os.walk(runtime, followlinks=False):
            count += len(dirs) + len(files)
            if count > MAX_MEMBERS + 6: raise RestoreError("runtime tree too large")
            for name in dirs:
                relative = (Path(directory) / name).relative_to(runtime).parts
                if (relative[0] not in WORLD_ROOTS and not (bootstrap_record and relative == ("cache",))) or len(relative) > 32:
                    raise RestoreError("unexpected runtime directory")
            for name in dirs + files:
                path = Path(directory) / name
                if path.is_symlink() or path.stat().st_mode & 0o077: raise RestoreError("runtime contains nonprivate path or symlink")
            seen.update((Path(directory) / name).relative_to(runtime).as_posix() for name in files)
        if seen != expected | {"runtime-manifest.json"}: raise RestoreError("unlisted or missing runtime file")
        if any(not (runtime / name).is_dir() for name in WORLD_ROOTS): raise RestoreError("world directory missing")
        return manifest
    except (prep.PreparationError, OSError, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, RestoreError): raise
        raise RestoreError(str(exc)) from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["archive", "jar", "eula", "output"]: parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--archive-sha256", required=True); parser.add_argument("--jar-sha256", required=True)
    parser.add_argument("--reserve-bytes", type=int, default=RESERVE)
    parser.add_argument("--bootstrap", type=Path, help="existing cached bootstrap JAR; hash/path come from the pinned server JAR")
    args = parser.parse_args(argv)
    try:
        manifest = restore(args.archive, args.archive_sha256, args.jar, args.jar_sha256, args.eula, args.output, reserve_bytes=args.reserve_bytes, bootstrap=args.bootstrap)
    except RestoreError as exc:
        print(f"error: {exc}", file=__import__("sys").stderr); return 2
    pin = prep._capture_file(args.output / "runtime-manifest.json", "runtime manifest", 32 * 1024**2).sha256
    print(json.dumps({"status": manifest["status"], "manifest_sha256": pin, "runtime": str(args.output)})); return 0


if __name__ == "__main__": raise SystemExit(main())
