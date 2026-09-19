"""Strict participant coordination protocol for a future protected supervisor.

This module parses an incremental byte stream of newline-terminated JSON objects.
The participant may send exactly two messages, in order::

    {"schema_version": 1, "type": "ready", ...fixed IDs...}
    {"schema_version": 1, "type": "action_finished", ...fixed IDs...}

After ``ready``, the trusted supervisor must call :meth:`begin` and send its
returned ``begin`` command to the participant.  After ``action_finished``, it
must call :meth:`finalize` and send its returned ``finalize`` command.
Participant messages cannot
state success, provide observations, select IDs, advance supervisor phases, or
set deadlines.  The supervisor supplies the IDs and an injectable monotonic
clock.  Any protocol error is sticky: later input and supervisor calls fail
without changing the original reason.

This is only a parser/state-machine prerequisite.  It does not launch a process,
provide containment, or establish a protected observer boundary.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable


SCHEMA_VERSION = 1
MAX_LINE_BYTES = 512
MAX_TOTAL_BYTES = 4096
READY_TIMEOUT_SECONDS = 10.0
ACTION_TIMEOUT_SECONDS = 30.0
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_KEYS = {"schema_version", "type", "trial_id", "action_id"}


class ParticipantProtocolError(ValueError):
    """A sticky participant protocol or supervisor phase error."""


def _valid_token(value: object) -> bool:
    return isinstance(value, str) and _TOKEN.fullmatch(value) is not None


def _reject_constant(value: str):
    raise ValueError(f"invalid JSON constant: {value}")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class ParticipantProtocol:
    """Incrementally validate one fixed participant coordination stream.

    ``feed`` returns a tuple containing each accepted participant message type.
    ``begin`` and ``finalize`` are explicit trusted-supervisor transitions that
    return the exact command dictionary for the supervisor to serialize and
    send to the participant.
    Call ``check_deadline`` while idle and ``eof`` when the participant pipe
    closes.  EOF is valid only after supervisor finalization and with no partial
    line buffered.
    """

    def __init__(self, *, trial_id: str, action_id: str, now: Callable[[], float] = time.monotonic):
        if not _valid_token(trial_id) or not _valid_token(action_id):
            raise ValueError("invalid supervisor ID")
        if not callable(now):
            raise TypeError("now must be callable")
        self.trial_id = trial_id
        self.action_id = action_id
        self._now = now
        self._buffer = bytearray()
        self._total_bytes = 0
        self._state = "awaiting_ready"
        self._failure_reason: str | None = None
        self._last_now: float | None = None
        self._deadline = self._sample_now() + READY_TIMEOUT_SECONDS

    @property
    def state(self) -> str:
        return "failed" if self._failure_reason is not None else self._state

    @property
    def failure_reason(self) -> str | None:
        return self._failure_reason

    def _fail(self, reason: str):
        if self._failure_reason is None:
            self._failure_reason = reason
        raise ParticipantProtocolError(self._failure_reason)

    def _ensure_active(self):
        if self._failure_reason is not None:
            raise ParticipantProtocolError(self._failure_reason)

    def _sample_now(self) -> float:
        try:
            sample = float(self._now())
        except (TypeError, ValueError, OverflowError):
            self._fail("invalid supervisor monotonic clock")
        if not math.isfinite(sample) or (self._last_now is not None and sample < self._last_now):
            self._fail("invalid supervisor monotonic clock")
        self._last_now = sample
        return sample

    def check_deadline(self):
        """Fail when the current supervisor-owned phase deadline has expired."""
        self._ensure_active()
        if self._state in {"awaiting_ready", "action_active"} and self._sample_now() >= self._deadline:
            self._fail("participant phase deadline expired")

    def feed(self, data: bytes) -> tuple[str, ...]:
        """Consume a stream chunk and return accepted message types."""
        self._ensure_active()
        if self._state == "finalized":
            self._fail("input after finalization")
        if not isinstance(data, bytes):
            self._fail("participant input must be bytes")
        self.check_deadline()
        self._total_bytes += len(data)
        if self._total_bytes > MAX_TOTAL_BYTES:
            self._fail("participant stream exceeds byte limit")
        self._buffer.extend(data)
        accepted = []
        while True:
            newline = self._buffer.find(b"\n")
            if newline < 0:
                if len(self._buffer) > MAX_LINE_BYTES:
                    self._fail("participant line exceeds byte limit")
                break
            if newline > MAX_LINE_BYTES:
                self._fail("participant line exceeds byte limit")
            raw = bytes(self._buffer[:newline])
            del self._buffer[: newline + 1]
            accepted.append(self._message(raw))
        return tuple(accepted)

    def _message(self, raw: bytes) -> str:
        self.check_deadline()
        if not raw:
            self._fail("empty participant line")
        try:
            text = raw.decode("utf-8", errors="strict")
            value = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        except (UnicodeError, json.JSONDecodeError, ValueError):
            self._fail("invalid participant JSON")
        if not isinstance(value, dict) or set(value) != _KEYS:
            self._fail("invalid participant message fields")
        if type(value["schema_version"]) is not int or value["schema_version"] != SCHEMA_VERSION:
            self._fail("invalid participant schema")
        if value["trial_id"] != self.trial_id or value["action_id"] != self.action_id:
            self._fail("participant ID mismatch")
        message_type = value["type"]
        if not isinstance(message_type, str):
            self._fail("invalid participant message type")
        expected = "ready" if self._state == "awaiting_ready" else "action_finished" if self._state == "action_active" else None
        if message_type != expected:
            self._fail("duplicate or out-of-phase participant message")
        self._state = "ready" if message_type == "ready" else "awaiting_finalize"
        return message_type

    def begin(self):
        """Enter the action phase and return its fixed supervisor command."""
        self._ensure_active()
        if self._state != "ready":
            self._fail("supervisor begin out of phase")
        if self._buffer:
            self._fail("participant bytes buffered before supervisor begin")
        self._state = "action_active"
        self._deadline = self._sample_now() + ACTION_TIMEOUT_SECONDS
        return {
            "schema_version": SCHEMA_VERSION,
            "type": "begin",
            "trial_id": self.trial_id,
            "action_id": self.action_id,
        }

    def finalize(self):
        """Enter final state and return its fixed supervisor command."""
        self._ensure_active()
        if self._state != "awaiting_finalize":
            self._fail("supervisor finalize out of phase")
        if self._buffer:
            self._fail("participant bytes buffered before supervisor finalize")
        self._state = "finalized"
        return {
            "schema_version": SCHEMA_VERSION,
            "type": "finalize",
            "trial_id": self.trial_id,
            "action_id": self.action_id,
        }

    def eof(self):
        """Validate clean EOF after supervisor finalization."""
        self._ensure_active()
        if self._buffer:
            self._fail("participant EOF with unterminated line")
        if self._state != "finalized":
            self._fail("participant EOF before finalization")
