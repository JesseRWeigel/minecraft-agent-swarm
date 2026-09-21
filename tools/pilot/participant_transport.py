"""Bounded pipe transport for an already-launched protected participant.

This adapter does not launch or sandbox a process.  Its caller supplies a
``subprocess.Popen`` instance whose binary standard streams are pipes and owns
the process lifecycle and containment boundary.
"""

from __future__ import annotations

import io
import json
import math
import os
import selectors
import time
from collections.abc import Callable

from tools.pilot.participant_protocol import MAX_TOTAL_BYTES, ParticipantProtocol, ParticipantProtocolError


DEFAULT_MAX_STDERR_BYTES = 4096
DEFAULT_OVERALL_TIMEOUT_SECONDS = 90.0
MAX_COMMAND_BYTES = 512
_POLL_SECONDS = 0.05


class ParticipantTransportError(RuntimeError):
    """A sticky participant transport or lifecycle failure."""


class ParticipantTransport:
    """Coordinate one protocol over bounded, nonblocking process pipes."""

    def __init__(
        self,
        process,
        *,
        trial_id: str,
        action_id: str,
        overall_timeout: float = DEFAULT_OVERALL_TIMEOUT_SECONDS,
        max_stdout_bytes: int = MAX_TOTAL_BYTES,
        max_stderr_bytes: int = DEFAULT_MAX_STDERR_BYTES,
        now: Callable[[], float] = time.monotonic,
    ):
        streams = (getattr(process, name, None) for name in ("stdin", "stdout", "stderr"))
        stdin, stdout, stderr = streams
        if any(stream is None or isinstance(stream, io.TextIOBase) for stream in (stdin, stdout, stderr)):
            raise ValueError("process must have binary stdin, stdout, and stderr pipes")
        if not callable(getattr(process, "poll", None)) or not callable(getattr(process, "wait", None)):
            raise TypeError("process must provide poll and wait")
        if not callable(now):
            raise TypeError("now must be callable")
        try:
            timeout = float(overall_timeout)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("overall timeout must be finite and positive") from None
        if not math.isfinite(timeout) or not 0 < timeout <= DEFAULT_OVERALL_TIMEOUT_SECONDS:
            raise ValueError("overall timeout must be finite, positive, and at most 90 seconds")
        if type(max_stdout_bytes) is not int or not 1 <= max_stdout_bytes <= MAX_TOTAL_BYTES:
            raise ValueError("invalid stdout byte limit")
        if type(max_stderr_bytes) is not int or not 0 <= max_stderr_bytes <= DEFAULT_MAX_STDERR_BYTES:
            raise ValueError("invalid stderr byte limit")

        self.process = process
        self._stdin = stdin
        self._stdout = stdout
        self._stderr_stream = stderr
        self._now = now
        self._last_now = None
        self._failure_reason = None
        self._overall_deadline = self._sample_now() + timeout
        self._max_stdout_bytes = max_stdout_bytes
        self._max_stderr_bytes = max_stderr_bytes
        self._stdout_bytes = 0
        self._stderr = bytearray()
        self._accepted = []
        self._stdout_eof = False
        self._stderr_eof = False
        self._closed = False
        self._protocol = ParticipantProtocol(trial_id=trial_id, action_id=action_id, now=now)
        self._selector = selectors.DefaultSelector()
        original_modes = {stream.fileno(): os.get_blocking(stream.fileno()) for stream in (stdin, stdout, stderr)}
        try:
            for stream, label in ((stdout, "stdout"), (stderr, "stderr")):
                os.set_blocking(stream.fileno(), False)
                self._selector.register(stream, selectors.EVENT_READ, label)
            os.set_blocking(stdin.fileno(), False)
        except BaseException:
            self._selector.close()
            for descriptor, blocking in original_modes.items():
                try:
                    os.set_blocking(descriptor, blocking)
                except OSError:
                    pass
            raise

    @property
    def stderr(self) -> bytes:
        return bytes(self._stderr)

    @property
    def stdout_bytes(self) -> int:
        return self._stdout_bytes

    def _fail(self, reason: str):
        if self._failure_reason is None:
            self._failure_reason = reason
        raise ParticipantTransportError(self._failure_reason)

    def _ensure_active(self):
        if self._failure_reason is not None:
            raise ParticipantTransportError(self._failure_reason)
        if self._closed:
            raise ParticipantTransportError("participant transport is closed")

    def _sample_now(self) -> float:
        try:
            sample = float(self._now())
        except (TypeError, ValueError, OverflowError):
            self._fail("invalid supervisor monotonic clock")
        if not math.isfinite(sample) or (self._last_now is not None and sample < self._last_now):
            self._fail("invalid supervisor monotonic clock")
        self._last_now = sample
        return sample

    def _check_deadlines(self):
        self._ensure_active()
        if self._sample_now() >= self._overall_deadline:
            self._fail("participant overall deadline expired")
        try:
            self._protocol.check_deadline()
        except ParticipantProtocolError as error:
            self._fail(str(error))

    def _read_ready(self, stream, label):
        try:
            data = os.read(stream.fileno(), 65536)
        except BlockingIOError:
            return
        except OSError as error:
            self._fail(f"participant {label} pipe read failed")
        if not data:
            try:
                self._selector.unregister(stream)
            except KeyError:
                pass
            if label == "stdout":
                self._stdout_eof = True
                try:
                    self._protocol.eof()
                except ParticipantProtocolError as error:
                    self._fail(str(error))
            else:
                self._stderr_eof = True
            return
        if label == "stderr":
            remaining = self._max_stderr_bytes - len(self._stderr)
            self._stderr.extend(data[: max(0, remaining)])
            if len(data) > remaining:
                self._fail("participant stderr byte limit exceeded")
            return
        self._stdout_bytes += len(data)
        if self._stdout_bytes > self._max_stdout_bytes:
            self._fail("participant stdout byte limit exceeded")
        try:
            self._accepted.extend(self._protocol.feed(data))
        except ParticipantProtocolError as error:
            self._fail(str(error))

    def _pump_once(self, *, writable=None):
        self._check_deadlines()
        timeout = min(_POLL_SECONDS, max(0.0, self._overall_deadline - self._sample_now()))
        for key, mask in self._selector.select(timeout):
            if key.data == "stdin":
                if writable is not None:
                    writable[0] = True
            else:
                self._read_ready(key.fileobj, key.data)
        self._check_deadlines()

    def _wait_message(self, expected: str) -> str:
        self._ensure_active()
        while True:
            if self._accepted:
                self._check_deadlines()
                actual = self._accepted.pop(0)
                if actual != expected:
                    self._fail("unexpected accepted participant message")
                return actual
            self._pump_once()

    def wait_ready(self) -> str:
        return self._wait_message("ready")

    def wait_action_finished(self) -> str:
        return self._wait_message("action_finished")

    def _send(self, command):
        self._ensure_active()
        payload = (json.dumps(command, separators=(",", ":")) + "\n").encode("utf-8")
        if len(payload) > MAX_COMMAND_BYTES:
            self._fail("supervisor command exceeds byte limit")
        view = memoryview(payload)
        self._selector.register(self._stdin, selectors.EVENT_WRITE, "stdin")
        try:
            while view:
                writable = [False]
                self._pump_once(writable=writable)
                if not writable[0]:
                    continue
                try:
                    count = os.write(self._stdin.fileno(), view)
                except BlockingIOError:
                    continue
                except (BrokenPipeError, OSError):
                    self._fail("participant stdin pipe write failed")
                if count <= 0:
                    self._fail("participant stdin pipe write failed")
                view = view[count:]
            self._check_deadlines()
        finally:
            try:
                self._selector.unregister(self._stdin)
            except KeyError:
                pass

    def send_begin(self):
        self._check_deadlines()
        try:
            command = self._protocol.begin()
        except ParticipantProtocolError as error:
            self._fail(str(error))
        self._send(command)

    def send_finalize(self):
        self._check_deadlines()
        try:
            command = self._protocol.finalize()
        except ParticipantProtocolError as error:
            self._fail(str(error))
        self._send(command)
        self._stdin.close()

    def wait_exit(self):
        self._ensure_active()
        if self._protocol.state != "finalized":
            self._fail("participant exit wait before finalization")
        while self.process.poll() is None or not (self._stdout_eof and self._stderr_eof):
            self._pump_once()
        if self.process.returncode != 0:
            self._fail(f"participant exited with status {self.process.returncode}")
        self._check_deadlines()

    def close(self):
        """Close this adapter's pipe endpoints without terminating the process."""
        if self._closed:
            return
        self._closed = True
        self._selector.close()
        for stream in (self._stdin, self._stdout, self._stderr_stream):
            try:
                stream.close()
            except OSError:
                pass
