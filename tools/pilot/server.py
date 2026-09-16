"""Owned process lifecycle and networkless sandbox command for pilot servers."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from typing import Any, Callable


LIFECYCLE_FILENAME = "server-lifecycle.json"
DEFAULT_LOG_LIMIT_BYTES = 1024 * 1024
MAX_LOG_LIMIT_BYTES = 16 * 1024 * 1024
MAX_TIMEOUT_SECONDS = 3600.0
MAX_STOP_GRACE_SECONDS = 60.0
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ProcessError(RuntimeError):
    """The owned process or sandbox contract is invalid."""


class _BoundedTail:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.value = bytearray()
        self.total = 0

    @property
    def truncated(self) -> bool:
        return self.total > self.limit

    def feed(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self.value.extend(chunk)
        if len(self.value) > self.limit:
            del self.value[: len(self.value) - self.limit]


@dataclass(frozen=True)
class ProcessResult:
    status: str
    returncode: int | None
    signal: int | None
    timed_out: bool
    stop_sent: bool
    term_sent: bool
    kill_sent: bool
    descendant_cleanup: bool
    cleanup_uncertain: bool
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    elapsed_seconds: float
    ready: bool = False

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["stdout"] = self.stdout.decode("utf-8", errors="replace")
        value["stderr"] = self.stderr.decode("utf-8", errors="replace")
        return value


def _positive_number(value: Any, label: str, *, allow_zero: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProcessError(f"{label} must be a finite number")
    if value < 0 or (value == 0 and not allow_zero):
        raise ProcessError(f"{label} must be {'non-negative' if allow_zero else 'positive'}")
    return float(value)


def _validate_process_inputs(
    argv: list[str], cwd: Path, env: dict[str, str], timeout_seconds: float,
    stop_grace_seconds: float, log_limit_bytes: int,
) -> None:
    if not isinstance(argv, list) or not argv or any(
        not isinstance(item, str) or not item or "\0" in item for item in argv
    ):
        raise ProcessError("argv must be a non-empty list of non-empty strings")
    if not Path(argv[0]).is_absolute():
        raise ProcessError("argv[0] must be an absolute executable path")
    if not cwd.is_absolute() or not cwd.is_dir():
        raise ProcessError("cwd must be an existing absolute directory")
    if not isinstance(env, dict) or any(
        not isinstance(key, str) or not key or "=" in key or "\0" in key
        or not isinstance(value, str) or "\0" in value
        for key, value in env.items()
    ):
        raise ProcessError("env must map valid string names to string values")
    _positive_number(timeout_seconds, "timeout_seconds")
    _positive_number(stop_grace_seconds, "stop_grace_seconds", allow_zero=True)
    if isinstance(log_limit_bytes, bool) or not isinstance(log_limit_bytes, int) or log_limit_bytes <= 0:
        raise ProcessError("log_limit_bytes must be a positive integer")
    if timeout_seconds > MAX_TIMEOUT_SECONDS:
        raise ProcessError(f"timeout_seconds may not exceed {MAX_TIMEOUT_SECONDS:g}")
    if stop_grace_seconds > MAX_STOP_GRACE_SECONDS:
        raise ProcessError(f"stop_grace_seconds may not exceed {MAX_STOP_GRACE_SECONDS:g}")
    if log_limit_bytes > MAX_LOG_LIMIT_BYTES:
        raise ProcessError(f"log_limit_bytes may not exceed {MAX_LOG_LIMIT_BYTES}")


def _group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        raise ProcessError(f"lost ownership of process group {pgid}") from exc


def _signal_group(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
        return True
    except ProcessLookupError:
        return False


def run_owned(
    argv: list[str], *, cwd: Path, env: dict[str, str], timeout_seconds: float,
    stop_grace_seconds: float, log_limit_bytes: int = DEFAULT_LOG_LIMIT_BYTES,
) -> ProcessResult:
    """Run one owned POSIX process group and clean every descendant on return."""
    cwd = Path(cwd)
    _validate_process_inputs(argv, cwd, env, timeout_seconds, stop_grace_seconds, log_limit_bytes)
    if os.name != "posix":
        raise ProcessError("owned process groups require a POSIX host")
    started = time.monotonic()
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=dict(env),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        close_fds=True,
        bufsize=0,
    )
    pgid = process.pid
    stdout_tail = _BoundedTail(log_limit_bytes)
    stderr_tail = _BoundedTail(log_limit_bytes)
    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    captures = {
        process.stdout.fileno(): stdout_tail,
        process.stderr.fileno(): stderr_tail,
    }
    for fd in captures:
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ)

    def drain(wait_seconds: float) -> None:
        for key, _ in selector.select(max(0.0, wait_seconds)):
            fd = key.fd
            for _ in range(4):
                try:
                    chunk = os.read(fd, 64 * 1024)
                except BlockingIOError:
                    break
                if not chunk:
                    try:
                        selector.unregister(fd)
                    except KeyError:
                        pass
                    break
                captures[fd].feed(chunk)

    def wait_for_process(seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            drain(min(0.02, remaining))
        drain(0)
        return True

    def wait_for_group(seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while _group_exists(pgid):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            drain(min(0.02, remaining))
        drain(0)
        return True
    timed_out = stop_sent = term_sent = kill_sent = descendant_cleanup = False
    cleanup_uncertain = True
    try:
        if not wait_for_process(timeout_seconds):
            timed_out = True
            if process.poll() is None and process.stdin is not None:
                try:
                    process.stdin.write(b"stop\n")
                    process.stdin.flush()
                    stop_sent = True
                except (BrokenPipeError, OSError):
                    pass
                finally:
                    process.stdin.close()
            wait_for_process(stop_grace_seconds)

        group_alive = _group_exists(pgid)
        if group_alive:
            descendant_cleanup = process.poll() is not None
            term_sent = _signal_group(pgid, signal.SIGTERM)
            wait_for_group(stop_grace_seconds)
        if _group_exists(pgid):
            kill_sent = _signal_group(pgid, signal.SIGKILL)
            wait_for_group(max(stop_grace_seconds, 0.1))
        if process.poll() is None:
            wait_for_process(max(stop_grace_seconds, 0.1))
    except BaseException:
        _signal_group(pgid, signal.SIGTERM)
        wait_for_group(stop_grace_seconds)
        if _group_exists(pgid):
            _signal_group(pgid, signal.SIGKILL)
        wait_for_process(max(stop_grace_seconds, 0.1))
        raise
    finally:
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        final_drain_deadline = time.monotonic() + 0.05
        while selector.get_map() and time.monotonic() < final_drain_deadline:
            drain(min(0.01, final_drain_deadline - time.monotonic()))
        try:
            cleanup_uncertain = _group_exists(pgid) or bool(selector.get_map())
        except ProcessError:
            cleanup_uncertain = True
        selector.close()
        process.stdout.close()
        process.stderr.close()
    if cleanup_uncertain:
        descendant_cleanup = False
    elapsed = time.monotonic() - started
    returncode = process.returncode
    return ProcessResult(
        status="timed_out" if timed_out else "exited",
        returncode=returncode,
        signal=-returncode if returncode is not None and returncode < 0 else None,
        timed_out=timed_out,
        stop_sent=stop_sent,
        term_sent=term_sent,
        kill_sent=kill_sent,
        descendant_cleanup=descendant_cleanup,
        cleanup_uncertain=cleanup_uncertain,
        stdout=bytes(stdout_tail.value),
        stderr=bytes(stderr_tail.value),
        stdout_truncated=stdout_tail.truncated,
        stderr_truncated=stderr_tail.truncated,
        elapsed_seconds=elapsed,
    )


def _build_sandbox_argv(
    runtime_dir: Path, *, bwrap_path: Path, command: list[str]
) -> list[str]:
    runtime = Path(runtime_dir).absolute()
    bwrap = Path(bwrap_path)
    if (
        not runtime.is_absolute()
        or not bwrap.is_absolute()
        or not command
        or not Path(command[0]).is_absolute()
    ):
        raise ProcessError("runtime, bwrap, and sandbox command paths must be absolute")
    argv = [
        str(bwrap), "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net",
        "--cap-drop", "ALL",
        "--clearenv", "--setenv", "HOME", str(runtime), "--setenv", "LANG", "C.UTF-8",
        "--ro-bind", "/usr", "/usr",
    ]
    for system_path in (Path("/lib"), Path("/lib64")):
        if system_path.exists():
            argv.extend(["--ro-bind", str(system_path), str(system_path)])
    argv.extend(["--dir", "/etc"])
    for java_config in [Path("/etc/alternatives"), *sorted(Path("/etc").glob("java-*"))]:
        if java_config.exists():
            argv.extend(["--ro-bind", str(java_config), str(java_config)])
    argv.extend([
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run",
        "--bind", str(runtime), str(runtime), "--chdir", str(runtime), "--", *command,
    ])
    return argv


def build_server_argv(
    runtime_dir: Path, *, java_path: Path = Path("/usr/bin/java"),
    bwrap_path: Path = Path("/usr/bin/bwrap"),
) -> list[str]:
    java = Path(java_path)
    if not java.is_absolute():
        raise ProcessError("Java path must be absolute")
    return _build_sandbox_argv(
        runtime_dir,
        bwrap_path=bwrap_path,
        command=[
            str(java), "-Xms1G", "-Xmx2G", "-Djava.awt.headless=true",
            "-jar", "server.jar", "--nogui",
        ],
    )


def _validate_executable(
    path: Path, label: str, *, expected_name: str, allowed_root: Path | None = None
) -> Path:
    if not path.is_absolute():
        raise ProcessError(f"{label} path must be absolute")
    try:
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except OSError as exc:
        raise ProcessError(f"{label} is unavailable: {path}") from exc
    if allowed_root is not None:
        try:
            resolved.relative_to(allowed_root)
        except ValueError as exc:
            raise ProcessError(f"{label} is outside vetted root {allowed_root}") from exc
    if (
        resolved.name != expected_name
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_mode & 0o022
        or not os.access(resolved, os.X_OK)
    ):
        raise ProcessError(
            f"{label} must resolve to a root-owned non-writable {expected_name} executable"
        )
    current = resolved.parent
    while True:
        parent_info = current.stat()
        if parent_info.st_uid != 0 or parent_info.st_mode & 0o022:
            raise ProcessError(f"{label} canonical parent chain is not root-owned and protected")
        if current == current.parent:
            break
        current = current.parent
    return resolved


def _reject_symlink_components(path: Path, label: str) -> None:
    if not path.is_absolute():
        raise ProcessError(f"{label} must be absolute")
    current = Path(path.parts[0])
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ProcessError(f"{label} path may not contain a symlink: {current}")


def _validate_lifecycle_limits(
    timeout_seconds: float, stop_grace_seconds: float, log_limit_bytes: int
) -> None:
    _validate_process_inputs(
        ["/validated/executable"],
        Path("/"),
        {},
        timeout_seconds,
        stop_grace_seconds,
        log_limit_bytes,
    )


def _write_json_exclusive(path: Path, value: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        raw = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def _replace_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    _write_json_exclusive(temporary, value)
    os.replace(temporary, path)


def run_server(
    runtime_dir: Path, *, manifest_sha256: str, timeout_seconds: float,
    stop_grace_seconds: float = 10.0, log_limit_bytes: int = DEFAULT_LOG_LIMIT_BYTES,
    java_path: Path = Path("/usr/bin/java"), bwrap_path: Path = Path("/usr/bin/bwrap"),
    verify_runtime: Callable[[Path, str], dict[str, Any]] | None = None,
    runner: Callable[..., ProcessResult] = run_owned,
    validate_executables: bool = True,
) -> ProcessResult:
    supplied_runtime = Path(runtime_dir)
    _reject_symlink_components(supplied_runtime, "runtime")
    _validate_lifecycle_limits(timeout_seconds, stop_grace_seconds, log_limit_bytes)
    runtime = supplied_runtime.resolve(strict=True)
    if not runtime.is_dir() or not _SHA256.fullmatch(manifest_sha256):
        raise ProcessError("runtime directory and manifest SHA-256 are required")
    lifecycle_path = runtime / LIFECYCLE_FILENAME
    if lifecycle_path.exists() or lifecycle_path.is_symlink():
        raise ProcessError(f"lifecycle output already exists: {lifecycle_path}")
    if verify_runtime is None:
        try:
            from tools.pilot.restore import verify_runtime as restore_verify_runtime
        except (ImportError, AttributeError) as exc:
            raise ProcessError("restore runtime verifier is unavailable") from exc
        verify_runtime = restore_verify_runtime
    try:
        manifest = verify_runtime(runtime, manifest_sha256)
    except Exception as exc:
        raise ProcessError(f"runtime verification failed: {exc}") from exc
    if manifest.get("kind") != "isolated_minecraft_runtime" or manifest.get("status") != "restored_not_started":
        raise ProcessError("runtime verification returned the wrong kind or status")
    file_paths = {
        item.get("path") for item in manifest.get("files", []) if isinstance(item, dict)
    }
    if not {"server.jar", "eula.txt", "server.properties"}.issubset(file_paths):
        raise ProcessError("verified runtime is missing required server files")
    java = Path(java_path)
    bwrap = Path(bwrap_path)
    if validate_executables:
        bwrap = _validate_executable(bwrap, "bwrap", expected_name="bwrap")
        java = _validate_executable(
            java, "Java", expected_name="java", allowed_root=Path("/usr/lib/jvm")
        )
    argv = build_server_argv(runtime, java_path=java, bwrap_path=bwrap)
    lifecycle_context = {
        "schema_version": 1,
        "manifest_sha256": manifest_sha256,
        "live_benchmark": False,
        "claim_limit": "Process launch only; no readiness or task success was established.",
    }
    _write_json_exclusive(lifecycle_path, {
        **lifecycle_context, "status": "launching", "ready": False,
        "cleanup_verified": False,
    })
    try:
        result = runner(
            argv,
            cwd=runtime,
            env={"PATH": "/usr/bin", "LANG": "C.UTF-8"},
            timeout_seconds=timeout_seconds,
            stop_grace_seconds=stop_grace_seconds,
            log_limit_bytes=log_limit_bytes,
        )
        result_data = result.to_dict()
        lifecycle = {
            **lifecycle_context,
            **result_data,
            "cleanup_verified": not result_data.get("cleanup_uncertain", True),
        }
        _replace_json(lifecycle_path, lifecycle)
        return result
    except BaseException as exc:
        _replace_json(lifecycle_path, {
            **lifecycle_context,
            "status": "launch_failed",
            "ready": False,
            "cleanup_verified": False,
            "error": f"{type(exc).__name__}: {exc}"[:1024],
        })
        raise


def _cli_exit_code(result: ProcessResult) -> int:
    if (
        result.returncode != 0
        or result.cleanup_uncertain
        or result.stdout_truncated
        or result.stderr_truncated
    ):
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch one verified pilot server sandbox.")
    parser.add_argument("--launch", action="store_true", required=True)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--java", required=True, type=Path)
    parser.add_argument("--bwrap", required=True, type=Path)
    parser.add_argument("--timeout", required=True, type=float)
    parser.add_argument("--stop-grace", type=float, default=10.0)
    parser.add_argument("--log-limit-bytes", type=int, default=DEFAULT_LOG_LIMIT_BYTES)
    args = parser.parse_args(argv)
    try:
        result = run_server(
            args.runtime,
            manifest_sha256=args.manifest_sha256,
            timeout_seconds=args.timeout,
            stop_grace_seconds=args.stop_grace,
            log_limit_bytes=args.log_limit_bytes,
            java_path=args.java,
            bwrap_path=args.bwrap,
        )
    except ProcessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"status": result.status, "ready": False}, sort_keys=True))
    return _cli_exit_code(result)


if __name__ == "__main__":
    raise SystemExit(main())
