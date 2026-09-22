"""Trusted bounded-image ENOSPC injection with a fixed-size host receipt."""
import errno
import json
import math
import os
from pathlib import Path
import stat
import time


RECEIPT_BYTES = 4096
CHUNK_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 4 * 1024 ** 3
DEADLINE_SECONDS = 30


def _runtime_capacity(path):
    values = os.statvfs(path)
    return values.f_blocks * values.f_frsize


def _bounded_fuse_mount(path):
    target = str(Path(path))
    best = None
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        try:
            before, after = line.split(" - ", 1)
            fields, filesystem = before.split(), after.split()
            mountpoint = fields[4].replace("\\040", " ")
            if target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/"):
                if best is None or len(mountpoint) > len(best[0]):
                    best = (mountpoint, filesystem[0])
        except (IndexError, ValueError):
            continue
    return bool(best and best[1] == "fuse.ext4")


def _validate_receipt(runtime, receipt):
    runtime_info = Path(runtime).stat()
    path = Path(receipt)
    if path.is_symlink():
        raise ValueError("receipt may not be a symlink")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != RECEIPT_BYTES:
        raise ValueError("receipt must be a preexisting private 4096-byte regular file")
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("receipt must be private")
    if info.st_dev == runtime_info.st_dev:
        raise ValueError("receipt must be on a different filesystem")


def _write_receipt(path, value, runtime_dev=None):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(raw) > RECEIPT_BYTES:
        raise ValueError("receipt record too large")
    fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_size != RECEIPT_BYTES or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or (runtime_dev is not None and info.st_dev == runtime_dev)):
            raise ValueError("receipt changed before write")
        payload = raw + b" " * (RECEIPT_BYTES - len(raw))
        offset = 0
        while offset < len(payload):
            count = os.pwrite(fd, payload[offset:], offset)
            if count <= 0:
                raise OSError("short receipt write")
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)


def read_receipt(receipt_path):
    path = Path(receipt_path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size != RECEIPT_BYTES or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("invalid receipt")
        raw = os.read(fd, RECEIPT_BYTES + 1).rstrip(b" ")
        if len(raw) > RECEIPT_BYTES:
            raise ValueError("oversize receipt")
    finally:
        os.close(fd)
    try:
        value = json.loads(raw, object_pairs_hook=lambda pairs: _unique_object(pairs))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("invalid receipt JSON") from error
    if not isinstance(value, dict):
        raise ValueError("invalid receipt JSON")
    required = {"schema_version", "case", "stage", "status", "errno", "bytes_written", "started_monotonic", "finished_monotonic", "error"}
    if set(value) != required or value.get("schema_version") != 1 or value.get("case") != "disk_full" or value.get("stage") != "after_action_finished":
        raise ValueError("invalid receipt identity")
    if type(value.get("schema_version")) is not int or type(value["bytes_written"]) is not int or not 0 <= value["bytes_written"] <= MAX_IMAGE_BYTES:
        raise ValueError("invalid receipt byte count")
    for key in ("started_monotonic", "finished_monotonic"):
        if type(value[key]) not in (int, float) or not math.isfinite(value[key]):
            raise ValueError("invalid receipt timing")
    if value["finished_monotonic"] < value["started_monotonic"]:
        raise ValueError("invalid receipt timing order")
    if value["started_monotonic"] < 0:
        raise ValueError("invalid receipt timing")
    if value["status"] not in {"requested", "failed", "injected"}:
        raise ValueError("invalid receipt status")
    if value["status"] == "injected" and (type(value["errno"]) is not int or value["errno"] != errno.ENOSPC or value["bytes_written"] <= 0 or value["error"] is not None):
        raise ValueError("invalid injected receipt")
    if value["status"] == "requested" and (value["errno"] is not None or value["bytes_written"] != 0):
        raise ValueError("invalid requested receipt")
    if value["status"] == "requested" and value["error"] is not None:
        raise ValueError("invalid requested receipt")
    if value["status"] == "failed" and value["errno"] is not None and type(value["errno"]) is not int:
        raise ValueError("invalid failed receipt")
    return value


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def inject_disk_full(runtime: Path, receipt_path: Path):
    runtime = Path(runtime)
    if not runtime.is_dir() or not 0 < _runtime_capacity(runtime) <= MAX_IMAGE_BYTES or not _bounded_fuse_mount(runtime):
        raise ValueError("runtime must be on a bounded image filesystem")
    _validate_receipt(runtime, receipt_path)
    started = time.monotonic()
    requested = {"schema_version": 1, "case": "disk_full", "stage": "after_action_finished",
                 "status": "requested", "errno": None, "bytes_written": 0, "error": None,
                 "started_monotonic": started, "finished_monotonic": started}
    runtime_dev = runtime.stat().st_dev
    _write_receipt(receipt_path, requested, runtime_dev)
    fill = runtime / "storage-fault-fill.bin"
    written = 0
    outcome, error_number = "failed", None
    flush_error = None
    chunk_bytes = CHUNK_BYTES
    try:
        fd = os.open(fill, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        fd = None
        flush_error = "fill_open_failed"
        error_number = error.errno
    try:
        if fd is None:
            raise StopIteration
        while written < MAX_IMAGE_BYTES:
            now = time.monotonic()
            if now - started > DEADLINE_SECONDS:
                break
            try:
                count = os.write(fd, b"\0" * min(chunk_bytes, MAX_IMAGE_BYTES - written))
            except OSError as error:
                if error.errno == errno.ENOSPC:
                    # A large allocation failure may leave space for evidence-sized writes.
                    # Require a one-byte append to fail before declaring the fault injected.
                    if chunk_bytes > 1:
                        chunk_bytes = 4096 if chunk_bytes > 4096 else 1
                        continue
                    outcome, error_number = "injected", errno.ENOSPC
                else:
                    error_number = error.errno
                break
            if count <= 0:
                break
            written += count
    except StopIteration:
        pass
    finally:
        if fd is not None:
            try:
                os.fsync(fd)
            except OSError:
                outcome, error_number, flush_error = "failed", None, "fill_flush_failed"
            finally:
                os.close(fd)
    finished = time.monotonic()
    if finished - started > DEADLINE_SECONDS:
        outcome, error_number = "failed", None
    record = {"schema_version": 1, "case": "disk_full", "stage": "after_action_finished",
              "status": outcome, "errno": error_number, "bytes_written": written, "error": flush_error,
              "started_monotonic": started, "finished_monotonic": finished}
    _write_receipt(receipt_path, record, runtime_dev)
    return record
