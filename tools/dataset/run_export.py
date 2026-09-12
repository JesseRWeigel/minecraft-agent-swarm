#!/usr/bin/env python3
"""Audit and export one bounded prospective telemetry run into manifest shards."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tempfile

from manifest import MAX_SHARD_BYTES, MAX_V2_ROOT_BYTES, ManifestReader, strict_decode, verify_manifest


CHUNK_SIZE = 1024 * 1024
MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024
SAFE_NAME_RE = re.compile(r"[A-Za-z0-9._-]+")
EVENT_KINDS = {
    "model_request",
    "model_response",
    "action_started",
    "action_finished",
    "observation",
    "episode_finished",
}


class ExportError(RuntimeError):
    """The requested run export cannot be completed safely."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def storage_capacity(path: Path) -> dict:
    usage = shutil.disk_usage(path)
    filesystem = os.statvfs(path)
    return {
        "total_bytes": usage.total,
        "free_bytes": usage.free,
        "total_inodes": filesystem.f_files,
        "free_inodes": filesystem.f_favail,
        "fragment_bytes": filesystem.f_frsize,
    }


def _regular(path: Path, label: str) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise ExportError(f"{label} does not exist: {path}") from error
    if stat.S_ISLNK(info.st_mode):
        raise ExportError(f"{label} may not be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ExportError(f"{label} is not a regular file: {path}")
    return info


def _directory(path: Path, label: str) -> Path:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise ExportError(f"{label} does not exist: {path}") from error
    if stat.S_ISLNK(info.st_mode):
        raise ExportError(f"{label} may not be a symlink: {path}")
    if not stat.S_ISDIR(info.st_mode):
        raise ExportError(f"{label} is not a directory: {path}")
    return path.resolve(strict=True)


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _hash_file(path: Path) -> tuple[str, int, os.stat_result]:
    _regular(path, "source")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(os.open(path, flags), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ExportError(f"source is not a regular file: {path}")
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
            size += len(chunk)
        after = os.fstat(handle.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ):
        raise ExportError(f"source changed while hashing: {path}")
    return digest.hexdigest(), size, after


def copy_regular(source: Path, destination: Path, expected: tuple[int, int, int, str]) -> tuple[str, int]:
    """Copy a proven regular file exclusively and reject source changes."""
    expected_size, expected_mtime, expected_inode, expected_hash = expected
    _regular(source, "source")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest = hashlib.sha256()
    size = 0
    try:
        output = destination.open("xb")
    except FileExistsError:
        raise
    try:
        with os.fdopen(os.open(source, flags), "rb") as handle, output:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ExportError(f"source is not a regular file: {source}")
            if (before.st_size, before.st_mtime_ns, before.st_ino) != (
                expected_size,
                expected_mtime,
                expected_inode,
            ):
                raise ExportError(f"source changed before copy: {source}")
            for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            output.flush()
            os.fsync(output.fileno())
            after = os.fstat(handle.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ino,
        ):
            raise ExportError(f"source changed while copying: {source}")
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise ExportError(f"source changed while copying: {source}")
        os.chmod(destination, 0o600)
        return digest.hexdigest(), size
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def _database(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.executescript(
        """
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE findings(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE event_ids(id TEXT PRIMARY KEY);
        CREATE TABLE payload_refs(hash TEXT PRIMARY KEY, ref_count INTEGER NOT NULL);
        CREATE TABLE evidence_refs(ref TEXT PRIMARY KEY, ref_count INTEGER NOT NULL);
        CREATE TABLE actions(id TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE requests(id TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE episodes(id TEXT PRIMARY KEY);
        CREATE TABLE payload_files(
            expected_hash TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_relpath TEXT NOT NULL,
            actual_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, inode INTEGER NOT NULL,
            referenced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE export_files(
            id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL, entry_json TEXT NOT NULL,
            size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, inode INTEGER NOT NULL, sha256 TEXT NOT NULL
        );
        """
    )
    return db


def _finding(db: sqlite3.Connection, kind: str, **detail) -> None:
    db.execute(
        "INSERT INTO findings(kind,detail) VALUES (?,?)",
        (kind, json.dumps(detail, sort_keys=True, separators=(",", ":"))),
    )


def _increment(db: sqlite3.Connection, table: str, identity: str, field: str) -> None:
    if table not in ("actions", "requests") or field not in ("starts", "finishes"):
        raise AssertionError("invalid counter")
    db.execute(f"INSERT INTO {table}(id,{field}) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET {field}={field}+1", (identity,))


def _event_schema_errors(event: dict) -> list[str]:
    errors = []
    if type(event.get("schemaVersion")) is not int or event.get("schemaVersion") != 1:
        errors.append("schemaVersion")
    for field in ("eventId", "runId", "episodeId", "botId", "occurredAt", "kind"):
        if not isinstance(event.get(field), str) or not event[field]:
            errors.append(field)
    if type(event.get("sequence")) is not int or event.get("sequence", 0) < 1:
        errors.append("sequence")
    monotonic = event.get("monotonicMs")
    if type(monotonic) not in (int, float) or not math.isfinite(monotonic) or monotonic < 0:
        errors.append("monotonicMs")
    for field in ("actionId", "requestId"):
        value = event.get(field)
        if value is not None and (not isinstance(value, str) or not value):
            errors.append(field)
    kind = event.get("kind")
    if kind not in EVENT_KINDS:
        errors.append("kind")
    if kind in ("action_started", "action_finished") and not isinstance(event.get("actionId"), str):
        errors.append("actionId_required")
    if kind in ("model_request", "model_response") and not isinstance(event.get("requestId"), str):
        errors.append("requestId_required")
    occurred = event.get("occurredAt")
    if isinstance(occurred, str):
        try:
            timestamp = dt.datetime.fromisoformat(occurred.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                errors.append("occurredAt_timezone")
        except ValueError:
            errors.append("occurredAt_format")
    return errors


def _extract_evidence_refs(value) -> tuple[list[str], list[str]]:
    found: list[str] = []
    schema_errors: list[str] = []
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            for key, item in current.items():
                if key == "evidenceRefs":
                    if not isinstance(item, list):
                        schema_errors.append("evidenceRefs_not_array")
                    else:
                        for reference in item:
                            if isinstance(reference, str):
                                found.append(reference)
                            else:
                                schema_errors.append("evidenceRefs_item_not_string")
                else:
                    pending.append(item)
        elif isinstance(current, list):
            pending.extend(current)
    return found, schema_errors


def _audit_events(db: sqlite3.Connection, event_file: Path, run_id: str) -> tuple[int, int, tuple[int, int, int, str]]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest = hashlib.sha256()
    event_count = 0
    complete_line_cutoff = 0
    offset = 0
    with os.fdopen(os.open(event_file, flags), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ExportError("event source is not a regular file")
        while True:
            line = handle.readline(MAX_EVENT_LINE_BYTES + 1)
            if not line:
                break
            digest.update(line)
            offset += len(line)
            if len(line) > MAX_EVENT_LINE_BYTES:
                _finding(db, "oversized_event_line", offset=offset)
                while not line.endswith(b"\n"):
                    line = handle.readline(CHUNK_SIZE)
                    if not line:
                        break
                    digest.update(line)
                    offset += len(line)
                if line.endswith(b"\n"):
                    complete_line_cutoff = offset
                continue
            if not line.endswith(b"\n"):
                _finding(db, "incomplete_event_tail", offset=offset - len(line), bytes=len(line))
                break
            complete_line_cutoff = offset
            try:
                event = strict_decode(line)
            except ValueError as error:
                _finding(db, "malformed_event", offset=offset - len(line), error=str(error))
                continue
            if not isinstance(event, dict):
                _finding(db, "invalid_event_schema", offset=offset - len(line))
                continue
            schema_errors = _event_schema_errors(event)
            if schema_errors:
                _finding(
                    db,
                    "invalid_event_schema",
                    offset=offset - len(line),
                    fields=sorted(set(schema_errors)),
                )
                continue
            if event.get("runId") != run_id:
                _finding(db, "event_outside_run", event_id=event.get("eventId"), observed_run_id=event.get("runId"))
                continue
            expected_episode_id = f"{run_id}:{event['botId']}"
            if event["episodeId"] != expected_episode_id:
                _finding(
                    db,
                    "invalid_episode_linkage",
                    event_id=event["eventId"],
                    expected_episode_id=expected_episode_id,
                )
                continue
            event_count += 1
            event_id = event.get("eventId")
            if not isinstance(event_id, str) or not event_id:
                _finding(db, "invalid_event_id", sequence=event.get("sequence"))
            else:
                try:
                    db.execute("INSERT INTO event_ids VALUES (?)", (event_id,))
                except sqlite3.IntegrityError:
                    _finding(db, "duplicate_event_id", event_id=event_id)
            episode_id = event.get("episodeId")
            if isinstance(episode_id, str) and episode_id:
                db.execute("INSERT OR IGNORE INTO episodes VALUES (?)", (episode_id,))
            else:
                _finding(db, "invalid_episode_id", event_id=event_id)
            payload_ref = event.get("payloadRef")
            if isinstance(payload_ref, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", payload_ref):
                payload_hash = payload_ref[7:]
                db.execute(
                    "INSERT INTO payload_refs VALUES (?,1) ON CONFLICT(hash) DO UPDATE SET ref_count=ref_count+1",
                    (payload_hash,),
                )
            elif isinstance(payload_ref, str) and payload_ref.startswith("unavailable:"):
                _finding(db, "unavailable_payload_reference", event_id=event_id, reference=payload_ref)
            else:
                _finding(db, "invalid_payload_reference", event_id=event_id)
            action_id = event.get("actionId")
            if isinstance(action_id, str) and action_id:
                if event.get("kind") == "action_started":
                    _increment(db, "actions", action_id, "starts")
                elif event.get("kind") == "action_finished":
                    _increment(db, "actions", action_id, "finishes")
            request_id = event.get("requestId")
            if isinstance(request_id, str) and request_id:
                if event.get("kind") == "model_request":
                    _increment(db, "requests", request_id, "starts")
                elif event.get("kind") == "model_response":
                    _increment(db, "requests", request_id, "finishes")
        after = os.fstat(handle.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ):
        raise ExportError("event source changed while auditing")
    return event_count, complete_line_cutoff, (after.st_size, after.st_mtime_ns, after.st_ino, digest.hexdigest())


def _walk_payloads(db: sqlite3.Connection, payload_root: Path) -> None:
    with os.scandir(payload_root) as prefixes:
        for prefix_item in prefixes:
            prefix = Path(prefix_item.path)
            if prefix_item.is_symlink():
                raise ExportError(f"payload symlink is not allowed: {prefix}")
            if not prefix_item.is_dir(follow_symlinks=False) or not re.fullmatch(r"[a-f0-9]{2}", prefix_item.name):
                _finding(db, "unexpected_payload_path", source_relpath=f"payloads/{prefix_item.name}")
                continue
            with os.scandir(prefix) as payloads:
                for payload_item in payloads:
                    payload = Path(payload_item.path)
                    if payload_item.is_symlink():
                        raise ExportError(f"payload symlink is not allowed: {payload}")
                    if not payload_item.is_file(follow_symlinks=False) or not re.fullmatch(
                        r"[a-f0-9]{64}\.json", payload_item.name
                    ):
                        _finding(
                            db,
                            "unexpected_payload_path",
                            source_relpath=f"payloads/{prefix_item.name}/{payload_item.name}",
                        )
                        continue
                    expected = payload.stem
                    if expected[:2] != prefix_item.name:
                        _finding(
                            db,
                            "unexpected_payload_path",
                            source_relpath=f"payloads/{prefix_item.name}/{payload_item.name}",
                        )
                        continue
                    actual, size, info = _hash_file(payload)
                    db.execute(
                        "INSERT INTO payload_files VALUES (?,?,?,?,?,?,?,0)",
                        (
                            expected,
                            str(payload),
                            f"payloads/{prefix_item.name}/{payload_item.name}",
                            actual,
                            size,
                            info.st_mtime_ns,
                            info.st_ino,
                        ),
                    )


def _audit_relationships(db: sqlite3.Connection) -> None:
    for identity, starts, finishes in db.execute("SELECT id,starts,finishes FROM actions ORDER BY id"):
        if starts == 0:
            _finding(db, "unmatched_action_terminal", action_id=identity, terminals=finishes)
        if finishes == 0:
            _finding(db, "unmatched_action_start", action_id=identity, starts=starts)
        if starts > 1:
            _finding(db, "duplicate_action_start", action_id=identity, count=starts)
        if finishes > 1:
            _finding(db, "duplicate_action_terminal", action_id=identity, count=finishes)
    for identity, starts, finishes in db.execute("SELECT id,starts,finishes FROM requests ORDER BY id"):
        if starts == 0:
            _finding(db, "unmatched_model_response", request_id=identity, responses=finishes)
        if finishes == 0:
            _finding(db, "unmatched_model_request", request_id=identity, requests=starts)
        if starts > 1:
            _finding(db, "duplicate_model_request", request_id=identity, count=starts)
        if finishes > 1:
            _finding(db, "duplicate_model_response", request_id=identity, count=finishes)


def _read_payload_evidence(db: sqlite3.Connection, path: Path, expected_hash: str) -> None:
    info = path.stat()
    if info.st_size > MAX_EVENT_LINE_BYTES:
        _finding(db, "payload_json_unreadable", reference=f"sha256:{expected_hash}", reason="oversized")
        return
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        with os.fdopen(os.open(path, flags), "rb") as handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError("payload is not a regular file")
            data = handle.read(MAX_EVENT_LINE_BYTES + 1)
            after = os.fstat(handle.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ino,
        ):
            raise ValueError("payload changed while reading")
        if len(data) > MAX_EVENT_LINE_BYTES:
            raise ValueError("payload grew beyond the read bound")
        value = strict_decode(data)
    except ValueError as error:
        _finding(db, "payload_json_unreadable", reference=f"sha256:{expected_hash}", reason=str(error))
        return
    found, schema_errors = _extract_evidence_refs(value)
    for reason in schema_errors:
        _finding(
            db,
            "invalid_evidence_reference_schema",
            reference=f"sha256:{expected_hash}",
            reason=reason,
        )
    for reference in found:
        db.execute(
            "INSERT INTO evidence_refs VALUES (?,1) ON CONFLICT(ref) DO UPDATE SET ref_count=ref_count+1",
            (reference,),
        )


def _resolve_payloads(db: sqlite3.Connection) -> tuple[int, int]:
    referenced = 0
    copied = 0
    reference_cursor = db.execute("SELECT hash FROM payload_refs ORDER BY hash")
    for (expected_hash,) in reference_cursor:
        referenced += 1
        row = db.execute(
            "SELECT source_path,source_relpath,actual_hash,size,mtime_ns,inode FROM payload_files WHERE expected_hash=?",
            (expected_hash,),
        ).fetchone()
        if row is None:
            _finding(db, "missing_payload", reference=f"sha256:{expected_hash}")
            continue
        source_path, source_relpath, actual_hash, size, mtime_ns, inode = row
        db.execute("UPDATE payload_files SET referenced=1 WHERE expected_hash=?", (expected_hash,))
        if actual_hash != expected_hash:
            _finding(
                db,
                "corrupt_payload",
                reference=f"sha256:{expected_hash}",
                actual_sha256=actual_hash,
                source_relpath=source_relpath,
            )
        _read_payload_evidence(db, Path(source_path), expected_hash)
        entry = {
            "source_relpath": source_relpath,
            "archive_relpath": f"files/{source_relpath}",
            "sha256": actual_hash,
            "source_size_at_open": size,
            "captured_bytes": size,
            "complete_line_cutoff": None,
            "status": "complete",
            "source_kind": "event_payload",
        }
        if actual_hash != expected_hash:
            entry["expected_sha256"] = expected_hash
        db.execute(
            "INSERT INTO export_files(source_path,entry_json,size,mtime_ns,inode,sha256) VALUES (?,?,?,?,?,?)",
            (source_path, json.dumps(entry, sort_keys=True, separators=(",", ":")), size, mtime_ns, inode, actual_hash),
        )
        copied += 1
    for source_relpath, actual_hash, size in db.execute(
        "SELECT source_relpath,actual_hash,size FROM payload_files WHERE referenced=0 ORDER BY source_relpath"
    ):
        _finding(db, "unused_payload", source_relpath=source_relpath, sha256=actual_hash, bytes=size)
    for reference, count in db.execute("SELECT ref,ref_count FROM evidence_refs ORDER BY ref"):
        if reference.startswith("unavailable:"):
            _finding(db, "unavailable_evidence_reference", reference=reference, count=count)
        elif re.fullmatch(r"sha256:[a-f0-9]{64}", reference):
            known = db.execute("SELECT 1 FROM payload_refs WHERE hash=?", (reference[7:],)).fetchone()
            if known is None:
                _finding(db, "evidence_reference_outside_run", reference=reference, count=count)
        else:
            _finding(db, "invalid_evidence_reference", reference=reference, count=count)
    return referenced, copied


def _write_audit(db: sqlite3.Connection, path: Path) -> tuple[str, int, dict]:
    counts = collections.Counter()
    digest = hashlib.sha256()
    size = 0
    with path.open("xb") as handle:
        for finding_id, kind, detail in db.execute("SELECT id,kind,detail FROM findings ORDER BY id"):
            counts[kind] += 1
            line = json.dumps(
                {"finding_id": finding_id, "kind": kind, "detail": json.loads(detail)},
                sort_keys=True,
                separators=(",", ":"),
            ).encode() + b"\n"
            handle.write(line)
            digest.update(line)
            size += len(line)
        handle.flush()
        os.fsync(handle.fileno())
    return digest.hexdigest(), size, dict(sorted(counts.items()))


def _add_event_and_audit_entries(
    db: sqlite3.Connection,
    event_file: Path,
    event_state: tuple[int, int, int, str],
    complete_line_cutoff: int,
    audit_file: Path,
    audit_hash: str,
    audit_size: int,
) -> None:
    size, mtime_ns, inode, event_hash = event_state
    event_entry = {
        "source_relpath": f"events/{event_file.name}",
        "archive_relpath": f"files/events/{event_file.name}",
        "sha256": event_hash,
        "source_size_at_open": size,
        "captured_bytes": size,
        "complete_line_cutoff": complete_line_cutoff,
        "status": "complete",
        "source_kind": "event_jsonl",
    }
    db.execute(
        "INSERT INTO export_files(source_path,entry_json,size,mtime_ns,inode,sha256) VALUES (?,?,?,?,?,?)",
        (str(event_file), json.dumps(event_entry, sort_keys=True, separators=(",", ":")), size, mtime_ns, inode, event_hash),
    )
    audit_info = audit_file.stat()
    audit_entry = {
        "source_relpath": "audit/findings.jsonl",
        "archive_relpath": "audit/findings.jsonl",
        "sha256": audit_hash,
        "source_size_at_open": audit_size,
        "captured_bytes": audit_size,
        "complete_line_cutoff": audit_size,
        "status": "complete",
        "source_kind": "export_audit",
        "transformation_version": "run-export-audit-v1",
    }
    db.execute(
        "INSERT INTO export_files(source_path,entry_json,size,mtime_ns,inode,sha256) VALUES (?,?,?,?,?,?)",
        (
            str(audit_file),
            json.dumps(audit_entry, sort_keys=True, separators=(",", ":")),
            audit_size,
            audit_info.st_mtime_ns,
            audit_info.st_ino,
            audit_hash,
        ),
    )


def _write_shards(db: sqlite3.Connection, root: Path, max_shard_bytes: int) -> list[dict]:
    if not 512 <= max_shard_bytes <= MAX_SHARD_BYTES:
        raise ExportError(f"manifest shard limit must be 512..{MAX_SHARD_BYTES} bytes")
    shards = []
    shard_handle = None
    shard_path = None
    digest = None
    size = count = captured = 0
    descriptor_bytes = 0

    def finish():
        nonlocal shard_handle, shard_path, digest, size, count, captured, descriptor_bytes
        if shard_handle is None:
            return
        shard_handle.flush()
        os.fsync(shard_handle.fileno())
        shard_handle.close()
        shard = {
            "archive_relpath": f"manifests/{shard_path.name}",
            "sha256": digest.hexdigest(),
            "bytes": size,
            "file_count": count,
            "captured_bytes": captured,
            "scratch_path": str(shard_path),
        }
        public = {key: value for key, value in shard.items() if key != "scratch_path"}
        descriptor_bytes += len(json.dumps(public, sort_keys=True, separators=(",", ":")).encode()) + 1
        if descriptor_bytes > MAX_V2_ROOT_BYTES * 3 // 4:
            raise ExportError("manifest shard descriptors would exceed the bounded root budget")
        shards.append(shard)
        shard_handle = None

    for entry_json, entry_size in db.execute("SELECT entry_json,size FROM export_files ORDER BY id"):
        line = entry_json.encode() + b"\n"
        if len(line) > max_shard_bytes:
            raise ExportError("one manifest record exceeds the configured shard limit")
        if shard_handle is not None and size + len(line) > max_shard_bytes:
            finish()
        if shard_handle is None:
            shard_path = root / f"manifest-{len(shards) + 1:06d}.jsonl"
            shard_handle = shard_path.open("xb")
            digest = hashlib.sha256()
            size = count = captured = 0
        shard_handle.write(line)
        digest.update(line)
        size += len(line)
        count += 1
        captured += entry_size
    finish()
    return shards


def _manifest_document(
    *, run_id: str, scope: str, closure_kind: str, closure_reference: str, asserted_by: str,
    event_file: Path, payload_root: Path, audit: dict, storage: dict, totals: dict, shards: list[dict]
) -> dict:
    public_shards = [{key: value for key, value in shard.items() if key != "scratch_path"} for shard in shards]
    return {
        "schema_version": 2,
        "manifest_kind": "run_export",
        "created_at_utc": utc_now(),
        "run_id": run_id,
        "scope": scope,
        "run_closed": scope == "closed_run",
        "censored": scope == "observed_prefix",
        "closure": {"kind": closure_kind, "reference": closure_reference, "asserted_by": asserted_by},
        "source": {"event_file": str(event_file), "payload_root": str(payload_root)},
        "copy_complete": True,
        "episode_complete": False,
        "episode_completion_basis": "not_independently_verified",
        "audit": audit,
        "storage": storage,
        "totals": totals,
        "shards": public_shards,
    }


def _validate_options(scope: str, closure_kind: str, closure_reference: str, asserted_by: str) -> None:
    if scope not in ("closed_run", "observed_prefix"):
        raise ExportError("scope must be closed_run or observed_prefix")
    if closure_kind not in ("offline_snapshot", "operator_assertion"):
        raise ExportError("closure kind must be offline_snapshot or operator_assertion")
    if not closure_reference.strip() or not asserted_by.strip():
        raise ExportError("closure provenance requires a reference and asserted_by")


def export_run(
    *, event_file: Path | str, payload_root: Path | str, output_root: Path | str, run_id: str,
    scope: str, closure_kind: str, closure_reference: str, asserted_by: str,
    max_shard_bytes: int = 8 * 1024 * 1024, reserve_bytes: int = 0, reserve_inodes: int = 0,
) -> dict:
    _validate_options(scope, closure_kind, closure_reference, asserted_by)
    if not isinstance(run_id, str) or not run_id:
        raise ExportError("run ID is required")
    if reserve_bytes < 0 or reserve_inodes < 0:
        raise ExportError("capacity reserves must be nonnegative")
    event_file = Path(event_file).absolute()
    payload_root = _directory(Path(payload_root).absolute(), "payload root")
    _regular(event_file, "event file")
    if not SAFE_NAME_RE.fullmatch(event_file.name):
        raise ExportError("event filename must use portable ASCII characters")
    output_root = Path(output_root).absolute()
    if output_root.exists() or output_root.is_symlink():
        raise FileExistsError(output_root)
    output_parent = _directory(output_root.parent, "output parent")
    common_source = Path(os.path.commonpath((event_file, payload_root)))
    meaningful_common_root = common_source != Path(common_source.anchor)
    if (
        _inside(output_root, payload_root)
        or _inside(output_root, event_file.parent)
        or (meaningful_common_root and _inside(output_root, common_source))
    ):
        raise ExportError("output path overlaps source data")

    with tempfile.TemporaryDirectory(prefix=".run-export-plan-", dir=output_parent) as temporary:
        temporary_root = Path(temporary)
        db = _database(temporary_root / "audit.sqlite")
        try:
            event_count, cutoff, event_state = _audit_events(db, event_file, run_id)
            _walk_payloads(db, payload_root)
            _audit_relationships(db)
            referenced, copied_payloads = _resolve_payloads(db)
            db.commit()
            audit_path = temporary_root / "findings.jsonl"
            audit_hash, audit_size, by_kind = _write_audit(db, audit_path)
            _add_event_and_audit_entries(db, event_file, event_state, cutoff, audit_path, audit_hash, audit_size)
            db.commit()
            shard_scratch = temporary_root / "shards"
            shard_scratch.mkdir()
            shards = _write_shards(db, shard_scratch, max_shard_bytes)
            files, captured_bytes = db.execute("SELECT count(*),coalesce(sum(size),0) FROM export_files").fetchone()
            finding_count = db.execute("SELECT count(*) FROM findings").fetchone()[0]
            episode_count = db.execute("SELECT count(*) FROM episodes").fetchone()[0]
            totals = {
                "files": files,
                "captured_bytes": captured_bytes,
                "shards": len(shards),
                "events": event_count,
                "episodes": episode_count,
                "referenced_payloads": referenced,
                "copied_payloads": copied_payloads,
                "audit_findings": finding_count,
            }
            capacity = storage_capacity(output_parent)
            fragment_bytes = max(512, capacity.get("fragment_bytes", 4096))
            allocated_files = sum(
                max(fragment_bytes, ((size + fragment_bytes - 1) // fragment_bytes) * fragment_bytes)
                for (size,) in db.execute("SELECT size FROM export_files")
            )
            allocated_shards = sum(
                max(fragment_bytes, ((shard["bytes"] + fragment_bytes - 1) // fragment_bytes) * fragment_bytes)
                for shard in shards
            )
            directory_overhead = (min(files, 256) + len(shards) + 4) * fragment_bytes
            required_bytes = (
                allocated_files
                + allocated_shards
                + max(fragment_bytes, MAX_V2_ROOT_BYTES)
                + directory_overhead
            )
            required_inodes = files * 3 + len(shards) + 8
            storage = {
                **capacity,
                "required_bytes_preflight": required_bytes,
                "required_inodes_preflight": required_inodes,
                "reserve_bytes": reserve_bytes,
                "reserve_inodes": reserve_inodes,
            }
            audit = {"findings": finding_count, "by_kind": by_kind}
            document = _manifest_document(
                run_id=run_id, scope=scope, closure_kind=closure_kind,
                closure_reference=closure_reference, asserted_by=asserted_by,
                event_file=event_file, payload_root=payload_root, audit=audit,
                storage=storage, totals=totals, shards=shards,
            )
            root_bytes = json.dumps(document, sort_keys=True, separators=(",", ":")).encode() + b"\n"
            if len(root_bytes) > MAX_V2_ROOT_BYTES:
                raise ExportError("root manifest would exceed its bounded size")
            if capacity["free_bytes"] < required_bytes + reserve_bytes or capacity["free_inodes"] < required_inodes + reserve_inodes:
                raise ExportError("insufficient destination capacity for run export")

            output_root.mkdir(mode=0o700)
            try:
                for source_path, entry_json, size, mtime_ns, inode, sha256 in db.execute(
                    "SELECT source_path,entry_json,size,mtime_ns,inode,sha256 FROM export_files ORDER BY id"
                ):
                    entry = json.loads(entry_json)
                    copy_regular(Path(source_path), output_root / entry["archive_relpath"], (size, mtime_ns, inode, sha256))
                manifest_dir = output_root / "manifests"
                manifest_dir.mkdir(mode=0o700)
                for shard in shards:
                    scratch = Path(shard["scratch_path"])
                    shard_info = scratch.stat()
                    copy_regular(
                        scratch,
                        output_root / shard["archive_relpath"],
                        (shard_info.st_size, shard_info.st_mtime_ns, shard_info.st_ino, shard["sha256"]),
                    )
                # Detect mutation after any individual copy completed.
                for source_path, size, mtime_ns, inode, sha256 in db.execute(
                    "SELECT source_path,size,mtime_ns,inode,sha256 FROM export_files ORDER BY id"
                ):
                    actual_hash, actual_size, info = _hash_file(Path(source_path))
                    if (actual_size, info.st_mtime_ns, info.st_ino, actual_hash) != (size, mtime_ns, inode, sha256):
                        raise ExportError(f"source changed during export: {source_path}")
                manifest_path = output_root / "manifest.json"
                with manifest_path.open("xb") as handle:
                    handle.write(root_bytes)
                    handle.flush()
                    os.fsync(handle.fileno())
                verify_manifest(manifest_path)
            except Exception:
                shutil.rmtree(output_root)
                raise
            return document
        finally:
            db.close()


def storage_report(
    manifest_path: Path | str,
    *, previous_manifest: Path | str | None = None,
    warn_free_bytes: int = 0,
    warn_free_inodes: int = 0,
) -> dict:
    verified = verify_manifest(manifest_path)
    current_reader = ManifestReader(manifest_path)
    if current_reader.schema_version != 2:
        raise ExportError("storage reports require a version-2 run export")
    capacity = storage_capacity(current_reader.root)
    totals = current_reader.document["totals"]
    report = {
        "run_id": current_reader.document["run_id"],
        "scope": current_reader.document["scope"],
        "totals": totals,
        "capacity": capacity,
        "verified": verified,
        "warnings": [],
        "growth": None,
    }
    if previous_manifest is not None:
        verify_manifest(previous_manifest)
        previous = ManifestReader(previous_manifest)
        if previous.schema_version != 2:
            raise ExportError("previous storage report must be a version-2 run export")
        if previous.document["run_id"] != current_reader.document["run_id"]:
            raise ExportError("storage growth requires exports from the same run ID")
        old = previous.document["totals"]
        report["growth"] = {
            key: totals.get(key, 0) - old.get(key, 0)
            for key in ("files", "captured_bytes", "events", "referenced_payloads", "copied_payloads")
        }
    if capacity["free_bytes"] < warn_free_bytes:
        report["warnings"].append("free_bytes_below_threshold")
    if capacity["free_inodes"] < warn_free_inodes:
        report["warnings"].append("free_inodes_below_threshold")
    return report


def _stress(
    output_root: Path,
    payload_count: int,
    max_shard_bytes: int,
    reserve_bytes: int,
    reserve_inodes: int,
) -> dict:
    if not 1 <= payload_count <= 1_000_000:
        raise ExportError("payload count must be 1..1000000")
    output_root = output_root.absolute()
    output_root.parent.mkdir(parents=True, exist_ok=True)
    capacity = storage_capacity(output_root.parent)
    per_record_bytes = max(64 * 1024, capacity["fragment_bytes"] * 12)
    estimated_bytes = payload_count * per_record_bytes + 16 * 1024 * 1024
    estimated_inodes = payload_count * 5 + 1024
    if (
        capacity["free_bytes"] < estimated_bytes + reserve_bytes
        or capacity["free_inodes"] < estimated_inodes + reserve_inodes
    ):
        raise ExportError("insufficient destination capacity for synthetic stress source and export")
    with tempfile.TemporaryDirectory(prefix=".run-export-stress-source-", dir=output_root.parent) as temporary:
        source = Path(temporary)
        payload_root = source / "payloads"
        event_file = source / "events" / "stress.jsonl"
        event_file.parent.mkdir()
        payload_root.mkdir()
        with event_file.open("xb") as events:
            for number in range(payload_count):
                payload = json.dumps({"n": number}, separators=(",", ":")).encode() + b"\n"
                payload_hash = hashlib.sha256(payload).hexdigest()
                payload_path = payload_root / payload_hash[:2] / f"{payload_hash}.json"
                payload_path.parent.mkdir(parents=True, exist_ok=True)
                payload_path.write_bytes(payload)
                event = {
                    "schemaVersion": 1,
                    "eventId": f"event-{number}",
                    "runId": "synthetic-stress-run",
                    "episodeId": "synthetic-stress-run:bot",
                    "botId": "bot",
                    "sequence": number + 1,
                    "actionId": None,
                    "requestId": None,
                    "occurredAt": "2026-09-12T00:00:00.000Z",
                    "monotonicMs": number,
                    "kind": "observation",
                    "payloadRef": f"sha256:{payload_hash}",
                }
                events.write(json.dumps(event, separators=(",", ":")).encode() + b"\n")
        return export_run(
            event_file=event_file,
            payload_root=payload_root,
            output_root=output_root,
            run_id="synthetic-stress-run",
            scope="closed_run",
            closure_kind="offline_snapshot",
            closure_reference="synthetic-stress-fixture",
            asserted_by="run_export.py",
            max_shard_bytes=max_shard_bytes,
            reserve_bytes=reserve_bytes,
            reserve_inodes=reserve_inodes,
        )


def _add_export_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--event-file", type=Path, required=True)
    parser.add_argument("--payload-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--scope", choices=("closed_run", "observed_prefix"), required=True)
    parser.add_argument("--closure-kind", choices=("offline_snapshot", "operator_assertion"), required=True)
    parser.add_argument("--closure-reference", required=True)
    parser.add_argument("--asserted-by", required=True)
    parser.add_argument("--max-shard-bytes", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--reserve-bytes", type=int, default=0)
    parser.add_argument("--reserve-inodes", type=int, default=0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="export one inactive run or immutable observed prefix")
    _add_export_arguments(export)
    verify = commands.add_parser("verify", help="verify a v1 or v2 archive")
    verify.add_argument("--manifest", type=Path, required=True)
    report = commands.add_parser("report", help="read storage and growth without modifying archives")
    report.add_argument("--manifest", type=Path, required=True)
    report.add_argument("--previous-manifest", type=Path)
    report.add_argument("--warn-free-bytes", type=int, default=0)
    report.add_argument("--warn-free-inodes", type=int, default=0)
    stress = commands.add_parser("stress", help="create and export a synthetic sharding fixture")
    stress.add_argument("--output-root", type=Path, required=True)
    stress.add_argument("--payload-count", type=int, default=100_000)
    stress.add_argument("--max-shard-bytes", type=int, default=8 * 1024 * 1024)
    stress.add_argument("--reserve-bytes", type=int, default=0)
    stress.add_argument("--reserve-inodes", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            result = export_run(
                event_file=args.event_file,
                payload_root=args.payload_root,
                output_root=args.output_root,
                run_id=args.run_id,
                scope=args.scope,
                closure_kind=args.closure_kind,
                closure_reference=args.closure_reference,
                asserted_by=args.asserted_by,
                max_shard_bytes=args.max_shard_bytes,
                reserve_bytes=args.reserve_bytes,
                reserve_inodes=args.reserve_inodes,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
        elif args.command == "verify":
            print(json.dumps(verify_manifest(args.manifest), indent=2, sort_keys=True))
        elif args.command == "report":
            print(json.dumps(storage_report(
                args.manifest,
                previous_manifest=args.previous_manifest,
                warn_free_bytes=args.warn_free_bytes,
                warn_free_inodes=args.warn_free_inodes,
            ), indent=2, sort_keys=True))
        else:
            result = _stress(
                args.output_root,
                args.payload_count,
                args.max_shard_bytes,
                args.reserve_bytes,
                args.reserve_inodes,
            )
            print(json.dumps({
                "files": result["totals"]["files"],
                "payloads": result["totals"]["copied_payloads"],
                "shards": result["totals"]["shards"],
            }, sort_keys=True))
        return 0
    except (ExportError, FileExistsError, ValueError, OSError) as error:
        print(f"run export failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
