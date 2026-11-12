"""Bounded model-to-action loop; caller owns participant lifecycle and scoring.

No default endpoint, tokenizer, prompt, model or live-game launcher is supplied.
The participant remains the authority for action-schema validation. Synthetic
tests qualify plumbing only, not Minecraft outcomes or real backend cancellation.
"""
from dataclasses import asdict
import json
import math
import os
import selectors
import time

from tools.pilot.action_coordinator import _request, _decode_reply, MAX_REPLY_BYTES
from tools.pilot.action_descriptors import ActionDescriptors
from tools.pilot.inference_budget import InferenceBudget
from tools.pilot.ollama_adapter import call_ollama, _json, _request as _inference_request


class Stopped(Exception):
    pass


def _guard(deadline, cancel):
    if cancel is not None and cancel.is_set():
        raise Stopped("cancelled")
    if time.monotonic() >= deadline:
        raise Stopped("timeout")


def _ready(fd, event, deadline, cancel):
    with selectors.DefaultSelector() as selector:
        selector.register(fd, event)
        while True:
            _guard(deadline, cancel)
            ready = selector.select(min(.05, max(0, deadline-time.monotonic())))
            _guard(deadline, cancel)
            if ready:
                return


def _exchange(descriptors, action, sequence, deadline, cancel, records):
    raw = _request(action, sequence)
    record = {"request": json.loads(raw), "reply": None,
              "started_monotonic": time.monotonic(), "finished_monotonic": None}
    records.append(record)
    offset = 0
    while offset < len(raw):
        _ready(descriptors.host_write, selectors.EVENT_WRITE, deadline, cancel)
        _guard(deadline, cancel)
        try:
            count = os.write(descriptors.host_write, raw[offset:])
        except BlockingIOError:
            continue
        if count <= 0:
            raise OSError()
        offset += count
    finished = action.get("kind") == "finish"
    if finished:
        os.close(descriptors.host_write)
        descriptors.host_write = None
    buffer = bytearray()
    while True:
        _ready(descriptors.host_read, selectors.EVENT_READ, deadline, cancel)
        try:
            chunk = os.read(descriptors.host_read, min(4096, MAX_REPLY_BYTES-len(buffer)))
        except BlockingIOError:
            continue
        if not chunk:
            raise EOFError()
        buffer.extend(chunk)
        newline = buffer.find(b"\n")
        if newline >= 0:
            if newline != len(buffer)-1:
                raise ValueError()
            reply = _decode_reply(bytes(buffer[:newline]), sequence, finished, action.get("kind") == "observe")
            _guard(deadline, cancel)
            record["reply"] = reply
            record["finished_monotonic"] = time.monotonic()
            return reply
        if len(buffer) >= MAX_REPLY_BYTES:
            raise ValueError()


def run_model_actions(descriptors, *, port, model, build_prompt, count_tokens,
                      timeout=120, cancel=None):
    """Run after participant begin; return bounded transcript, never a score.

    build_prompt receives copied action records, including initial observation.
    count_tokens is trusted caller code for the entire rendered prompt. Do not
    substitute an estimate for a pinned tokenizer when using a real model.
    Caller must finalize/reap the participant and audit channel EOF on success.
    """
    actions, calls = [], []
    result = {"schema_version": 1, "status": "failed", "actions": actions, "calls": calls}
    budget = None
    try:
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 120:
            raise ValueError()
        deadline = time.monotonic() + timeout
        budget = InferenceBudget()
        if not isinstance(descriptors, ActionDescriptors) or not callable(build_prompt) or not callable(count_tokens):
            raise ValueError()
        if descriptors.host_write is None or descriptors.host_read is None:
            raise ValueError()
        os.set_blocking(descriptors.host_write, False)
        os.set_blocking(descriptors.host_read, False)
        _guard(deadline, cancel)
        _exchange(descriptors, {"kind": "observe"}, 1, deadline, cancel, actions)
        for sequence in range(2, 10):
            _guard(deadline, cancel)
            messages = build_prompt(json.loads(json.dumps(actions)))
            # Validate size/schema before copying or retaining caller output.
            _inference_request(model, messages, 256)
            messages = json.loads(json.dumps(messages, allow_nan=False))
            input_tokens = count_tokens(json.loads(json.dumps(messages)))
            _guard(deadline, cancel)
            response = call_ollama(port=port, model=model, messages=messages,
                input_tokens=input_tokens, budget=budget, cancel=cancel,
                timeout_cap=min(20, deadline-time.monotonic()))
            calls.append({"messages": messages, "input_tokens": input_tokens, "response": response})
            _guard(deadline, cancel)
            if response["status"] != "completed" or not response["worker_reaped"]:
                result["status"] = response["status"]
                break
            action = _json(response["content"].encode("utf-8"))
            _guard(deadline, cancel)
            _exchange(descriptors, action, sequence, deadline, cancel, actions)
            if action.get("kind") == "finish":
                result["status"] = "finished"
                break
        else:
            result["status"] = "budget_exhausted"
    except Stopped as exc:
        result["status"] = str(exc)
    except Exception:
        result["status"] = "failed"
    finally:
        if budget is not None:
            result["budget"] = [asdict(row) for row in budget.records]
        if result["status"] != "finished" and isinstance(descriptors, ActionDescriptors):
            descriptors.close_host()
    return result
