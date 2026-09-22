"""Dedicated descriptor forwarding for a model-action channel."""
from __future__ import annotations

import fcntl
import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

CHILD_INPUT_FD = 3
CHILD_OUTPUT_FD = 4


def _pipe_mode(fd: int) -> int:
    try:
        mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
        if not stat.S_ISFIFO(os.fstat(fd).st_mode) or mode not in (os.O_RDONLY, os.O_WRONLY):
            raise ValueError
        return mode
    except (OSError, ValueError):
        raise ValueError("invalid action pipe descriptor") from None


def validate_action_descriptors(input_fd: int = CHILD_INPUT_FD, output_fd: int = CHILD_OUTPUT_FD) -> tuple[int, int]:
    """Require fixed binary FIFO endpoints: fd 3 reads requests; fd 4 writes replies."""
    if (type(input_fd) is not int or type(output_fd) is not int or input_fd == output_fd
            or input_fd < CHILD_INPUT_FD or output_fd < CHILD_INPUT_FD):
        raise ValueError("ambiguous action pipe endpoints")
    if (_pipe_mode(input_fd) != os.O_RDONLY or _pipe_mode(output_fd) != os.O_WRONLY
            or _same_pipe(input_fd, output_fd)):
        raise ValueError("action pipe direction mismatch")
    if any(_same_pipe(action, lifecycle) for action in (input_fd, output_fd) for lifecycle in (0, 1, 2)):
        raise ValueError("action pipe aliases lifecycle")
    return input_fd, output_fd


def _same_pipe(first: int, second: int) -> bool:
    first_stat, second_stat = os.fstat(first), os.fstat(second)
    return first_stat.st_dev == second_stat.st_dev and first_stat.st_ino == second_stat.st_ino


@dataclass
class ActionDescriptors:
    host_write: int | None
    host_read: int | None
    child_read: int | None
    child_write: int | None

    @classmethod
    def create(cls) -> "ActionDescriptors":
        child_read, host_write = os.pipe2(os.O_CLOEXEC)
        try:
            host_read, child_write = os.pipe2(os.O_CLOEXEC)
        except BaseException:
            os.close(child_read)
            os.close(host_write)
            raise
        return cls(host_write, host_read, child_read, child_write)

    def _close(self, attributes: tuple[str, ...]) -> None:
        for attribute in attributes:
            fd = getattr(self, attribute)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, attribute, None)

    def close_child(self) -> None:
        self._close(("child_read", "child_write"))

    def close_host(self) -> None:
        self._close(("host_write", "host_read"))


def _validated_child_fds(descriptors: ActionDescriptors) -> tuple[int, int]:
    read_fd, write_fd = descriptors.child_read, descriptors.child_write
    if (type(read_fd) is not int or type(write_fd) is not int or read_fd == write_fd
            or read_fd < CHILD_INPUT_FD or write_fd < CHILD_INPUT_FD or _same_pipe(read_fd, write_fd)):
        raise ValueError("ambiguous action pipe endpoints")
    if _pipe_mode(read_fd) != os.O_RDONLY or _pipe_mode(write_fd) != os.O_WRONLY:
        raise ValueError("action pipe direction mismatch")
    return read_fd, write_fd


def _validate_argv(argv: Sequence[str]) -> list[str]:
    if not argv or not all(type(part) is str and part for part in argv):
        raise ValueError("invalid target argv")
    return list(argv)


def spawn_action_sandbox(bwrap_argv: Sequence[str], descriptors: ActionDescriptors, **popen_kwargs: object) -> subprocess.Popen[bytes]:
    """Map two private pipes to 3/4 and pass only those descriptors through Bubblewrap."""
    if "close_fds" in popen_kwargs or "pass_fds" in popen_kwargs or "preexec_fn" in popen_kwargs:
        raise ValueError("unsafe spawn override")
    read_fd, write_fd = _validated_child_fds(descriptors)
    target = _validate_argv(bwrap_argv)
    adapter = [sys.executable, str(Path(__file__).resolve()), "--adapter", str(read_fd), str(write_fd), "--", *target]
    process = subprocess.Popen(adapter, close_fds=True, pass_fds=(read_fd, write_fd), **popen_kwargs)
    descriptors.close_child()
    return process


def _close_except(keep: set[int]) -> None:
    for name in os.listdir("/proc/self/fd"):
        try:
            fd = int(name)
        except ValueError:
            continue
        if fd not in keep:
            try:
                os.close(fd)
            except OSError:
                pass


def _adapter(argv: list[str]) -> int:
    if len(argv) < 5 or argv[0] != "--adapter" or argv[3] != "--":
        return 2
    try:
        read_fd, write_fd = int(argv[1]), int(argv[2])
        if (read_fd == write_fd or read_fd < CHILD_INPUT_FD or write_fd < CHILD_INPUT_FD
                or _same_pipe(read_fd, write_fd) or _pipe_mode(read_fd) != os.O_RDONLY
                or _pipe_mode(write_fd) != os.O_WRONLY):
            return 2
        _validate_argv(argv[4:])
        # Copies above fd 4 prevent a dup2 collision from reversing endpoints.
        read_copy = fcntl.fcntl(read_fd, fcntl.F_DUPFD, CHILD_OUTPUT_FD + 1)
        write_copy = fcntl.fcntl(write_fd, fcntl.F_DUPFD, CHILD_OUTPUT_FD + 1)
        try:
            os.dup2(read_copy, CHILD_INPUT_FD, inheritable=True)
            os.dup2(write_copy, CHILD_OUTPUT_FD, inheritable=True)
        finally:
            os.close(read_copy)
            os.close(write_copy)
        _close_except({0, 1, 2, CHILD_INPUT_FD, CHILD_OUTPUT_FD})
        os.execvpe(argv[4], argv[4:], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    except (OSError, ValueError):
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(_adapter(sys.argv[1:]))
