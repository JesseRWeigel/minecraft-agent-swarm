"""Bounded host-side transport for a scripted model action channel."""
from __future__ import annotations

import json
import math
import os
import selectors
import time
from typing import Any, Sequence

from tools.pilot.action_descriptors import ActionDescriptors

MAX_ACTIONS = 25
MAX_REQUEST_BYTES = 4096
MAX_REPLY_BYTES = 20480
MAX_TIMEOUT_SECONDS = 20
TRIAL_ID = "collect-oak-log-v1"
ACTION_ID = "collect-01"


def _invalid_constant(_value: str) -> None:
    raise ValueError


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _finite_json(value: Any) -> bool:
    if type(value) is float:
        return math.isfinite(value)
    if type(value) is list:
        return all(_finite_json(item) for item in value)
    if type(value) is dict:
        return all(type(key) is str and _finite_json(item) for key, item in value.items())
    return value is None or type(value) in (bool, int, str)


def _decode_reply(raw: bytes, sequence: int, expect_finished: bool, expect_observation: bool) -> dict[str, Any]:
    if not raw or len(raw) >= MAX_REPLY_BYTES:
        raise ValueError
    try:
        reply = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates, parse_constant=_invalid_constant)
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise ValueError from None
    keys = {"schema_version", "sequence", "status"} | ({"observation"} if expect_observation else set())
    if not _finite_json(reply) or type(reply) is not dict or set(reply) != keys:
        raise ValueError
    if type(reply["schema_version"]) is not int or reply["schema_version"] != 1 or type(reply["sequence"]) is not int or reply["sequence"] != sequence:
        raise ValueError
    if reply["status"] not in {"completed", "finished"} or (reply["status"] == "finished") != expect_finished:
        raise ValueError
    if expect_observation:
        observation = reply["observation"]
        if type(observation) is not dict or observation.get("source") != "participant_bot":
            raise ValueError
    return reply


def _request(action: Any, sequence: int) -> bytes:
    value = {"schema_version": 1, "trial_id": TRIAL_ID, "action_id": ACTION_ID, "sequence": sequence, "action": action}
    try:
        raw = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise ValueError from None
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ValueError
    return raw + b"\n"


def _deadline(timeout: float) -> float:
    if type(timeout) not in (int, float) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
        raise ValueError("invalid action coordinator timeout")
    return time.monotonic() + float(timeout)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError
    return remaining


def _wait(selector: selectors.BaseSelector, deadline: float) -> list[tuple[selectors.SelectorKey, int]]:
    ready = selector.select(_remaining(deadline))
    if not ready:
        raise TimeoutError
    _remaining(deadline)
    return ready


def _write_all(fd: int, raw: bytes, deadline: float) -> None:
    selector = selectors.DefaultSelector()
    try:
        selector.register(fd, selectors.EVENT_WRITE)
        offset = 0
        while offset < len(raw):
            _wait(selector, deadline)
            try:
                written = os.write(fd, raw[offset:])
            except BlockingIOError:
                continue
            if written <= 0:
                raise OSError
            offset += written
    finally:
        selector.close()


def _read_line(fd: int, deadline: float) -> bytes:
    selector = selectors.DefaultSelector()
    buffer = bytearray()
    try:
        selector.register(fd, selectors.EVENT_READ)
        while True:
            _wait(selector, deadline)
            try:
                chunk = os.read(fd, min(4096, MAX_REPLY_BYTES - len(buffer)))
            except BlockingIOError:
                continue
            if not chunk:
                raise EOFError
            buffer.extend(chunk)
            newline = buffer.find(b"\n")
            if newline >= 0:
                if newline != len(buffer) - 1 or newline >= MAX_REPLY_BYTES:
                    raise ValueError
                return bytes(buffer[:newline])
            if len(buffer) >= MAX_REPLY_BYTES:
                raise ValueError
    finally:
        selector.close()


def _failed(descriptors: ActionDescriptors, records: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        descriptors.close_host()
    except Exception:
        pass
    return {"schema_version": 1, "status": "failed", "records": records, "error": "action coordinator failed"}


def run_action_script(descriptors: ActionDescriptors, actions: Sequence[Any], timeout: float = MAX_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Send a fixed-id script serially; this records transport evidence and never scores it."""
    records: list[dict[str, Any]] = []
    try:
        deadline = _deadline(timeout)
        if not isinstance(descriptors, ActionDescriptors) or type(actions) not in (list, tuple) or not 1 <= len(actions) <= MAX_ACTIONS:
            raise ValueError
        if any(type(action) is not dict for action in actions):
            raise ValueError
        if descriptors.host_write is None or descriptors.host_read is None:
            raise ValueError
        if type(actions[-1]) is not dict or actions[-1] != {"kind": "finish"}:
            raise ValueError
        if any(type(action) is dict and action.get("kind") == "finish" for action in actions[:-1]):
            raise ValueError
        os.set_blocking(descriptors.host_write, False)
        os.set_blocking(descriptors.host_read, False)
        for sequence, action in enumerate(actions, start=1):
            request = _request(action, sequence)
            started = time.monotonic()
            record = {"request": json.loads(request), "reply": None, "started_monotonic": started, "finished_monotonic": None}
            records.append(record)
            _write_all(descriptors.host_write, request, deadline)
            if sequence == len(actions):
                os.close(descriptors.host_write)
                descriptors.host_write = None
            reply = _decode_reply(_read_line(descriptors.host_read, deadline), sequence, sequence == len(actions), action.get("kind") == "observe")
            _remaining(deadline)
            record["reply"] = reply
            record["finished_monotonic"] = time.monotonic()
        return {"schema_version": 1, "status": "finished", "records": records, "error": None}
    except (OSError, ValueError, EOFError, TimeoutError, TypeError, RecursionError):
        return _failed(descriptors, records)


def audit_action_eof(descriptors: ActionDescriptors, timeout: float = 2) -> dict[str, str]:
    """After participant exit, require EOF on the reply channel and reject any trailing bytes."""
    try:
        if type(timeout) not in (int, float) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0 or timeout > 2:
            raise ValueError
        deadline = time.monotonic() + float(timeout)
        if descriptors.host_read is None:
            raise ValueError
        os.set_blocking(descriptors.host_read, False)
        selector = selectors.DefaultSelector()
        try:
            selector.register(descriptors.host_read, selectors.EVENT_READ)
            _wait(selector, deadline)
            trailing = os.read(descriptors.host_read, 1)
            _remaining(deadline)
            if trailing:
                raise ValueError
        finally:
            selector.close()
        return {"schema_version": 1, "status": "verified", "error": None}
    except (OSError, ValueError, TimeoutError):
        descriptors.close_host()
        return {"schema_version": 1, "status": "failed", "error": "action coordinator failed"}
