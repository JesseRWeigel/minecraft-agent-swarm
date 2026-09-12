#!/usr/bin/env python3
"""Evaluate frozen mock/replay observations without starting live services."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import random
import tempfile
from typing import Any, Iterable

from .manifest import LoadedExperiment, ManifestError, load_experiment
from .predicates import PredicateError, PredicateResult, evaluate_goal


REPORT_SCHEMA_VERSION = 1
_EXECUTION_STATUSES = {"completed", "failed", "timed_out", "interrupted", "cancelled"}
_INFERENCE_METRICS = (
    "provider_requests",
    "input_tokens",
    "output_tokens",
    "estimated_cost_usd",
)
_RUNTIME_RESOURCE_METRICS = (
    "wall_time_ms",
    "cpu_time_ms",
    "peak_rss_bytes",
    "energy_joules",
)
_ENGINEERING_METRICS = (
    "labor_time_minutes",
    "infrastructure_cost_usd",
)


class BenchmarkError(ValueError):
    """Frozen observations cannot form a valid benchmark matrix."""


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BenchmarkError(f"{label} must be an object")
    return value


def _text(mapping: dict[str, Any], field: str, label: str) -> str:
    value = mapping.get(field)
    if not isinstance(value, str) or not value:
        raise BenchmarkError(f"{label}.{field} must be a non-empty string")
    return value


def _nonnegative_number(value: Any, label: str) -> int | float | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise BenchmarkError(f"{label} must be null or a non-negative finite number")
    return value


def _normalize_metrics(raw: Any, label: str) -> dict[str, dict[str, int | float | None]]:
    metrics = {} if raw is None else _object(raw, label)
    result: dict[str, dict[str, int | float | None]] = {}
    for group, fields in (
        ("inference", _INFERENCE_METRICS),
        ("runtime_resources", _RUNTIME_RESOURCE_METRICS),
        ("engineering", _ENGINEERING_METRICS),
    ):
        source = metrics.get(group)
        source = {} if source is None else _object(source, f"{label}.{group}")
        unknown = set(source) - set(fields)
        if unknown:
            raise BenchmarkError(f"{label}.{group} has unknown fields: {sorted(unknown)}")
        result[group] = {
            field: _nonnegative_number(source.get(field), f"{label}.{group}.{field}")
            for field in fields
        }
        if group == "inference":
            for field in ("provider_requests", "input_tokens", "output_tokens"):
                value = result[group][field]
                if value is not None and not isinstance(value, int):
                    raise BenchmarkError(f"{label}.{group}.{field} must be an integer")
    return result


def _expected_matrix(experiment: LoadedExperiment) -> list[tuple[str, str, int]]:
    return [
        (scenario["id"], condition["id"], seed)
        for scenario in experiment.scenarios["scenarios"]
        for condition in experiment.conditions
        for seed in experiment.manifest["seeds"]
    ]


def _indexed_runs(
    experiment: LoadedExperiment,
) -> tuple[dict[tuple[str, str, int], tuple[int, dict[str, Any]]], list[tuple[str, str, int]]]:
    expected_order = _expected_matrix(experiment)
    expected = set(expected_order)
    indexed: dict[tuple[str, str, int], tuple[int, dict[str, Any]]] = {}
    run_ids: set[str] = set()
    for index, raw in enumerate(experiment.observations["runs"]):
        run = _object(raw, f"run[{index}]")
        run_id = _text(run, "run_id", f"run[{index}]")
        if run_id in run_ids:
            raise BenchmarkError(f"duplicate run_id: {run_id}")
        run_ids.add(run_id)
        scenario_id = _text(run, "scenario_id", f"run[{index}]")
        condition_id = _text(run, "condition_id", f"run[{index}]")
        seed = run.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise BenchmarkError(f"run[{index}].seed must be a non-negative integer")
        key = (scenario_id, condition_id, seed)
        if key in indexed:
            raise BenchmarkError(
                f"duplicate run for scenario={scenario_id}, condition={condition_id}, seed={seed}"
            )
        if key not in expected:
            raise BenchmarkError(
                f"unexpected run for scenario={scenario_id}, condition={condition_id}, seed={seed}"
            )
        indexed[key] = (index, run)
    missing = [key for key in expected_order if key not in indexed]
    if missing:
        scenario_id, condition_id, seed = missing[0]
        raise BenchmarkError(
            f"missing run for scenario={scenario_id}, condition={condition_id}, seed={seed}"
        )
    return indexed, expected_order


def _validated_steps(run: dict[str, Any]) -> int:
    steps = run.get("steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or steps < 0:
        raise BenchmarkError("run.steps must be a non-negative integer")
    return steps


def _budget_measurements_complete(
    metrics: dict[str, dict[str, int | float | None]]
) -> bool:
    inference = metrics["inference"]
    runtime = metrics["runtime_resources"]
    return all(
        value is not None
        for value in (
            inference["provider_requests"],
            inference["input_tokens"],
            inference["output_tokens"],
            runtime["wall_time_ms"],
        )
    )


def _budget_failure(
    steps: int,
    metrics: dict[str, dict[str, int | float | None]],
    budgets: dict[str, int | float],
) -> tuple[str, str] | None:
    if steps > budgets["max_steps"]:
        return "failed", "step_budget_exceeded"

    wall_time = metrics["runtime_resources"]["wall_time_ms"]
    assert wall_time is not None
    if wall_time > budgets["timeout_seconds"] * 1000:
        return "timed_out", "wall_time_budget_exceeded"

    inference = metrics["inference"]
    checks = (
        ("provider_requests", "max_provider_requests", "provider_request_budget_exceeded"),
        ("input_tokens", "max_input_tokens", "input_token_budget_exceeded"),
        ("output_tokens", "max_output_tokens", "output_token_budget_exceeded"),
    )
    for metric, budget, reason in checks:
        value = inference[metric]
        assert value is not None
        if value > budgets[budget]:
            return "failed", reason
    return None


def _classify(
    run: dict[str, Any],
    scenario: dict[str, Any],
    budgets: dict[str, int | float],
) -> tuple[str, str, PredicateResult, dict[str, dict[str, int | float | None]]]:
    telemetry = run.get("telemetry_complete")
    if not isinstance(telemetry, bool):
        raise BenchmarkError("run.telemetry_complete must be a boolean")
    execution_status = run.get("execution_status")
    if execution_status not in _EXECUTION_STATUSES:
        raise BenchmarkError(f"unsupported run.execution_status: {execution_status!r}")
    model_report = run.get("model_self_report")
    if model_report is not None and not isinstance(model_report, str):
        raise BenchmarkError("run.model_self_report must be null or a string")
    metrics = _normalize_metrics(run.get("metrics"), "run.metrics")
    steps = _validated_steps(run)
    try:
        predicate = evaluate_goal(
            scenario, run.get("initial_state"), run.get("final_state")
        )
    except PredicateError as exc:
        raise BenchmarkError(str(exc)) from exc

    if not telemetry:
        return "missing_telemetry", "telemetry_incomplete", predicate, metrics
    if not _budget_measurements_complete(metrics):
        return "missing_telemetry", "budget_measurement_missing", predicate, metrics
    if predicate.reason == "missing_observation":
        return "missing_telemetry", "predicate_observation_missing", predicate, metrics
    if predicate.reason == "goal_already_met":
        return "invalid_initial", "goal_already_met", predicate, metrics
    if execution_status == "timed_out":
        return "timed_out", "execution_timed_out", predicate, metrics
    if execution_status in {"interrupted", "cancelled"}:
        return "interrupted", f"execution_{execution_status}", predicate, metrics
    if execution_status == "failed":
        return "failed", "execution_failed", predicate, metrics
    budget_failure = _budget_failure(steps, metrics, budgets)
    if budget_failure is not None:
        return *budget_failure, predicate, metrics
    if predicate.passed:
        return "completed", predicate.reason, predicate, metrics
    return "failed", predicate.reason, predicate, metrics


def _wilson(successes: int, total: int) -> dict[str, Any]:
    if total == 0:
        return {"method": "wilson_95", "lower": None, "upper": None}
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1 - proportion) / total + z * z / (4 * total * total)
        )
        / denominator
    )
    return {
        "method": "wilson_95",
        "lower": round(max(0.0, center - margin), 6),
        "upper": round(min(1.0, center + margin), 6),
    }


def _metric_summary(
    rows: list[dict[str, Any]], group: str, fields: Iterable[str]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for field in fields:
        values = [
            row["metrics"][group][field]
            for row in rows
            if row["metrics"][group][field] is not None
        ]
        result[field] = {
            "known": len(values),
            "missing": len(rows) - len(values),
            "mean": round(sum(values) / len(values), 6) if values else None,
        }
    return result


def _condition_summary(
    rows: list[dict[str, Any]], condition_id: str
) -> dict[str, Any]:
    selected = [row for row in rows if row["condition_id"] == condition_id]
    completed = sum(row["status"] == "completed" for row in selected)
    return {
        "condition_id": condition_id,
        "trials": len(selected),
        "completed": completed,
        "completion_rate": round(completed / len(selected), 6) if selected else None,
        "completion_uncertainty": _wilson(completed, len(selected)),
        "status_counts": dict(sorted(Counter(row["status"] for row in selected).items())),
        "metrics": {
            "inference": _metric_summary(selected, "inference", _INFERENCE_METRICS),
            "runtime_resources": _metric_summary(
                selected, "runtime_resources", _RUNTIME_RESOURCE_METRICS
            ),
            "engineering": _metric_summary(selected, "engineering", _ENGINEERING_METRICS),
        },
    }


def _condition_seed_summary(
    rows: list[dict[str, Any]], condition_id: str, seed: int
) -> dict[str, Any]:
    selected = [
        row
        for row in rows
        if row["condition_id"] == condition_id and row["seed"] == seed
    ]
    completed = sum(row["status"] == "completed" for row in selected)
    return {
        "condition_id": condition_id,
        "seed": seed,
        "trials": len(selected),
        "completed": completed,
        "completion_rate": round(completed / len(selected), 6) if selected else None,
        "completion_uncertainty": _wilson(completed, len(selected)),
    }


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = round((len(sorted_values) - 1) * fraction)
    return sorted_values[index]


def _paired_comparison(
    rows: list[dict[str, Any]],
    baseline: str,
    candidate: str,
    benchmark_id: str,
) -> dict[str, Any]:
    indicators = {
        (row["scenario_id"], row["seed"], row["condition_id"]): int(
            row["status"] == "completed"
        )
        for row in rows
    }
    units = sorted(
        {
            (row["scenario_id"], row["seed"])
            for row in rows
            if row["condition_id"] == baseline
        }
    )
    deltas = [
        indicators[(scenario_id, seed, candidate)]
        - indicators[(scenario_id, seed, baseline)]
        for scenario_id, seed in units
    ]
    seed_bytes = hashlib.sha256(f"{benchmark_id}|{baseline}|{candidate}".encode()).digest()
    generator = random.Random(int.from_bytes(seed_bytes[:8], "big"))
    samples = []
    for _ in range(2000):
        resample = [deltas[generator.randrange(len(deltas))] for _ in deltas]
        samples.append(sum(resample) / len(resample))
    samples.sort()
    return {
        "baseline_condition": baseline,
        "candidate_condition": candidate,
        "pair_unit": "scenario_id+seed",
        "pair_count": len(deltas),
        "wins": sum(delta > 0 for delta in deltas),
        "losses": sum(delta < 0 for delta in deltas),
        "ties": sum(delta == 0 for delta in deltas),
        "mean_paired_completion_delta": round(sum(deltas) / len(deltas), 6),
        "uncertainty": {
            "method": "paired_bootstrap_percentile",
            "confidence": 0.95,
            "resamples": 2000,
            "lower": round(_percentile(samples, 0.025), 6),
            "upper": round(_percentile(samples, 0.975), 6),
        },
    }


def _build_case_study(
    rows: list[dict[str, Any]], experiment: LoadedExperiment
) -> dict[str, Any]:
    case = experiment.case_study
    by_id = {row["run_id"]: row for row in rows}
    before = by_id.get(case["before_run_id"])
    after = by_id.get(case["after_run_id"])
    if before is None or after is None:
        raise BenchmarkError("case study run references must exist in the observation matrix")
    if (
        before["scenario_id"] != case["scenario_id"]
        or after["scenario_id"] != case["scenario_id"]
        or before["seed"] != case["seed"]
        or after["seed"] != case["seed"]
        or before["seed"] != after["seed"]
    ):
        raise BenchmarkError("case study must link the same scenario and seed")
    baseline_id = next(
        condition["id"]
        for condition in experiment.conditions
        if condition["kind"] == "baseline"
    )
    if before["condition_id"] != baseline_id or after["condition_id"] == baseline_id:
        raise BenchmarkError("case study must compare baseline before to non-baseline after")
    if before["status"] == "completed" or after["status"] != "completed":
        raise BenchmarkError("case study must link an observed failure to an observed fix")
    fields = (
        "run_id",
        "scenario_id",
        "condition_id",
        "seed",
        "status",
        "reason_code",
        "source_ref",
    )
    return {
        "evidence_class": case["evidence_class"],
        "diagnosed_failure": case["diagnosed_failure"],
        "simulated_change": case["simulated_change"],
        "claim_limit": case["claim_limit"],
        "before": {field: before[field] for field in fields},
        "after": {field: after[field] for field in fields},
    }


def _summarize(rows: list[dict[str, Any]], experiment: LoadedExperiment) -> dict[str, Any]:
    condition_ids = [condition["id"] for condition in experiment.conditions]
    baseline = next(
        condition["id"]
        for condition in experiment.conditions
        if condition["kind"] == "baseline"
    )
    return {
        "trial_count": len(rows),
        "conditions": [
            _condition_summary(rows, condition_id) for condition_id in condition_ids
        ],
        "condition_seed": [
            _condition_seed_summary(rows, condition_id, seed)
            for condition_id in condition_ids
            for seed in experiment.manifest["seeds"]
        ],
        "paired_comparisons": [
            _paired_comparison(
                rows, baseline, condition_id, experiment.manifest["benchmark_id"]
            )
            for condition_id in condition_ids
            if condition_id != baseline
        ],
        "interpretation": (
            "Descriptive results for frozen synthetic observations; paired intervals "
            "resample matched scenario-seed units and are not Minecraft evidence."
            if experiment.manifest["adapter"] == "mock"
            else
            "Descriptive replay results; paired intervals resample matched scenario-seed units."
        ),
    }


def run_benchmark(manifest_path: Path) -> dict[str, Any]:
    """Validate a complete frozen matrix and independently score every run."""

    try:
        experiment = load_experiment(Path(manifest_path))
    except ManifestError as exc:
        raise BenchmarkError(str(exc)) from exc
    indexed, order = _indexed_runs(experiment)
    scenarios = {
        scenario["id"]: scenario for scenario in experiment.scenarios["scenarios"]
    }
    observation_hash = experiment.manifest["observation_manifest"]["sha256"]
    rows: list[dict[str, Any]] = []
    for key in order:
        index, run = indexed[key]
        scenario_id, condition_id, seed = key
        status, reason, predicate, metrics = _classify(
            run, scenarios[scenario_id], experiment.manifest["budgets"]
        )
        rows.append(
            {
                "run_id": run["run_id"],
                "scenario_id": scenario_id,
                "condition_id": condition_id,
                "seed": seed,
                "status": status,
                "reason_code": reason,
                "execution_status": run["execution_status"],
                "telemetry_complete": run["telemetry_complete"],
                "model_self_report": run.get("model_self_report"),
                "predicate": {
                    "passed": predicate.passed,
                    "reason": predicate.reason,
                    "evidence": predicate.evidence,
                },
                "metrics": metrics,
                "steps": run["steps"],
                "source_ref": {
                    "observation_sha256": observation_hash,
                    "record_index": index,
                },
            }
        )
    adapter = experiment.manifest["adapter"]
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "benchmark_id": experiment.manifest["benchmark_id"],
        "evidence_class": "synthetic_mock" if adapter == "mock" else "replay_observations",
        "claims_live_minecraft_outcomes": False,
        "deterministic": True,
        "provenance": {
            "experiment_sha256": experiment.manifest_sha256,
            "scenario_manifest": experiment.manifest["scenario_manifest"],
            "reset_manifest": experiment.manifest["reset_manifest"],
            "model_manifest": experiment.manifest["model_manifest"],
            "observation_manifest": experiment.manifest["observation_manifest"],
            "case_study_manifest": experiment.manifest["case_study_manifest"],
            "condition_configs": [
                {"id": condition["id"], "sha256": condition["config_sha256"]}
                for condition in experiment.conditions
            ],
            "world": experiment.reset,
            "model": experiment.model,
            "code": experiment.manifest["code"],
            "collection_context": experiment.manifest["collection_context"],
            "budgets": experiment.manifest["budgets"],
            "seeds": experiment.manifest["seeds"],
        },
        "runs": rows,
        "case_study": _build_case_study(rows, experiment),
        "summary": _summarize(rows, experiment),
    }


def _write_new_json(path: Path, value: dict[str, Any]) -> None:
    if not path.parent.is_dir():
        raise BenchmarkError(f"output parent does not exist: {path.parent}")
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError as exc:
            raise BenchmarkError(f"output already exists: {path}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate or score frozen mock/replay benchmark observations."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "run"):
        child = subparsers.add_parser(name)
        child.add_argument("--manifest", type=Path, required=True)
        if name == "run":
            child.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = run_benchmark(args.manifest)
        if args.command == "validate":
            print(
                f"validated {report['benchmark_id']}: "
                f"{report['summary']['trial_count']} frozen runs"
            )
        else:
            _write_new_json(args.output, report)
            print(f"wrote {args.output}")
    except BenchmarkError as exc:
        print(f"benchmark error: {exc}", file=__import__("sys").stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
