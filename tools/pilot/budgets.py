"""Deterministic budget accounting for offline fake-provider pilot trials."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import time
from typing import Any, Callable


_LIMIT_FIELDS = {
    "max_steps",
    "timeout_seconds",
    "max_provider_requests",
    "max_input_tokens",
    "max_output_tokens",
}


class BudgetError(ValueError):
    """Budget configuration or accounting input is invalid."""


class BudgetExceeded(BudgetError):
    """An operation would exceed a configured trial budget."""


def _positive_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise BudgetError(f"{field} must be a positive integer")
    return value


def _nonnegative_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BudgetError(f"{field} must be a non-negative integer")
    return value


@dataclass(frozen=True)
class BudgetLimits:
    max_steps: int
    timeout_seconds: float
    max_provider_requests: int
    max_input_tokens: int
    max_output_tokens: int

    @classmethod
    def from_dict(cls, value: Any) -> "BudgetLimits":
        if not isinstance(value, dict) or set(value) != _LIMIT_FIELDS:
            raise BudgetError(f"budget limits must contain exactly {sorted(_LIMIT_FIELDS)}")
        timeout = value["timeout_seconds"]
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise BudgetError("timeout_seconds must be a positive finite number")
        return cls(
            max_steps=_positive_integer(value["max_steps"], "max_steps"),
            timeout_seconds=float(timeout),
            max_provider_requests=_positive_integer(
                value["max_provider_requests"], "max_provider_requests"
            ),
            max_input_tokens=_positive_integer(value["max_input_tokens"], "max_input_tokens"),
            max_output_tokens=_positive_integer(
                value["max_output_tokens"], "max_output_tokens"
            ),
        )


class BudgetTracker:
    """Account at call boundaries; this object does not interrupt running work."""

    def __init__(
        self,
        limits: BudgetLimits,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not isinstance(limits, BudgetLimits):
            raise BudgetError("limits must be a BudgetLimits instance")
        if not callable(clock):
            raise BudgetError("clock must be callable")
        self.limits = limits
        self._clock = clock
        self._started_at = self._read_clock(initial=True)
        self._last_clock = self._started_at
        self._steps = 0
        self._provider_requests = 0
        self._input_tokens = 0
        self._output_tokens = 0
        self._reserved_output_tokens: int | None = None

    def _read_clock(self, *, initial: bool = False) -> float:
        value = self._clock()
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise BudgetError("clock must return a finite number")
        observed = float(value)
        if not initial and observed < self._last_clock:
            raise BudgetError("clock must be monotonic and may not move backwards")
        if not initial:
            self._last_clock = observed
        return observed

    def _elapsed(self) -> float:
        elapsed = self._read_clock() - self._started_at
        if not math.isfinite(elapsed):
            raise BudgetError("clock elapsed time must remain finite")
        return elapsed

    def _check_deadline(self) -> float:
        elapsed = self._elapsed()
        if elapsed >= self.limits.timeout_seconds:
            raise BudgetExceeded("trial deadline is exhausted")
        return elapsed

    def reserve_request(self, input_tokens: int, max_output_tokens: int) -> None:
        """Reserve a fake-provider call before invocation and charge known input."""
        input_tokens = _nonnegative_integer(input_tokens, "input_tokens")
        max_output_tokens = _positive_integer(max_output_tokens, "max_output_tokens")
        if self._reserved_output_tokens is not None:
            raise BudgetError("cannot reserve a request while another request is unfinished")
        self._check_deadline()
        if self._provider_requests >= self.limits.max_provider_requests:
            raise BudgetExceeded("provider requests budget is exhausted")
        if self._input_tokens + input_tokens > self.limits.max_input_tokens:
            raise BudgetExceeded("input tokens budget would be exceeded")
        if self._output_tokens + max_output_tokens > self.limits.max_output_tokens:
            raise BudgetExceeded("output tokens budget would be exceeded")
        self._provider_requests += 1
        self._input_tokens += input_tokens
        self._reserved_output_tokens = max_output_tokens

    def finish_request(self, actual_output_tokens: int) -> None:
        """Replace the active maximum-output reservation with observed usage."""
        actual_output_tokens = _nonnegative_integer(
            actual_output_tokens, "actual_output_tokens"
        )
        if self._reserved_output_tokens is None:
            raise BudgetError("cannot finish a request when no request is pending")
        if actual_output_tokens > self._reserved_output_tokens:
            raise BudgetError("actual output tokens exceed the active reservation")
        self._output_tokens += actual_output_tokens
        self._reserved_output_tokens = None

    def consume_step(self) -> None:
        """Charge one completed/attempted controller step before it starts."""
        self._check_deadline()
        if self._steps >= self.limits.max_steps:
            raise BudgetExceeded("steps budget is exhausted")
        self._steps += 1

    def snapshot(self) -> dict[str, Any]:
        elapsed = self._elapsed()
        reserved = self._reserved_output_tokens or 0
        return {
            "limits": asdict(self.limits),
            "steps": self._steps,
            "provider_requests": self._provider_requests,
            "input_tokens": self._input_tokens,
            "output_tokens": self._output_tokens,
            "reserved_output_tokens": reserved,
            "request_pending": self._reserved_output_tokens is not None,
            "elapsed_seconds": elapsed,
            "remaining": {
                "steps": self.limits.max_steps - self._steps,
                "requests": self.limits.max_provider_requests - self._provider_requests,
                "input_tokens": self.limits.max_input_tokens - self._input_tokens,
                "output_tokens": self.limits.max_output_tokens
                - self._output_tokens
                - reserved,
                "deadline_seconds": max(0.0, self.limits.timeout_seconds - elapsed),
            },
            "exhausted": {
                "requests": self._provider_requests >= self.limits.max_provider_requests,
                "input_tokens": self._input_tokens >= self.limits.max_input_tokens,
                "output_tokens": self._output_tokens + reserved
                >= self.limits.max_output_tokens,
                "steps": self._steps >= self.limits.max_steps,
                "deadline": elapsed >= self.limits.timeout_seconds,
            },
            "hard_preemption": False,
            "deadline_enforcement": "checked_at_budget_boundaries",
        }
