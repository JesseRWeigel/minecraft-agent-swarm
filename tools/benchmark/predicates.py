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


def _name(goal: dict[str, Any], field: str) -> str:
    value = goal.get(field)
    if not isinstance(value, str) or not value:
        raise PredicateError(f"goal.{field} must be a non-empty string")
    return value


def _count(goal: dict[str, Any]) -> int:
    value = goal.get("count")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PredicateError("goal.count must be a positive integer")
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
    raise PredicateError(f"unsupported scenario task: {task!r}")
