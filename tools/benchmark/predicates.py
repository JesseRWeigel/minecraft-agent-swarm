"""Independent state predicates for benchmark scenario completion."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any


class PredicateError(ValueError):
    """A scenario predicate is malformed."""


@dataclass(frozen=True)
class PredicateResult:
    passed: bool
    reason: str
    evidence: dict[str, Any]


def _goal(scenario: dict[str, Any]) -> dict[str, Any]:
    value = scenario.get("goal")
    if not isinstance(value, dict):
        raise PredicateError("scenario goal must be an object")
    return value


def _name(mapping: dict[str, Any], field: str, label: str = "goal") -> str:
    value = mapping.get(field)
    if not isinstance(value, str) or not value:
        raise PredicateError(f"{label}.{field} must be a non-empty string")
    return value


def _count(goal: dict[str, Any]) -> int:
    value = goal.get("count")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PredicateError("goal.count must be a positive integer")
    return value


def _positive_number(mapping: dict[str, Any], field: str, label: str) -> float:
    value = mapping.get(field)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise PredicateError(f"{label}.{field} must be a positive finite number")
    return float(value)


def _nonnegative_number(mapping: dict[str, Any], field: str, label: str) -> float:
    value = mapping.get(field)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise PredicateError(f"{label}.{field} must be a non-negative finite number")
    return float(value)


def _positive_integer(mapping: dict[str, Any], field: str, label: str) -> int:
    value = mapping.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PredicateError(f"{label}.{field} must be a positive integer")
    return value


def _actor(state: Any, actor: str) -> dict[str, Any] | None:
    if not isinstance(state, dict):
        return None
    actors = state.get("actors")
    if not isinstance(actors, dict):
        return None
    value = actors.get(actor)
    return value if isinstance(value, dict) else None


def _inventory_count(state: Any, actor: str, item: str) -> int | None:
    actor_state = _actor(state, actor)
    if actor_state is None:
        return None
    inventory = actor_state.get("inventory")
    if not isinstance(inventory, dict):
        return None
    value = inventory.get(item, 0)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _position(
    state: Any, actor: str
) -> tuple[tuple[float, float, float], str] | None:
    actor_state = _actor(state, actor)
    if actor_state is None:
        return None
    dimension = actor_state.get("dimension")
    position = actor_state.get("position")
    if not isinstance(dimension, str) or not dimension or not isinstance(position, dict):
        return None
    values = [position.get(axis) for axis in ("x", "y", "z")]
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for value in values
    ):
        return None
    return (float(values[0]), float(values[1]), float(values[2])), dimension


def _bounds(goal: dict[str, Any]) -> tuple[tuple[float, ...], tuple[float, ...]]:
    lower = goal.get("min")
    upper = goal.get("max")
    if (
        not isinstance(lower, list)
        or not isinstance(upper, list)
        or len(lower) != 3
        or len(upper) != 3
    ):
        raise PredicateError("navigation goal min and max must be three-number arrays")
    values = [*lower, *upper]
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for value in values
    ):
        raise PredicateError("navigation bounds must be finite numbers")
    low = tuple(float(value) for value in lower)
    high = tuple(float(value) for value in upper)
    if any(a > b for a, b in zip(low, high)):
        raise PredicateError("navigation min must not exceed max")
    return low, high


def _inside(position: tuple[float, ...], low: tuple[float, ...], high: tuple[float, ...]) -> bool:
    return all(a <= value <= b for value, a, b in zip(position, low, high))


def _navigate(scenario: dict[str, Any], initial: Any, final: Any) -> PredicateResult:
    goal = _goal(scenario)
    actor = _name(goal, "actor")
    target_dimension = _name(goal, "dimension")
    low, high = _bounds(goal)
    before = _position(initial, actor)
    after = _position(final, actor)
    if before is None or after is None:
        return PredicateResult(False, "missing_observation", {"actor": actor})
    before_position, before_dimension = before
    after_position, after_dimension = after
    if before_dimension == target_dimension and _inside(before_position, low, high):
        return PredicateResult(
            False,
            "goal_already_met",
            {
                "actor": actor,
                "dimension": before_dimension,
                "initial_position": before_position,
            },
        )
    passed = after_dimension == target_dimension and _inside(after_position, low, high)
    return PredicateResult(
        passed,
        "observed_region_entry" if passed else "predicate_not_met",
        {
            "actor": actor,
            "target_dimension": target_dimension,
            "initial_dimension": before_dimension,
            "final_dimension": after_dimension,
            "initial_position": before_position,
            "final_position": after_position,
        },
    )


def _acquire(scenario: dict[str, Any], initial: Any, final: Any) -> PredicateResult:
    goal = _goal(scenario)
    actor = _name(goal, "actor")
    item = _name(goal, "item")
    target_count = _count(goal)
    before = _inventory_count(initial, actor, item)
    after = _inventory_count(final, actor, item)
    if before is None or after is None:
        return PredicateResult(False, "missing_observation", {"actor": actor, "item": item})
    if before >= target_count:
        return PredicateResult(
            False,
            "goal_already_met",
            {"actor": actor, "item": item, "initial_count": before},
        )
    delta = after - before
    passed = after >= target_count and delta > 0
    return PredicateResult(
        passed,
        "observed_inventory_target" if passed else "predicate_not_met",
        {
            "actor": actor,
            "item": item,
            "target_count": target_count,
            "initial_count": before,
            "final_count": after,
            "delta": delta,
        },
    )


def _observed_transfer_count(
    final: Any,
    donor: str,
    recipient: str,
    item: str,
    observer_id: str,
) -> int | None:
    if not isinstance(final, dict):
        return None
    transfers = final.get("observed_transfers")
    if not isinstance(transfers, list):
        return None
    total = 0
    event_ids: set[str] = set()
    for index, value in enumerate(transfers):
        if not isinstance(value, dict):
            raise PredicateError(f"observed_transfers[{index}] must be an object")
        event_id = value.get("event_id")
        count = value.get("count")
        if not isinstance(event_id, str) or not event_id:
            raise PredicateError(f"observed_transfers[{index}].event_id is required")
        if event_id in event_ids:
            raise PredicateError(f"duplicate observed transfer event_id: {event_id}")
        event_ids.add(event_id)
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise PredicateError(f"observed_transfers[{index}].count must be positive")
        if (
            value.get("observer_id") == observer_id
            and value.get("donor") == donor
            and value.get("recipient") == recipient
            and value.get("item") == item
        ):
            total += count
    return total


def _handoff(scenario: dict[str, Any], initial: Any, final: Any) -> PredicateResult:
    goal = _goal(scenario)
    donor = _name(goal, "donor")
    recipient = _name(goal, "recipient")
    item = _name(goal, "item")
    observer_id = _name(goal, "observer_id")
    count = _count(goal)
    if donor == recipient:
        raise PredicateError("handoff donor and recipient must be distinct actors")
    values = (
        _inventory_count(initial, donor, item),
        _inventory_count(initial, recipient, item),
        _inventory_count(final, donor, item),
        _inventory_count(final, recipient, item),
    )
    if any(value is None for value in values):
        return PredicateResult(
            False,
            "missing_observation",
            {"donor": donor, "recipient": recipient, "item": item},
        )
    donor_before, recipient_before, donor_after, recipient_after = values
    assert donor_before is not None
    assert recipient_before is not None
    assert donor_after is not None
    assert recipient_after is not None
    if recipient_before >= count:
        return PredicateResult(
            False,
            "goal_already_met",
            {
                "donor": donor,
                "recipient": recipient,
                "item": item,
                "recipient_initial_count": recipient_before,
            },
        )
    observed_count = _observed_transfer_count(
        final, donor, recipient, item, observer_id
    )
    if observed_count is None:
        return PredicateResult(
            False,
            "missing_observation",
            {"donor": donor, "recipient": recipient, "item": item},
        )
    donor_delta = donor_before - donor_after
    recipient_delta = recipient_after - recipient_before
    inventories_match = donor_delta >= count and recipient_delta >= count
    evidence_matches = observed_count >= count
    passed = inventories_match and evidence_matches
    reason = "observed_item_handoff" if passed else (
        "transfer_evidence_missing" if not evidence_matches else "predicate_not_met"
    )
    return PredicateResult(
        passed,
        reason,
        {
            "donor": donor,
            "recipient": recipient,
            "item": item,
            "observer_id": observer_id,
            "donor_delta": donor_delta,
            "recipient_delta": recipient_delta,
            "observed_transfer_count": observed_count,
        },
    )


def _recovery_state(state: Any, actor: str) -> str | None:
    actor_state = _actor(state, actor)
    if actor_state is None:
        return None
    value = actor_state.get("recovery_state")
    return value if isinstance(value, str) and value else None


def _recovery(scenario: dict[str, Any], initial: Any, final: Any) -> PredicateResult:
    goal = _goal(scenario)
    actor = _name(goal, "actor")
    injection_kind = _name(goal, "injection_kind")
    injection_outcome = _name(goal, "injection_outcome")
    expected_final_state = _name(goal, "expected_final_state")
    injection_step = _positive_integer(goal, "injection_step", "goal")
    max_latency = _positive_number(goal, "max_recovery_latency_ms", "goal")
    initial_state = _recovery_state(initial, actor)
    final_state = _recovery_state(final, actor)
    if initial_state is None or final_state is None or not isinstance(final, dict):
        return PredicateResult(False, "missing_observation", {"actor": actor})

    injections = final.get("observed_injections")
    attempts = final.get("observed_recovery_attempts")
    if not isinstance(injections, list) or not isinstance(attempts, list):
        return PredicateResult(False, "missing_observation", {"actor": actor})

    injection_ids: set[str] = set()
    matching_injections: list[tuple[dict[str, Any], float]] = []
    for index, value in enumerate(injections):
        if not isinstance(value, dict):
            raise PredicateError(f"observed_injections[{index}] must be an object")
        label = f"observed_injections[{index}]"
        event_id = _name(value, "event_id", label)
        if event_id in injection_ids:
            raise PredicateError(f"duplicate observed injection event_id: {event_id}")
        injection_ids.add(event_id)
        at_step = _positive_integer(value, "at_step", label)
        observed_at = _nonnegative_number(value, "observed_at_ms", label)
        for field in ("actor", "kind", "outcome"):
            _name(value, field, label)
        if (
            value["actor"] == actor
            and value["kind"] == injection_kind
            and value["outcome"] == injection_outcome
            and at_step == injection_step
        ):
            matching_injections.append((value, observed_at))
    if not matching_injections:
        return PredicateResult(
            False,
            "injection_not_observed",
            {
                "actor": actor,
                "injection_kind": injection_kind,
                "injection_step": injection_step,
                "injection_outcome": injection_outcome,
            },
        )
    if len(matching_injections) != 1:
        raise PredicateError("recovery predicate requires exactly one matching injection")
    injection, injection_time = matching_injections[0]

    attempt_ids: set[str] = set()
    linked_attempts: list[tuple[dict[str, Any], float, float]] = []
    for index, value in enumerate(attempts):
        if not isinstance(value, dict):
            raise PredicateError(f"observed_recovery_attempts[{index}] must be an object")
        label = f"observed_recovery_attempts[{index}]"
        event_id = _name(value, "event_id", label)
        if event_id in attempt_ids:
            raise PredicateError(f"duplicate observed recovery event_id: {event_id}")
        attempt_ids.add(event_id)
        started_at = _nonnegative_number(value, "started_at_ms", label)
        finished_at = _nonnegative_number(value, "finished_at_ms", label)
        for field in ("actor", "injection_event_id", "outcome"):
            _name(value, field, label)
        if finished_at < started_at:
            raise PredicateError(f"{label} finishes before it starts")
        if value["actor"] == actor and value["injection_event_id"] == injection["event_id"]:
            if started_at < injection_time:
                raise PredicateError(f"{label} starts before its linked injection")
            linked_attempts.append((value, started_at, finished_at))
    if not linked_attempts:
        return PredicateResult(
            False,
            "recovery_attempt_not_observed",
            {"actor": actor, "injection_event_id": injection["event_id"]},
        )

    recovered = [entry for entry in linked_attempts if entry[0]["outcome"] == "recovered"]
    if not recovered:
        return PredicateResult(
            False,
            "recovery_outcome_not_met",
            {
                "actor": actor,
                "injection_event_id": injection["event_id"],
                "observed_outcomes": sorted({entry[0]["outcome"] for entry in linked_attempts}),
            },
        )
    attempt, started_at, finished_at = min(recovered, key=lambda entry: entry[2])
    latency = finished_at - injection_time
    attempt_duration = finished_at - started_at
    evidence = {
        "actor": actor,
        "initial_state": initial_state,
        "final_state": final_state,
        "injection_event_id": injection["event_id"],
        "injection_kind": injection_kind,
        "injection_step": injection_step,
        "injection_outcome": injection_outcome,
        "recovery_event_id": attempt["event_id"],
        "recovery_outcome": attempt["outcome"],
        "recovery_latency_ms": latency,
        "attempt_duration_ms": attempt_duration,
        "max_recovery_latency_ms": max_latency,
    }
    if final_state != expected_final_state:
        return PredicateResult(False, "recovery_postcondition_not_met", evidence)
    if latency > max_latency:
        return PredicateResult(False, "recovery_latency_exceeded", evidence)
    return PredicateResult(True, "observed_recovery_after_injection", evidence)


def evaluate_goal(
    scenario: dict[str, Any], initial_state: Any, final_state: Any
) -> PredicateResult:
    """Evaluate a goal only from observed pre/post state."""

    task = scenario.get("task")
    if task == "navigate_to_region":
        return _navigate(scenario, initial_state, final_state)
    if task == "acquire_item":
        return _acquire(scenario, initial_state, final_state)
    if task == "shared_resource_handoff":
        return _handoff(scenario, initial_state, final_state)
    if task == "recover_after_injected_failure":
        return _recovery(scenario, initial_state, final_state)
    raise PredicateError(f"unsupported scenario task: {task!r}")
