import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MAX_FILES = 100_000
MAX_TOTAL_BYTES = 2 * 1024**3
MAX_FILE_BYTES = 256 * 1024**2
DEFAULT_RESERVE_BYTES = 40 * 1024**3
MAX_MANIFEST_BYTES = 32 * 1024**2
_BUFFER_BYTES = 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class ClientToolsError(ValueError):
    pass


@dataclass(frozen=True)
class _SourceFile:
    source: Path
    destination: str
    signature: tuple[int, int, int, int, int]


def _signature(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _private_mode(path: Path, expected: int, label: str) -> None:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or stat.S_IMODE(info.st_mode) != expected:
        raise ClientToolsError(f"{label} has unsafe permissions")


def _safe_name(name: str) -> None:
    if not name or name in (".", "..") or "\\" in name or "/" in name or any(ord(char) < 32 for char in name):
        raise ClientToolsError("unsafe source path")


def _safe_relative(value: str) -> PurePosixPath:
    try:
        relative = PurePosixPath(value)
    except (TypeError, ValueError) as exc:
        raise ClientToolsError("unsafe manifest path") from exc
    if not value or relative.is_absolute() or relative.as_posix() != value:
        raise ClientToolsError("unsafe manifest path")
    for part in relative.parts:
        _safe_name(part)
    return relative


def _reject_symlink_components(path: Path, label: str) -> Path:
    absolute = Path(os.path.abspath(path))
    current = absolute
    existing = []
    while True:
        existing.append(current)
        if current.parent == current:
            break
        current = current.parent
    for component in reversed(existing):
        if not component.exists() and not component.is_symlink():
            continue
        if stat.S_ISLNK(os.lstat(component).st_mode):
            raise ClientToolsError(f"{label} contains a symlink component")
    return absolute


def _regular_signature(path: Path, label: str) -> tuple[int, int, int, int, int]:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise ClientToolsError(f"cannot inspect {label}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise ClientToolsError(f"{label} must be a regular file")
    if info.st_size > MAX_FILE_BYTES:
        raise ClientToolsError(f"{label} exceeds the file size limit")
    return _signature(info)


def _scan_modules(root: Path) -> tuple[list[_SourceFile], list[str], list[tuple[Path, tuple[int, int, int, int, int]]]]:
    try:
        root_info = os.lstat(root)
    except OSError as exc:
        raise ClientToolsError("cannot inspect node_modules") from exc
    if not stat.S_ISDIR(root_info.st_mode):
        raise ClientToolsError("node_modules must be a directory")
    files: list[_SourceFile] = []
    excluded: list[str] = []
    directories: list[tuple[Path, tuple[int, int, int, int, int]]] = []

    def visit(directory: Path, relative: PurePosixPath) -> None:
        initial = _signature(os.lstat(directory))
        directories.append((directory, initial))
        try:
            with os.scandir(directory) as scanned:
                entries = sorted(scanned, key=lambda entry: entry.name)
        except OSError as exc:
            raise ClientToolsError("cannot scan node_modules") from exc
        for entry in entries:
            _safe_name(entry.name)
            child_relative = relative / entry.name
            destination = (PurePosixPath("node_modules") / child_relative).as_posix()
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ClientToolsError("cannot inspect node_modules entry") from exc
            is_package_bin = entry.name == ".bin" and (not relative.parts or relative.parts[-1] == "node_modules")
            if is_package_bin:
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise ClientToolsError("node_modules .bin entry is not a directory")
                excluded.append(destination)
                continue
            if stat.S_ISDIR(info.st_mode):
                visit(Path(entry.path), child_relative)
            elif stat.S_ISREG(info.st_mode):
                if info.st_size > MAX_FILE_BYTES:
                    raise ClientToolsError("node_modules file exceeds the file size limit")
                files.append(_SourceFile(Path(entry.path), destination, _signature(info)))
                if len(files) + 2 > MAX_FILES:
                    raise ClientToolsError("snapshot exceeds the file count limit")
            else:
                raise ClientToolsError("node_modules contains a symlink or special file")
        if _signature(os.lstat(directory)) != initial:
            raise ClientToolsError("node_modules changed during scan")

    visit(root, PurePosixPath())
    return files, excluded, directories


def _open_regular(path: Path, expected: tuple[int, int, int, int, int], label: str) -> int:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = -1
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
    except OSError as exc:
        if descriptor >= 0:
            os.close(descriptor)
        raise ClientToolsError(f"cannot open {label}") from exc
    if not stat.S_ISREG(info.st_mode) or _signature(info) != expected:
        os.close(descriptor)
        raise ClientToolsError(f"{label} changed before copy")
    return descriptor


def _mkdir_private(path: Path) -> None:
    try:
        os.mkdir(path, 0o700)
        os.chmod(path, 0o700, follow_symlinks=False)
    except OSError as exc:
        raise ClientToolsError("cannot create private snapshot directory") from exc


def _ensure_parent(root: Path, relative: PurePosixPath) -> Path:
    current = root
    for part in relative.parts[:-1]:
        current /= part
        if current.exists():
            info = os.lstat(current)
            if not stat.S_ISDIR(info.st_mode):
                raise ClientToolsError("snapshot parent is not a directory")
        else:
            _mkdir_private(current)
    return root.joinpath(*relative.parts)


def _copy_file(item: _SourceFile, root: Path, mode: int) -> dict[str, object]:
    relative = _safe_relative(item.destination)
    destination = _ensure_parent(root, relative)
    source_fd = _open_regular(item.source, item.signature, item.destination)
    output_fd = -1
    hasher = hashlib.sha256()
    copied = 0
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        output_fd = os.open(destination, flags, mode)
        os.fchmod(output_fd, mode)
        remaining = item.signature[2]
        while remaining:
            data = os.read(source_fd, min(_BUFFER_BYTES, remaining))
            if not data:
                raise ClientToolsError(f"{item.destination} changed during copy")
            view = memoryview(data)
            while view:
                written = os.write(output_fd, view)
                if written <= 0:
                    raise ClientToolsError("snapshot write failed")
                view = view[written:]
            hasher.update(data)
            copied += len(data)
            remaining -= len(data)
        if os.read(source_fd, 1):
            raise ClientToolsError(f"{item.destination} changed during copy")
        os.fsync(output_fd)
        if _signature(os.fstat(source_fd)) != item.signature or _signature(os.lstat(item.source)) != item.signature:
            raise ClientToolsError(f"{item.destination} changed during copy")
    except OSError as exc:
        raise ClientToolsError(f"failed to copy {item.destination}") from exc
    finally:
        os.close(source_fd)
        if output_fd >= 0:
            os.close(output_fd)
    return {"bytes": copied, "path": item.destination, "sha256": hasher.hexdigest()}


def _write_new(path: Path, payload: bytes, mode: int = 0o600) -> None:
    descriptor = -1
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, mode)
        os.fchmod(descriptor, mode)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fsync(descriptor)
    except OSError as exc:
        raise ClientToolsError("cannot write snapshot manifest") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _cleanup_created(root: Path, identity: tuple[int, int]) -> None:
    try:
        info = os.lstat(root)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode):
        root.unlink()
        return
    if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == identity:
        shutil.rmtree(root)


def snapshot_tools(
    node_binary: Path,
    node_modules: Path,
    client_script: Path,
    output: Path,
    *,
    reserve_bytes: int = DEFAULT_RESERVE_BYTES,
) -> dict[str, object]:
    if type(reserve_bytes) is not int or reserve_bytes < 0:
        raise ClientToolsError("reserve_bytes must be a non-negative integer")
    node = _reject_symlink_components(Path(node_binary), "Node binary")
    modules = _reject_symlink_components(Path(node_modules), "node_modules")
    client = _reject_symlink_components(Path(client_script), "qualification client")
    destination = _reject_symlink_components(Path(output), "snapshot output")
    if destination.exists() or destination.is_symlink():
        raise ClientToolsError("snapshot output already exists")
    if not destination.parent.is_dir():
        raise ClientToolsError("snapshot output parent does not exist")

    node_signature = _regular_signature(node, "Node binary")
    client_signature = _regular_signature(client, "qualification client")
    module_files, excluded, module_directories = _scan_modules(modules)
    sources = [
        _SourceFile(node, "bin/node", node_signature),
        _SourceFile(client, "qualification-client.mjs", client_signature),
        *module_files,
    ]
    if len(sources) > MAX_FILES:
        raise ClientToolsError("snapshot exceeds the file count limit")
    total = sum(item.signature[2] for item in sources)
    if total > MAX_TOTAL_BYTES:
        raise ClientToolsError("snapshot exceeds the total size limit")
    filesystem = os.statvfs(destination.parent)
    free_bytes = filesystem.f_bavail * filesystem.f_frsize
    if free_bytes - total < reserve_bytes:
        raise ClientToolsError(f"copy would cross the {reserve_bytes}-byte storage reserve")

    _mkdir_private(destination)
    created = os.lstat(destination)
    identity = (created.st_dev, created.st_ino)
    try:
        _mkdir_private(destination / "bin")
        _mkdir_private(destination / "node_modules")
        records = [_copy_file(item, destination, 0o700 if item.destination == "bin/node" else 0o600) for item in sources]
        for source_directory, original_signature in module_directories:
            try:
                current_signature = _signature(os.lstat(source_directory))
            except OSError as exc:
                raise ClientToolsError("node_modules changed during copy") from exc
            if current_signature != original_signature:
                raise ClientToolsError("node_modules changed during copy")
        records.sort(key=lambda record: record["path"])
        manifest = {
            "excluded_paths": sorted(excluded),
            "files": records,
            "limits": {
                "max_file_bytes": MAX_FILE_BYTES,
                "max_files": MAX_FILES,
                "max_total_bytes": MAX_TOTAL_BYTES,
            },
            "schema_version": 1,
            "status": "client_tools_snapshotted",
            "storage_preflight": {
                "free_bytes_before": free_bytes,
                "input_bytes": total,
                "reserve_bytes": reserve_bytes,
            },
        }
        raw = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        _write_new(destination / "manifest.json", raw)
        return {"manifest": manifest, "manifest_sha256": hashlib.sha256(raw).hexdigest()}
    except Exception:
        _cleanup_created(destination, identity)
        raise


def _capture(path: Path, label: str, maximum: int, *, keep_bytes: bool) -> tuple[bytes | None, str, int]:
    signature = _regular_signature(path, label)
    if signature[2] > maximum:
        raise ClientToolsError(f"{label} exceeds size limit")
    descriptor = _open_regular(path, signature, label)
    hasher = hashlib.sha256()
    chunks = [] if keep_bytes else None
    remaining = signature[2]
    try:
        while remaining:
            data = os.read(descriptor, min(_BUFFER_BYTES, remaining))
            if not data:
                raise ClientToolsError(f"{label} changed during verification")
            if chunks is not None:
                chunks.append(data)
            hasher.update(data)
            remaining -= len(data)
        if os.read(descriptor, 1) or _signature(os.fstat(descriptor)) != signature or _signature(os.lstat(path)) != signature:
            raise ClientToolsError(f"{label} changed during verification")
    finally:
        os.close(descriptor)
    return (b"".join(chunks) if chunks is not None else None), hasher.hexdigest(), signature[2]


def verify_tools(root: Path, manifest_sha256: str) -> dict[str, object]:
    if not isinstance(manifest_sha256, str) or not _SHA256.fullmatch(manifest_sha256):
        raise ClientToolsError("invalid manifest hash")
    snapshot = _reject_symlink_components(Path(root), "tool snapshot")
    try:
        root_info = os.lstat(snapshot)
    except OSError as exc:
        raise ClientToolsError("cannot inspect tool snapshot") from exc
    if not stat.S_ISDIR(root_info.st_mode):
        raise ClientToolsError("tool snapshot must be a directory")
    _private_mode(snapshot, 0o700, "tool snapshot")
    raw, actual_hash, _ = _capture(snapshot / "manifest.json", "manifest", MAX_MANIFEST_BYTES, keep_bytes=True)
    if actual_hash != manifest_sha256:
        raise ClientToolsError("manifest hash mismatch")
    _private_mode(snapshot / "manifest.json", 0o600, "manifest")
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClientToolsError("invalid snapshot manifest") from exc
    if not isinstance(manifest, dict) or set(manifest) != {"excluded_paths", "files", "limits", "schema_version", "status", "storage_preflight"}:
        raise ClientToolsError("invalid snapshot manifest")
    if manifest["schema_version"] != 1 or manifest["status"] != "client_tools_snapshotted":
        raise ClientToolsError("unsupported snapshot manifest")
    files = manifest["files"]
    excluded = manifest["excluded_paths"]
    if not isinstance(files, list) or not isinstance(excluded, list) or len(files) > MAX_FILES:
        raise ClientToolsError("invalid snapshot manifest")
    if excluded != sorted(set(excluded)):
        raise ClientToolsError("invalid excluded path list")
    for value in excluded:
        relative = _safe_relative(value)
        if relative.parts[0] != "node_modules" or relative.parts[-1] != ".bin":
            raise ClientToolsError("invalid excluded path list")

    if manifest["limits"] != {
        "max_file_bytes": MAX_FILE_BYTES,
        "max_files": MAX_FILES,
        "max_total_bytes": MAX_TOTAL_BYTES,
    }:
        raise ClientToolsError("invalid snapshot limits")
    storage = manifest["storage_preflight"]
    if not isinstance(storage, dict) or set(storage) != {"free_bytes_before", "input_bytes", "reserve_bytes"}:
        raise ClientToolsError("invalid storage preflight")
    if any(type(storage[key]) is not int or storage[key] < 0 for key in storage):
        raise ClientToolsError("invalid storage preflight")

    expected_files = {"manifest.json"}
    expected_dirs = {"bin", "node_modules"}
    previous = ""
    declared_total = 0
    records = []
    for record in files:
        if not isinstance(record, dict) or set(record) != {"bytes", "path", "sha256"}:
            raise ClientToolsError("invalid file record")
        relative = _safe_relative(record["path"])
        if record["path"] <= previous or record["path"] == "manifest.json":
            raise ClientToolsError("file records must be uniquely sorted")
        previous = record["path"]
        if record["path"] not in ("bin/node", "qualification-client.mjs") and relative.parts[0] != "node_modules":
            raise ClientToolsError("invalid file destination")
        if ".bin" in relative.parts:
            raise ClientToolsError("excluded .bin path appears in file records")
        if type(record["bytes"]) is not int or not 0 <= record["bytes"] <= MAX_FILE_BYTES or not isinstance(record["sha256"], str) or not _SHA256.fullmatch(record["sha256"]):
            raise ClientToolsError("invalid file record")
        declared_total += record["bytes"]
        expected_files.add(record["path"])
        parts = relative.parts
        for index in range(1, len(parts)):
            expected_dirs.add(PurePosixPath(*parts[:index]).as_posix())
        records.append((record, relative))
    if declared_total > MAX_TOTAL_BYTES or storage["input_bytes"] != declared_total:
        raise ClientToolsError("snapshot exceeds the total size limit")
    if not {"bin/node", "qualification-client.mjs"}.issubset(expected_files):
        raise ClientToolsError("snapshot omits a required tool")

    seen_files = set()
    seen_dirs = set()
    for directory, directories, filenames in os.walk(snapshot, topdown=True, followlinks=False):
        base = Path(directory)
        for name in directories:
            _safe_name(name)
            child = base / name
            info = os.lstat(child)
            if not stat.S_ISDIR(info.st_mode):
                raise ClientToolsError("snapshot contains a symlink or special entry")
            relative = child.relative_to(snapshot).as_posix()
            seen_dirs.add(relative)
            _private_mode(child, 0o700, relative)
        for name in filenames:
            _safe_name(name)
            child = base / name
            info = os.lstat(child)
            if not stat.S_ISREG(info.st_mode):
                raise ClientToolsError("snapshot contains a symlink or special entry")
            seen_files.add(child.relative_to(snapshot).as_posix())
    if seen_files != expected_files or seen_dirs != expected_dirs:
        raise ClientToolsError("unlisted or missing runtime file or directory")

    for record, relative in records:
        path = snapshot.joinpath(*relative.parts)
        expected_mode = 0o700 if record["path"] == "bin/node" else 0o600
        _private_mode(path, expected_mode, record["path"])
        _, file_hash, file_bytes = _capture(path, record["path"], MAX_FILE_BYTES, keep_bytes=False)
        if file_bytes != record["bytes"] or file_hash != record["sha256"]:
            raise ClientToolsError(f"snapshot file mismatch: {record['path']}")
    return manifest
