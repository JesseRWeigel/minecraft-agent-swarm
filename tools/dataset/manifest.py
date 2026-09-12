#!/usr/bin/env python3
"""Strict streaming readers for private dataset archive manifests."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import tempfile
from typing import Iterator


MAX_V1_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_V2_ROOT_BYTES = 1024 * 1024
MAX_SHARD_BYTES = 16 * 1024 * 1024
MAX_RECORD_LINE_BYTES = 64 * 1024
HASH_RE = re.compile(r"[a-f0-9]{64}")


class ManifestError(ValueError):
    """A manifest or one of its archived files cannot be trusted."""


def _reject_constant(_value: str):
    raise ManifestError("nonfinite JSON constant")


def strict_decode(data: bytes | str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ManifestError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    def number(value: str):
        result = float(value)
        if not math.isfinite(result):
            raise ManifestError("nonfinite JSON number")
        return result

    try:
        return json.loads(
            data,
            parse_constant=_reject_constant,
            object_pairs_hook=pairs,
            parse_float=number,
        )
    except (json.JSONDecodeError, UnicodeError, RecursionError) as error:
        raise ManifestError(f"invalid JSON: {error}") from error


def _portable_relpath(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ManifestError(f"invalid {label} path")
    if value.startswith("/") or any(part in ("", ".", "..") for part in value.split("/")):
        raise ManifestError(f"{label} path traversal is not allowed")
    parsed = PurePosixPath(value)
    if parsed.is_absolute():
        raise ManifestError(f"invalid {label} path")
    return value


def safe_archive_file(root: Path, relpath: object) -> Path:
    rel = _portable_relpath(relpath, "archive")
    target = root
    for part in PurePosixPath(rel).parts:
        target = target / part
        if target.is_symlink():
            raise ManifestError(f"archive symlink is not allowed: {rel}")
    try:
        info = target.lstat()
    except FileNotFoundError as error:
        raise ManifestError(f"missing archive file: {rel}") from error
    if not stat.S_ISREG(info.st_mode):
        raise ManifestError(f"archive path is not a regular file: {rel}")
    return target


def _read_document(path: Path) -> tuple[dict, str]:
    if path.is_symlink():
        raise ManifestError("manifest symlink is not allowed")
    try:
        info = path.stat()
    except FileNotFoundError as error:
        raise ManifestError(f"missing manifest: {path}") from error
    if not stat.S_ISREG(info.st_mode):
        raise ManifestError("manifest is not a regular file")
    limit = max(MAX_V1_MANIFEST_BYTES, MAX_V2_ROOT_BYTES)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ManifestError("manifest is not a regular file")
        data = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ):
        raise ManifestError("manifest changed while reading")
    if len(data) > limit:
        raise ManifestError("oversized manifest")
    document = strict_decode(data)
    if not isinstance(document, dict):
        raise ManifestError("manifest root must be an object")
    version = document.get("schema_version")
    if type(version) is not int or version not in (1, 2):
        raise ManifestError("unsupported manifest schema version")
    version_limit = MAX_V1_MANIFEST_BYTES if version == 1 else MAX_V2_ROOT_BYTES
    if len(data) > version_limit:
        raise ManifestError("oversized manifest root")
    return document, hashlib.sha256(data).hexdigest()


def _nonnegative_int(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ManifestError(f"invalid {label}")
    return value


def _hash(value: object, label: str) -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise ManifestError(f"invalid {label} hash")
    return value


def _validate_file_entry(entry: object, schema_version: int) -> dict:
    if not isinstance(entry, dict):
        raise ManifestError("invalid file record")
    _portable_relpath(entry.get("archive_relpath"), "archive")
    _portable_relpath(entry.get("source_relpath"), "source")
    _hash(entry.get("sha256"), "file")
    captured = _nonnegative_int(entry.get("captured_bytes"), "captured bytes")
    source_size = _nonnegative_int(entry.get("source_size_at_open"), "source size")
    if source_size < captured:
        raise ManifestError("source size is smaller than captured bytes")
    if entry.get("status") not in ("complete", "complete_prefix"):
        raise ManifestError("invalid capture status")
    if not isinstance(entry.get("source_kind"), str) or not entry["source_kind"]:
        raise ManifestError("missing source kind")
    cutoff = entry.get("complete_line_cutoff")
    if cutoff is not None and (type(cutoff) is not int or not 0 <= cutoff <= captured):
        raise ManifestError("invalid complete-line cutoff")
    if schema_version == 1 and entry["source_kind"] == "trajectory_jsonl" and cutoff != captured:
        raise ManifestError("invalid trajectory cutoff")
    if "expected_sha256" in entry:
        _hash(entry["expected_sha256"], "expected file")
    if "transformation_version" in entry and not isinstance(entry["transformation_version"], str):
        raise ManifestError("invalid transformation version")
    return entry


class ManifestReader:
    """Open one finalized v1 archive or v2 sharded run export."""

    def __init__(self, manifest_path: Path | str):
        self.path = Path(manifest_path).absolute()
        self.root = self.path.parent
        self.document, self.manifest_sha256 = _read_document(self.path)
        self.schema_version = self.document["schema_version"]
        if self.schema_version == 1:
            if self.document.get("complete") is not True or not isinstance(self.document.get("files"), list):
                raise ManifestError("require complete version-1 archive")
        else:
            self._validate_v2_root()

    def _validate_v2_root(self) -> None:
        doc = self.document
        if doc.get("manifest_kind") != "run_export" or doc.get("copy_complete") is not True:
            raise ManifestError("require complete version-2 run export")
        if doc.get("episode_complete") is not False or doc.get("episode_completion_basis") != "not_independently_verified":
            raise ManifestError("episode completeness must remain independently unverified")
        if not isinstance(doc.get("run_id"), str) or not doc["run_id"]:
            raise ManifestError("missing run ID")
        if doc.get("scope") not in ("closed_run", "observed_prefix"):
            raise ManifestError("invalid run scope")
        if doc.get("run_closed") is not (doc["scope"] == "closed_run"):
            raise ManifestError("run closure status conflicts with scope")
        if doc.get("censored") is not (doc["scope"] == "observed_prefix"):
            raise ManifestError("censoring status conflicts with scope")
        closure = doc.get("closure")
        if not isinstance(closure, dict) or closure.get("kind") not in ("offline_snapshot", "operator_assertion"):
            raise ManifestError("invalid closure provenance")
        for key in ("reference", "asserted_by"):
            if not isinstance(closure.get(key), str) or not closure[key].strip():
                raise ManifestError("incomplete closure provenance")
        if not isinstance(doc.get("audit"), dict) or not isinstance(doc.get("storage"), dict):
            raise ManifestError("missing audit or storage summary")
        totals = doc.get("totals")
        if not isinstance(totals, dict):
            raise ManifestError("missing manifest totals")
        for key in ("files", "captured_bytes", "shards"):
            _nonnegative_int(totals.get(key), f"total {key}")
        shards = doc.get("shards")
        if not isinstance(shards, list) or len(shards) != totals["shards"]:
            raise ManifestError("manifest shard count mismatch")
        seen = set()
        for shard in shards:
            if not isinstance(shard, dict):
                raise ManifestError("invalid shard record")
            rel = _portable_relpath(shard.get("archive_relpath"), "shard")
            if rel in seen:
                raise ManifestError("duplicate shard path")
            seen.add(rel)
            _hash(shard.get("sha256"), "shard")
            size = _nonnegative_int(shard.get("bytes"), "shard bytes")
            if size > MAX_SHARD_BYTES:
                raise ManifestError("oversized manifest shard")
            _nonnegative_int(shard.get("file_count"), "shard file count")
            _nonnegative_int(shard.get("captured_bytes"), "shard captured bytes")

    def iter_files(self) -> Iterator[dict]:
        with tempfile.TemporaryDirectory(prefix="manifest-paths-") as temporary:
            database = sqlite3.connect(Path(temporary) / "paths.sqlite")
            database.execute("CREATE TABLE paths(path TEXT PRIMARY KEY)")
            total_files = 0
            total_bytes = 0
            try:
                if self.schema_version == 1:
                    sources = iter(self.document["files"])
                else:
                    sources = self._iter_v2_files()
                for raw_entry in sources:
                    entry = _validate_file_entry(raw_entry, self.schema_version)
                    try:
                        database.execute("INSERT INTO paths VALUES (?)", (entry["archive_relpath"],))
                    except sqlite3.IntegrityError as error:
                        raise ManifestError(f"duplicate archive path: {entry['archive_relpath']}") from error
                    total_files += 1
                    total_bytes += entry["captured_bytes"]
                    yield entry
                if self.schema_version == 2:
                    totals = self.document["totals"]
                    if total_files != totals["files"] or total_bytes != totals["captured_bytes"]:
                        raise ManifestError("manifest totals do not reconcile")
            finally:
                database.close()

    def _iter_v2_files(self) -> Iterator[dict]:
        for shard in self.document["shards"]:
            target = safe_archive_file(self.root, shard["archive_relpath"])
            count = 0
            captured = 0
            digest = hashlib.sha256()
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            with os.fdopen(os.open(target, flags), "rb") as handle:
                before = os.fstat(handle.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ManifestError("manifest shard is not a regular file")
                if before.st_size != shard["bytes"]:
                    raise ManifestError("manifest shard size mismatch")
                while True:
                    line = handle.readline(MAX_RECORD_LINE_BYTES + 1)
                    if not line:
                        break
                    digest.update(line)
                    if len(line) > MAX_RECORD_LINE_BYTES:
                        raise ManifestError("manifest shard record is oversized")
                    if not line.endswith(b"\n"):
                        raise ManifestError("manifest shard has an incomplete tail")
                    entry = strict_decode(line)
                    entry = _validate_file_entry(entry, 2)
                    count += 1
                    captured += entry["captured_bytes"]
                    yield entry
                after = os.fstat(handle.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ino) != (
                after.st_size,
                after.st_mtime_ns,
                after.st_ino,
            ):
                raise ManifestError("manifest shard changed while reading")
            if digest.hexdigest() != shard["sha256"]:
                raise ManifestError("manifest shard hash mismatch")
            if count != shard["file_count"] or captured != shard["captured_bytes"]:
                raise ManifestError("manifest shard totals do not reconcile")


def _verify_file(path: Path, entry: dict) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(os.open(path, flags), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ManifestError("archive path is not a regular file")
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
        cutoff = entry.get("complete_line_cutoff")
        if cutoff:
            handle.seek(cutoff - 1)
            cutoff_byte = handle.read(1)
        else:
            cutoff_byte = b""
        after = os.fstat(handle.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ):
        raise ManifestError("archive file changed while verifying")
    if size != entry["captured_bytes"] or digest.hexdigest() != entry["sha256"]:
        raise ManifestError(f"archive file hash or size mismatch: {entry['archive_relpath']}")
    if cutoff and cutoff_byte != b"\n":
        raise ManifestError(f"complete-line cutoff is not newline terminated: {entry['archive_relpath']}")


def verify_manifest(manifest_path: Path | str) -> dict:
    reader = ManifestReader(manifest_path)
    files = 0
    captured = 0
    for entry in reader.iter_files():
        _verify_file(safe_archive_file(reader.root, entry["archive_relpath"]), entry)
        files += 1
        captured += entry["captured_bytes"]
    _, final_manifest_hash = _read_document(reader.path)
    if final_manifest_hash != reader.manifest_sha256:
        raise ManifestError("manifest changed while verifying")
    return {
        "schema_version": reader.schema_version,
        "files": files,
        "captured_bytes": captured,
        "shards": len(reader.document.get("shards", [])),
        "manifest_sha256": reader.manifest_sha256,
    }
