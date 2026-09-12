#!/usr/bin/env python3
"""Stream, finalize, and verify immutable archives of allowlisted bot data."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import shutil
import stat
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator, TextIO


SCHEMA_VERSION = 1
CHUNK_SIZE = 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
TOP_LEVEL_FIELDS = {"schema_version", "captured_at_utc", "source_root", "complete", "files"}
FILE_FIELDS = {
    "source_relpath",
    "archive_relpath",
    "sha256",
    "source_size_at_open",
    "captured_bytes",
    "complete_line_cutoff",
    "status",
    "source_kind",
}
SOURCE_KINDS = {
    "trajectory_jsonl",
    "session_json",
    "runtime_log",
    "csv",
    "server_log",
    "skill_artifact",
    "memory",
    "training_metadata",
    "extra_tmp_log",
    "supervisor_jsonl",
    "ops_metadata",
    "world_backup",
    "trajectory_v2",
    "event_jsonl",
    "event_payload",
}
TRAINING_TOP_LEVEL = {
    "README.md",
    "train_lora.py",
    "train.log",
    "dataset.jsonl",
    "Modelfile",
}
TRAINING_METADATA_NAMES = {
    "README.md",
    "adapter_config.json",
    "chat_template.jinja",
    "config.json",
    "generation_config.json",
    "merges.txt",
    "model.safetensors.index.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "trainer_state.json",
    "vocab.json",
}


class ArchiveError(RuntimeError):
    """The requested archive could not be proven complete and immutable."""


@dataclass(frozen=True)
class SourceSpec:
    path: Path
    source_relpath: str
    archive_relpath: str
    source_kind: str
    line_bounded: bool
    validate_json: bool
    expected_sha256: str | None = None


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _lstat_regular(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ArchiveError(f"source disappeared: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ArchiveError(f"symlink source rejected: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ArchiveError(f"source is not a regular file: {path}")
    return info


def _assert_directory(path: Path, label: str) -> Path:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ArchiveError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ArchiveError(f"{label} may not be a symlink: {path}")
    if not stat.S_ISDIR(info.st_mode):
        raise ArchiveError(f"{label} is not a directory: {path}")
    return path.resolve(strict=True)


def _assert_no_symlink_components(path: Path, stop: Path | None = None) -> None:
    current = path.absolute()
    stop_abs = stop.absolute() if stop is not None else None
    while True:
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ArchiveError(f"symlink path component rejected: {current}")
        if stop_abs is not None and current == stop_abs:
            return
        if current.parent == current:
            return
        current = current.parent


def _open_source(path: Path) -> tuple[BinaryIO, os.stat_result]:
    _lstat_regular(path)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise
    handle = os.fdopen(descriptor, "rb", buffering=0)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        handle.close()
        raise ArchiveError(f"source is not a regular file: {path}")
    return handle, info


def _copy_exact(source: BinaryIO, destination: BinaryIO, byte_count: int) -> tuple[str, int]:
    """Copy exactly byte_count bytes, returning the full hash and last LF offset."""
    remaining = byte_count
    digest = hashlib.sha256()
    position = 0
    last_newline = 0
    while remaining:
        chunk = source.read(min(CHUNK_SIZE, remaining))
        if not chunk:
            raise ArchiveError(f"source truncated while reading at byte {position} of {byte_count}")
        destination.write(chunk)
        digest.update(chunk)
        newline = chunk.rfind(b"\n")
        if newline >= 0:
            last_newline = position + newline + 1
        position += len(chunk)
        remaining -= len(chunk)
    return digest.hexdigest(), last_newline


def _hash_exact(source: BinaryIO, byte_count: int) -> str:
    source.seek(0)
    remaining = byte_count
    digest = hashlib.sha256()
    while remaining:
        chunk = source.read(min(CHUNK_SIZE, remaining))
        if not chunk:
            raise ArchiveError(f"source truncated during verification at {byte_count - remaining} of {byte_count}")
        digest.update(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    path = Path(path)
    _lstat_regular(path)
    digest = hashlib.sha256()
    flags = os.O_RDONLY | (getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(os.open(path, flags), "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class _JsonStreamParser:
    """A non-materializing RFC 8259 syntax parser for archived JSON files."""

    def __init__(self, handle: TextIO):
        self.handle = handle
        self.lookahead: str | None = None

    def peek(self) -> str:
        if self.lookahead is None:
            self.lookahead = self.handle.read(1)
        return self.lookahead

    def take(self) -> str:
        value = self.peek()
        self.lookahead = None
        return value

    def whitespace(self) -> None:
        while self.peek() in " \t\r\n" and self.peek() != "":
            self.take()

    def expect(self, expected: str) -> None:
        actual = self.take()
        if actual != expected:
            raise ArchiveError(f"invalid JSON: expected {expected!r}, found {actual!r}")

    def value(self, depth: int = 0) -> None:
        if depth > 256:
            raise ArchiveError("invalid JSON: nesting exceeds 256 levels")
        self.whitespace()
        token = self.peek()
        if token == '"':
            self.string()
        elif token == "{":
            self.object(depth + 1)
        elif token == "[":
            self.array(depth + 1)
        elif token in "-0123456789" and token != "":
            self.number()
        elif token == "t":
            self.literal("true")
        elif token == "f":
            self.literal("false")
        elif token == "n":
            self.literal("null")
        else:
            raise ArchiveError(f"invalid JSON: unexpected token {token!r}")

    def string(self) -> None:
        self.expect('"')
        while True:
            char = self.take()
            if char == "":
                raise ArchiveError("invalid JSON: unterminated string")
            if char == '"':
                return
            if ord(char) < 0x20:
                raise ArchiveError("invalid JSON: unescaped control character")
            if char != "\\":
                continue
            escaped = self.take()
            if escaped in '"\\/bfnrt':
                continue
            if escaped != "u":
                raise ArchiveError(f"invalid JSON: bad escape \\{escaped}")
            for _ in range(4):
                digit = self.take()
                if digit not in "0123456789abcdefABCDEF" or digit == "":
                    raise ArchiveError("invalid JSON: bad unicode escape")

    def number(self) -> None:
        if self.peek() == "-":
            self.take()
        if self.peek() == "0":
            self.take()
            if self.peek() != "" and self.peek() in "0123456789":
                raise ArchiveError("invalid JSON: leading zero")
        elif self.peek() in "123456789" and self.peek() != "":
            while self.peek() != "" and self.peek() in "0123456789":
                self.take()
        else:
            raise ArchiveError("invalid JSON: malformed number")
        if self.peek() == ".":
            self.take()
            if self.peek() == "" or self.peek() not in "0123456789":
                raise ArchiveError("invalid JSON: missing fractional digits")
            while self.peek() != "" and self.peek() in "0123456789":
                self.take()
        if self.peek() in "eE" and self.peek() != "":
            self.take()
            if self.peek() in "+-" and self.peek() != "":
                self.take()
            if self.peek() == "" or self.peek() not in "0123456789":
                raise ArchiveError("invalid JSON: missing exponent digits")
            while self.peek() != "" and self.peek() in "0123456789":
                self.take()

    def literal(self, expected: str) -> None:
        for char in expected:
            self.expect(char)

    def array(self, depth: int) -> None:
        self.expect("[")
        self.whitespace()
        if self.peek() == "]":
            self.take()
            return
        while True:
            self.value(depth)
            self.whitespace()
            char = self.take()
            if char == "]":
                return
            if char != ",":
                raise ArchiveError(f"invalid JSON: expected ',' or ']', found {char!r}")

    def object(self, depth: int) -> None:
        self.expect("{")
        self.whitespace()
        if self.peek() == "}":
            self.take()
            return
        while True:
            self.whitespace()
            if self.peek() != '"':
                raise ArchiveError("invalid JSON: object key must be a string")
            self.string()
            self.whitespace()
            self.expect(":")
            self.value(depth)
            self.whitespace()
            char = self.take()
            if char == "}":
                return
            if char != ",":
                raise ArchiveError(f"invalid JSON: expected ',' or '}}', found {char!r}")

    def document(self) -> None:
        self.value()
        self.whitespace()
        if self.take() != "":
            raise ArchiveError("invalid JSON: trailing content")


def _validate_json_file(path: Path) -> None:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb", buffering=0) as raw:
            import io

            with io.TextIOWrapper(io.BufferedReader(raw, CHUNK_SIZE), encoding="utf-8", errors="strict") as text:
                _JsonStreamParser(text).document()
    except UnicodeDecodeError as exc:
        raise ArchiveError(f"invalid JSON UTF-8 in {path}: {exc}") from exc


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish_temp(temp: Path, destination: Path) -> None:
    if os.path.lexists(destination):
        raise FileExistsError(f"destination already exists: {destination}")
    try:
        os.link(temp, destination, follow_symlinks=False)
    except FileExistsError as exc:
        raise FileExistsError(f"destination already exists: {destination}") from exc
    temp_info = temp.lstat()
    destination_info = destination.lstat()
    if stat.S_ISLNK(destination_info.st_mode) or (temp_info.st_dev, temp_info.st_ino) != (
        destination_info.st_dev,
        destination_info.st_ino,
    ):
        raise ArchiveError(f"destination changed during publication: {destination}")
    temp.unlink()
    _fsync_directory(destination.parent)


def _capture_file(source: Path, destination: Path, *, line_bounded: bool, validate_json: bool) -> dict:
    source = Path(source)
    destination = Path(destination)
    if os.path.lexists(destination):
        raise FileExistsError(f"destination already exists: {destination}")
    if not destination.parent.exists():
        raise ArchiveError(f"destination parent does not exist: {destination.parent}")
    _assert_no_symlink_components(destination.parent)
    temp = destination.parent / f".{destination.name}.partial-{uuid.uuid4().hex}"
    source_handle: BinaryIO | None = None
    try:
        source_handle, before = _open_source(source)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temp, flags, 0o600)
        with os.fdopen(descriptor, "w+b", buffering=0) as destination_handle:
            first_hash, last_newline = _copy_exact(source_handle, destination_handle, before.st_size)
            destination_handle.flush()
            os.fsync(destination_handle.fileno())

            second_hash = _hash_exact(source_handle, before.st_size)
            after = os.fstat(source_handle.fileno())
            try:
                path_after = source.lstat()
            except FileNotFoundError as exc:
                raise ArchiveError(f"source was replaced or removed during capture: {source}") from exc
            if stat.S_ISLNK(path_after.st_mode) or (path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino):
                raise ArchiveError(f"source was replaced during capture: {source}")
            if after.st_size < before.st_size:
                raise ArchiveError(f"source was truncated during capture: {source}")
            if first_hash != second_hash:
                raise ArchiveError(f"source changed within the captured prefix: {source}")

            metadata_changed = (
                after.st_size != before.st_size
                or after.st_mtime_ns != before.st_mtime_ns
                or after.st_ctime_ns != before.st_ctime_ns
            )
            if not line_bounded and metadata_changed:
                raise ArchiveError(f"source changed during atomic capture: {source}")

            cutoff = last_newline if line_bounded else before.st_size
            if line_bounded:
                destination_handle.truncate(cutoff)
                destination_handle.flush()
                os.fsync(destination_handle.fileno())

        if validate_json:
            _validate_json_file(temp)
        captured_bytes = temp.stat().st_size
        expected_prefix_hash = _hash_exact(source_handle, captured_bytes)
        final = os.fstat(source_handle.fileno())
        try:
            path_final = source.lstat()
        except FileNotFoundError as exc:
            raise ArchiveError(f"source was replaced or removed during final verification: {source}") from exc
        if stat.S_ISLNK(path_final.st_mode) or (path_final.st_dev, path_final.st_ino) != (
            before.st_dev,
            before.st_ino,
        ):
            raise ArchiveError(f"source was replaced during final verification: {source}")
        if final.st_size < before.st_size:
            raise ArchiveError(f"source was truncated during final verification: {source}")
        final_metadata_changed = (
            final.st_size != before.st_size
            or final.st_mtime_ns != before.st_mtime_ns
            or final.st_ctime_ns != before.st_ctime_ns
        )
        if not line_bounded and final_metadata_changed:
            raise ArchiveError(f"source changed during final atomic verification: {source}")
        metadata_changed = metadata_changed or final_metadata_changed
        digest = sha256_file(temp)
        if digest != expected_prefix_hash:
            raise ArchiveError(f"copied bytes do not match verified source prefix: {source}")
        if captured_bytes != (last_newline if line_bounded else before.st_size):
            raise ArchiveError(f"captured size verification failed: {source}")
        _publish_temp(temp, destination)
        if destination.stat().st_size != captured_bytes or sha256_file(destination) != digest:
            raise ArchiveError(f"published archive verification failed: {destination}")

        source_changed = metadata_changed
        status = "complete"
        if line_bounded and (cutoff != before.st_size or source_changed):
            status = "complete_prefix"
        return {
            "source_relpath": source.as_posix(),
            "sha256": digest,
            "source_size_at_open": before.st_size,
            "captured_bytes": captured_bytes,
            "captured_at_utc": _utc_now(),
            "complete_line_cutoff": cutoff if line_bounded else None,
            "status": status,
            "source_changed": source_changed,
            "source_replaced": False,
        }
    finally:
        if source_handle is not None:
            source_handle.close()
        if os.path.lexists(temp):
            temp.unlink()


def capture_jsonl_prefix(source: Path, destination: Path) -> dict:
    """Capture a stable, complete-line prefix without reading the whole file into RAM."""
    return _capture_file(Path(source), Path(destination), line_bounded=True, validate_json=False)


def _walk_directory(directory: Path) -> Iterator[Path]:
    if not directory.exists() and not directory.is_symlink():
        return
    resolved = _assert_directory(directory, "allowlisted directory")
    stack = [directory]
    while stack:
        current = stack.pop()
        entries = sorted(os.scandir(current), key=lambda entry: entry.name, reverse=True)
        for entry in entries:
            entry_path = Path(entry.path)
            if entry.is_symlink():
                raise ArchiveError(f"symlink in allowlisted directory rejected: {entry_path}")
            if entry.is_dir(follow_symlinks=False):
                if not _is_relative_to(entry_path.resolve(strict=True), resolved):
                    raise ArchiveError(f"directory escaped allowlisted root: {entry_path}")
                stack.append(entry_path)
            elif entry.is_file(follow_symlinks=False):
                yield entry_path


def _add_source(specs: dict[str, SourceSpec], spec: SourceSpec) -> None:
    _validate_relative_path(spec.source_relpath, "source_relpath")
    _validate_relative_path(spec.archive_relpath, "archive_relpath")
    if spec.source_kind not in SOURCE_KINDS:
        raise ArchiveError(f"unknown source kind: {spec.source_kind}")
    if spec.archive_relpath in specs:
        raise ArchiveError(f"duplicate archive path: {spec.archive_relpath}")
    specs[spec.archive_relpath] = spec


def _source_spec(
    source_root: Path,
    path: Path,
    kind: str,
    *,
    line: bool = False,
    validate_json: bool = False,
    expected_sha256: str | None = None,
) -> SourceSpec:
    relative = path.relative_to(source_root).as_posix()
    return SourceSpec(
        path,
        relative,
        f"files/source/{relative}",
        kind,
        line,
        validate_json,
        expected_sha256,
    )


def _is_safe_generated_jsonl_name(name: str) -> bool:
    stem = name.removesuffix(".jsonl")
    return (
        name.endswith(".jsonl")
        and bool(stem)
        and all(char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for char in stem)
    )


def _is_lower_hex(value: str, length: int) -> bool:
    return len(value) == length and all(char in "0123456789abcdef" for char in value)


def _discover_sources(source_root: Path, extra_root: Path | None = None) -> list[SourceSpec]:
    source_root = _assert_directory(Path(source_root), "source root")
    specs: dict[str, SourceSpec] = {}

    trajectories = source_root / "logs" / "trajectories"
    for path in _walk_directory(trajectories):
        if path.suffix == ".jsonl":
            _add_source(specs, _source_spec(source_root, path, "trajectory_jsonl", line=True))

    trajectories_v2 = source_root / "logs" / "trajectories-v2"
    if trajectories_v2.exists() or trajectories_v2.is_symlink():
        _assert_directory(trajectories_v2, "versioned trajectories directory")
        for entry in sorted(os.scandir(trajectories_v2), key=lambda item: item.name):
            path = Path(entry.path)
            if entry.is_symlink():
                raise ArchiveError(f"symlink in versioned trajectories rejected: {path}")
            if entry.is_file(follow_symlinks=False) and _is_safe_generated_jsonl_name(entry.name):
                _add_source(specs, _source_spec(source_root, path, "trajectory_v2", line=True))

    episode_events = source_root / "logs" / "episode-events-v1"
    if episode_events.exists() or episode_events.is_symlink():
        _assert_directory(episode_events, "episode events directory")

        events = episode_events / "events"
        if events.exists() or events.is_symlink():
            _assert_directory(events, "episode event log directory")
            for entry in sorted(os.scandir(events), key=lambda item: item.name):
                path = Path(entry.path)
                if entry.is_symlink():
                    raise ArchiveError(f"symlink in episode event logs rejected: {path}")
                if entry.is_file(follow_symlinks=False) and _is_safe_generated_jsonl_name(entry.name):
                    _add_source(specs, _source_spec(source_root, path, "event_jsonl", line=True))

        payloads = episode_events / "payloads"
        if payloads.exists() or payloads.is_symlink():
            _assert_directory(payloads, "episode event payload directory")
            for prefix_entry in sorted(os.scandir(payloads), key=lambda item: item.name):
                prefix_path = Path(prefix_entry.path)
                if prefix_entry.is_symlink():
                    raise ArchiveError(f"symlink in episode event payloads rejected: {prefix_path}")
                if not prefix_entry.is_dir(follow_symlinks=False) or not _is_lower_hex(prefix_entry.name, 2):
                    continue
                for entry in sorted(os.scandir(prefix_path), key=lambda item: item.name):
                    path = Path(entry.path)
                    if entry.is_symlink():
                        raise ArchiveError(f"symlink in episode event payloads rejected: {path}")
                    name_hash = entry.name.removesuffix(".json")
                    if (
                        entry.is_file(follow_symlinks=False)
                        and entry.name.endswith(".json")
                        and _is_lower_hex(name_hash, 64)
                        and name_hash.startswith(prefix_entry.name)
                    ):
                        _add_source(
                            specs,
                            _source_spec(
                                source_root,
                                path,
                                "event_payload",
                                validate_json=True,
                                expected_sha256=name_hash,
                            ),
                        )

    sessions = source_root / "logs" / "sessions"
    for path in _walk_directory(sessions):
        if path.suffix == ".json":
            _add_source(specs, _source_spec(source_root, path, "session_json", validate_json=True))

    logs = source_root / "logs"
    if logs.exists() or logs.is_symlink():
        _assert_directory(logs, "logs directory")
        for entry in sorted(os.scandir(logs), key=lambda item: item.name):
            path = Path(entry.path)
            if entry.is_symlink():
                raise ArchiveError(f"symlink in allowlisted directory rejected: {path}")
            if not entry.is_file(follow_symlinks=False):
                continue
            if path.suffix == ".json":
                _add_source(specs, _source_spec(source_root, path, "runtime_log", validate_json=True))
            elif path.suffix == ".csv":
                _add_source(specs, _source_spec(source_root, path, "csv", line=True))
            elif path.suffix == ".log":
                _add_source(specs, _source_spec(source_root, path, "runtime_log", line=True))

        bot_runs = logs / "bot-runs"
        if bot_runs.exists() or bot_runs.is_symlink():
            _assert_directory(bot_runs, "bot run logs directory")
            for entry in sorted(os.scandir(bot_runs), key=lambda item: item.name):
                path = Path(entry.path)
                if entry.is_symlink():
                    raise ArchiveError(f"symlink in allowlisted directory rejected: {path}")
                if entry.is_file(follow_symlinks=False) and fnmatch.fnmatch(entry.name, "bot-run-*.log"):
                    _add_source(specs, _source_spec(source_root, path, "runtime_log", line=True))

    server_logs = source_root / "server" / "logs"
    for path in _walk_directory(server_logs):
        if path.suffix in {".log", ".txt"}:
            _add_source(specs, _source_spec(source_root, path, "server_log", line=True))
        elif path.suffix == ".gz":
            _add_source(specs, _source_spec(source_root, path, "server_log"))

    for relative_dir in (Path("skills/generated"), Path("skills/voyager")):
        for path in _walk_directory(source_root / relative_dir):
            _add_source(
                specs,
                _source_spec(source_root, path, "skill_artifact", validate_json=path.suffix == ".json"),
            )

    for entry in sorted(os.scandir(source_root), key=lambda item: item.name):
        if not fnmatch.fnmatch(entry.name, "memory*.json"):
            continue
        path = Path(entry.path)
        if entry.is_symlink():
            raise ArchiveError(f"symlink memory file rejected: {path}")
        if entry.is_file(follow_symlinks=False):
            _add_source(specs, _source_spec(source_root, path, "memory", validate_json=True))

    ops = source_root / "ops"
    if ops.exists() or ops.is_symlink():
        _assert_directory(ops, "operations directory")
        for name, kind, line, validate_json in (
            ("README.md", "ops_metadata", False, False),
            ("state.json", "ops_metadata", False, True),
            ("interventions.jsonl", "supervisor_jsonl", True, False),
        ):
            path = ops / name
            if not path.exists() and not path.is_symlink():
                continue
            _add_source(
                specs,
                _source_spec(source_root, path, kind, line=line, validate_json=validate_json),
            )

    backups = source_root / "backups"
    if backups.exists() or backups.is_symlink():
        _assert_directory(backups, "backups directory")
        for entry in sorted(os.scandir(backups), key=lambda item: item.name):
            if not (
                entry.name == "MANIFEST.tsv"
                or entry.name.endswith(".tar.zst")
                or entry.name.endswith(".sha256")
            ):
                continue
            path = Path(entry.path)
            if entry.is_symlink():
                raise ArchiveError(f"symlink world backup rejected: {path}")
            if entry.is_file(follow_symlinks=False):
                _add_source(specs, _source_spec(source_root, path, "world_backup"))

    finetune = source_root / "finetune"
    if finetune.exists() or finetune.is_symlink():
        _assert_directory(finetune, "finetune directory")
        for entry in sorted(os.scandir(finetune), key=lambda item: item.name):
            path = Path(entry.path)
            if entry.name in TRAINING_TOP_LEVEL:
                if entry.is_symlink():
                    raise ArchiveError(f"symlink training metadata rejected: {path}")
                if entry.is_file(follow_symlinks=False):
                    _add_source(
                        specs,
                        _source_spec(
                            source_root,
                            path,
                            "training_metadata",
                            line=entry.name in {"train.log", "dataset.jsonl"},
                        ),
                    )
            elif entry.is_dir(follow_symlinks=False) and entry.name != ".venv":
                for child in sorted(os.scandir(path), key=lambda item: item.name):
                    child_path = Path(child.path)
                    if child.name not in TRAINING_METADATA_NAMES:
                        continue
                    if child.is_symlink():
                        raise ArchiveError(f"symlink training metadata rejected: {child_path}")
                    if child.is_file(follow_symlinks=False):
                        _add_source(
                            specs,
                            _source_spec(source_root, child_path, "training_metadata", validate_json=child_path.suffix == ".json"),
                        )

    if extra_root is not None:
        extra = _assert_directory(Path(extra_root), "extra root")
        if _is_relative_to(extra, source_root) or _is_relative_to(source_root, extra):
            raise ArchiveError("source root and extra root overlap")
        for entry in sorted(os.scandir(extra), key=lambda item: item.name):
            if not fnmatch.fnmatch(entry.name, "bot-run-*.log"):
                continue
            path = Path(entry.path)
            if entry.is_symlink():
                raise ArchiveError(f"symlink extra log rejected: {path}")
            if entry.is_file(follow_symlinks=False):
                source_relative = f"@extra/{entry.name}"
                archive_relative = f"files/extra_tmp/{entry.name}"
                _add_source(
                    specs,
                    SourceSpec(path, source_relative, archive_relative, "extra_tmp_log", True, False),
                )

    return sorted(specs.values(), key=lambda spec: spec.source_relpath)


def _validate_relative_path(value: object, field: str) -> PurePosixPath:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or "\x00" in value
        or ":" in value
    ):
        raise ArchiveError(f"{field} must be a safe portable POSIX relative path")
    raw_parts = value.split("/")
    if value.startswith("/") or value.endswith("/") or any(
        part in {"", ".", ".."} for part in raw_parts
    ):
        raise ArchiveError(f"{field} contains absolute path or traversal: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute():
        raise ArchiveError(f"{field} contains absolute path or traversal: {value!r}")
    return path


def _manifest_record(spec: SourceSpec, captured: dict) -> dict:
    return {
        "source_relpath": spec.source_relpath,
        "archive_relpath": spec.archive_relpath,
        "sha256": captured["sha256"],
        "source_size_at_open": captured["source_size_at_open"],
        "captured_bytes": captured["captured_bytes"],
        "complete_line_cutoff": captured["complete_line_cutoff"],
        "status": captured["status"],
        "source_kind": spec.source_kind,
    }


def _write_exclusive(path: Path, data: bytes) -> None:
    if os.path.lexists(path):
        raise FileExistsError(f"destination already exists: {path}")
    temp = path.parent / f".{path.name}.partial-{uuid.uuid4().hex}"
    descriptor = None
    try:
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb", buffering=0) as handle:
            descriptor = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _publish_temp(temp, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.lexists(temp):
            temp.unlink()


def _capacity(output_parent: Path, specs: list[SourceSpec]) -> tuple[int, int]:
    required = sum(_lstat_regular(spec.path).st_size for spec in specs)
    available = shutil.disk_usage(output_parent).free
    return required, available


def archive_sources(source_root: Path, output_root: Path, extra_root: Path | None = None) -> dict:
    source_root = _assert_directory(Path(source_root), "source root")
    output_root = Path(output_root).absolute()
    output_parent = output_root.parent
    _assert_directory(output_parent, "output parent")
    _assert_no_symlink_components(output_parent)
    output_resolved = output_root.resolve(strict=False)
    if _is_relative_to(output_resolved, source_root) or _is_relative_to(source_root, output_resolved):
        raise ArchiveError("source and output paths overlap")
    if extra_root is not None:
        extra_resolved = _assert_directory(Path(extra_root), "extra root")
        if _is_relative_to(output_resolved, extra_resolved) or _is_relative_to(extra_resolved, output_resolved):
            raise ArchiveError("extra root and output paths overlap")
    if os.path.lexists(output_root):
        raise FileExistsError(f"output root already exists: {output_root}")

    specs = _discover_sources(source_root, extra_root)
    if not specs:
        raise ArchiveError("no allowlisted sources found")
    required, available = _capacity(output_parent, specs)
    if available < required:
        raise ArchiveError(f"insufficient free space: required={required} available={available}")

    output_root.mkdir(mode=0o700)
    try:
        records = []
        for spec in specs:
            destination = output_root / PurePosixPath(spec.archive_relpath)
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _assert_no_symlink_components(destination.parent, output_root)
            captured = _capture_file(
                spec.path,
                destination,
                line_bounded=spec.line_bounded,
                validate_json=spec.validate_json,
            )
            if spec.expected_sha256 is not None and captured["sha256"] != spec.expected_sha256:
                raise ArchiveError(f"event payload content hash does not match its filename: {spec.source_relpath}")
            records.append(_manifest_record(spec, captured))

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "captured_at_utc": _utc_now(),
            "source_root": str(source_root),
            "complete": True,
            "files": records,
        }
        encoded = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("utf-8")
        _write_exclusive(output_root / "manifest.json", encoded)
        _fsync_directory(output_root)
        return verify_manifest(output_root / "manifest.json")
    except Exception:
        if output_root.exists() and not output_root.is_symlink():
            shutil.rmtree(output_root)
        raise


def _read_manifest(path: Path) -> dict:
    if path.is_symlink():
        raise ArchiveError(f"manifest symlink rejected: {path}")
    info = _lstat_regular(path)
    if info.st_size > MAX_MANIFEST_BYTES:
        raise ArchiveError(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")

    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise ArchiveError(f"duplicate JSON key in manifest: {key!r}")
            value[key] = item
        return value

    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle, object_pairs_hook=reject_duplicates)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ArchiveError(f"invalid manifest JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ArchiveError("manifest must be a JSON object")
    return value


def verify_manifest(manifest_path: Path) -> dict:
    manifest_path = Path(manifest_path).absolute()
    _assert_no_symlink_components(manifest_path.parent)
    manifest = _read_manifest(manifest_path)
    if set(manifest) != TOP_LEVEL_FIELDS:
        raise ArchiveError(f"manifest fields must be exactly {sorted(TOP_LEVEL_FIELDS)}")
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != SCHEMA_VERSION:
        raise ArchiveError("manifest schema_version is not supported")
    if manifest["complete"] is not True:
        raise ArchiveError("manifest is not a complete supported archive")
    if not isinstance(manifest["captured_at_utc"], str) or not manifest["captured_at_utc"].endswith("Z"):
        raise ArchiveError("manifest captured_at_utc must be a UTC timestamp")
    if not isinstance(manifest["source_root"], str) or not Path(manifest["source_root"]).is_absolute():
        raise ArchiveError("manifest source_root must be absolute")
    if not isinstance(manifest["files"], list):
        raise ArchiveError("manifest files must be an array")

    archive_root = manifest_path.parent.resolve(strict=True)
    archive_paths: set[str] = set()
    source_paths: set[str] = set()
    for index, record in enumerate(manifest["files"]):
        if not isinstance(record, dict) or set(record) != FILE_FIELDS:
            raise ArchiveError(f"file record {index} has an invalid schema")
        source_relative = _validate_relative_path(record["source_relpath"], "source_relpath")
        archive_relative = _validate_relative_path(record["archive_relpath"], "archive_relpath")
        source_key = source_relative.as_posix()
        archive_key = archive_relative.as_posix()
        if source_key in source_paths or archive_key in archive_paths:
            raise ArchiveError(f"duplicate source or archive path in record {index}")
        source_paths.add(source_key)
        archive_paths.add(archive_key)
        if record["source_kind"] not in SOURCE_KINDS:
            raise ArchiveError(f"file record {index} has unknown source_kind")
        if record["status"] not in {"complete", "complete_prefix"}:
            raise ArchiveError(f"file record {index} has invalid status")
        for field in ("source_size_at_open", "captured_bytes"):
            if not isinstance(record[field], int) or isinstance(record[field], bool) or record[field] < 0:
                raise ArchiveError(f"file record {index} has invalid {field}")
        if record["captured_bytes"] > record["source_size_at_open"]:
            raise ArchiveError(f"file record {index} captured more than source size")
        if record["status"] == "complete" and record["captured_bytes"] != record["source_size_at_open"]:
            raise ArchiveError(f"file record {index} complete status omits source bytes")
        kind = record["source_kind"]
        line_kind = (
            kind
            in {
                "trajectory_jsonl",
                "trajectory_v2",
                "event_jsonl",
                "csv",
                "extra_tmp_log",
                "supervisor_jsonl",
            }
            or (kind == "runtime_log" and source_key.endswith(".log"))
            or (kind == "server_log" and source_key.endswith((".log", ".txt")))
            or (kind == "training_metadata" and source_key.endswith((".jsonl", ".log")))
        )
        cutoff = record["complete_line_cutoff"]
        if line_kind:
            if not isinstance(cutoff, int) or isinstance(cutoff, bool) or cutoff != record["captured_bytes"]:
                raise ArchiveError(f"file record {index} has invalid complete line cutoff")
        elif cutoff is not None:
            raise ArchiveError(f"file record {index} has unexpected complete line cutoff")
        if record["status"] == "complete_prefix" and not line_kind:
            raise ArchiveError(f"file record {index} uses prefix status for an atomic source")
        digest = record["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ArchiveError(f"file record {index} has invalid sha256")
        if kind == "event_payload":
            payload_parts = source_key.split("/")
            payload_hash = payload_parts[-1].removesuffix(".json")
            if (
                len(payload_parts) != 5
                or payload_parts[:3] != ["logs", "episode-events-v1", "payloads"]
                or not _is_lower_hex(payload_parts[3], 2)
                or not _is_lower_hex(payload_hash, 64)
                or payload_hash[:2] != payload_parts[3]
                or payload_parts[-1] != f"{payload_hash}.json"
                or digest != payload_hash
            ):
                raise ArchiveError(f"file record {index} has an invalid event payload hash path")

        archived = archive_root / Path(*archive_relative.parts)
        _assert_no_symlink_components(archived.parent, archive_root)
        try:
            archived_info = archived.lstat()
        except FileNotFoundError as exc:
            raise ArchiveError(f"archived file missing: {archive_key}") from exc
        if stat.S_ISLNK(archived_info.st_mode):
            raise ArchiveError(f"archived symlink rejected: {archive_key}")
        if not stat.S_ISREG(archived_info.st_mode):
            raise ArchiveError(f"archived path is not a regular file: {archive_key}")
        if archived_info.st_size != record["captured_bytes"]:
            raise ArchiveError(f"archived size mismatch: {archive_key}")
        if sha256_file(archived) != digest:
            raise ArchiveError(f"archived hash mismatch: {archive_key}")
        if line_kind and record["captured_bytes"] > 0:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(archived, flags), "rb", buffering=0) as handle:
                handle.seek(-1, os.SEEK_END)
                if handle.read(1) != b"\n":
                    raise ArchiveError(f"archived line cutoff does not end at a newline: {archive_key}")
        if source_key.endswith(".json"):
            _validate_json_file(archived)
    return manifest


def _inventory(source_root: Path, output: Path, extra_root: Path | None) -> dict:
    source_root = _assert_directory(Path(source_root), "source root")
    output = Path(output).absolute()
    output_resolved = output.resolve(strict=False)
    if _is_relative_to(output_resolved, source_root) or _is_relative_to(source_root, output_resolved):
        raise ArchiveError("source and inventory output paths overlap")
    if extra_root is not None:
        extra_resolved = _assert_directory(Path(extra_root), "extra root")
        if _is_relative_to(output_resolved, extra_resolved) or _is_relative_to(extra_resolved, output_resolved):
            raise ArchiveError("extra root and inventory output paths overlap")
    if os.path.lexists(output):
        raise FileExistsError(f"inventory output already exists: {output}")
    _assert_directory(output.parent, "inventory output parent")
    specs = _discover_sources(source_root, extra_root)
    required, available = _capacity(output.parent, specs)
    inventory = {
        "schema_version": SCHEMA_VERSION,
        "observed_at_utc": _utc_now(),
        "source_root": str(source_root),
        "required_bytes": required,
        "available_bytes": available,
        "sources": [
            {
                "source_relpath": spec.source_relpath,
                "source_kind": spec.source_kind,
                "source_size": _lstat_regular(spec.path).st_size,
            }
            for spec in specs
        ],
    }
    _write_exclusive(output, (json.dumps(inventory, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    return inventory


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser("inventory", help="write a read-only source and capacity inventory")
    inventory.add_argument("--source-root", type=Path, required=True)
    inventory.add_argument("--output", type=Path, required=True)
    inventory.add_argument("--extra-root", type=Path)
    capture = subparsers.add_parser("capture", help="create a new verified archive")
    capture.add_argument("--source-root", type=Path, required=True)
    capture.add_argument("--output-root", type=Path, required=True)
    capture.add_argument("--extra-root", type=Path)
    verify = subparsers.add_parser("verify", help="verify a finalized archive manifest")
    verify.add_argument("--manifest", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "inventory":
            result = _inventory(args.source_root, args.output, args.extra_root)
            print(f"required_bytes={result['required_bytes']} available_bytes={result['available_bytes']}")
            print(f"inventory={args.output} sources={len(result['sources'])}")
        elif args.command == "capture":
            specs = _discover_sources(args.source_root, args.extra_root)
            required, available = _capacity(Path(args.output_root).absolute().parent, specs)
            print(f"required_bytes={required} available_bytes={available}")
            if available < required:
                raise ArchiveError(f"insufficient free space: required={required} available={available}")
            result = archive_sources(args.source_root, args.output_root, args.extra_root)
            print(f"manifest={Path(args.output_root) / 'manifest.json'} files={len(result['files'])}")
        else:
            result = verify_manifest(args.manifest)
            print(f"verified={args.manifest} files={len(result['files'])}")
        return 0
    except (ArchiveError, FileExistsError, PermissionError, OSError) as exc:
        print(f"archive error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
