"""Strict, content-pinned manifests for the offline benchmark runner."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any


SCHEMA_VERSION = 1
MAX_JSON_BYTES = 16 * 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_COMMIT = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_ALLOWED_ADAPTERS = {"mock", "replay"}
_ALLOWED_CONDITION_KINDS = {"baseline", "coordination", "coaching"}
_BUDGET_FIELDS = {
    "max_steps",
    "timeout_seconds",
    "max_provider_requests",
    "max_input_tokens",
    "max_output_tokens",
}
_CONTEXT_FIELDS = {
    "operation_mode",
    "trial_id",
    "git_commit",
    "world_snapshot_id",
}


class ManifestError(ValueError):
    """A benchmark manifest is incomplete, unsafe, or not reproducible."""


@dataclass(frozen=True)
class LoadedExperiment:
    path: Path
    manifest_sha256: str
    manifest: dict[str, Any]
    scenarios: dict[str, Any]
    reset: dict[str, Any]
    model: dict[str, Any]
    observations: dict[str, Any]
    case_study: dict[str, Any]
    conditions: tuple[dict[str, Any], ...]


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{label} must be a JSON object")
    return value


def _require_string(mapping: dict[str, Any], field: str, label: str) -> str:
    value = mapping.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label}.{field} must be a non-empty string")
    return value


def _require_id(mapping: dict[str, Any], field: str, label: str) -> str:
    value = _require_string(mapping, field, label)
    if not _ID.fullmatch(value):
        raise ManifestError(f"{label}.{field} must be a stable lowercase identifier")
    return value


def _require_schema(document: dict[str, Any], label: str) -> None:
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ManifestError(f"{label}.schema_version must be {SCHEMA_VERSION}")


def _read_json(path: Path, label: str) -> tuple[dict[str, Any], str]:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ManifestError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ManifestError(f"{label} may not be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ManifestError(f"{label} must be a regular file: {path}")
    if info.st_size > MAX_JSON_BYTES:
        raise ManifestError(f"{label} exceeds {MAX_JSON_BYTES} bytes")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    return _expect_object(value, label), digest


def _resolve_ref(base: Path, ref: Any, label: str) -> tuple[dict[str, Any], str]:
    ref = _expect_object(ref, label)
    relative = _require_string(ref, "path", label)
    expected_hash = _require_string(ref, "sha256", label)
    if not _SHA256.fullmatch(expected_hash):
        raise ManifestError(f"{label}.sha256 must be lowercase SHA-256")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise ManifestError(f"{label}.path must be a safe relative path")
    candidate = base.joinpath(*pure.parts)
    current = base
    for part in pure.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError(f"{label} path may not contain a symlink: {relative}")
    value, actual_hash = _read_json(candidate, label)
    if actual_hash != expected_hash:
        raise ManifestError(
            f"{label} hash mismatch: expected {expected_hash}, observed {actual_hash}"
        )
    return value, actual_hash


def _validate_reset(reset: dict[str, Any]) -> None:
    _require_schema(reset, "reset_manifest")
    _require_id(reset, "world_id", "reset_manifest")
    _require_string(reset, "server_version", "reset_manifest")
    world_hash = _require_string(reset, "world_archive_sha256", "reset_manifest")
    if not _SHA256.fullmatch(world_hash):
        raise ManifestError("reset_manifest.world_archive_sha256 must be lowercase SHA-256")


def _validate_model(model: dict[str, Any]) -> None:
    _require_schema(model, "model_manifest")
    for field in ("provider", "model", "version"):
        _require_string(model, field, "model_manifest")


def _validate_scenarios(scenarios: dict[str, Any]) -> None:
    _require_schema(scenarios, "scenario_manifest")
    values = scenarios.get("scenarios")
    if not isinstance(values, list) or not values:
        raise ManifestError("scenario_manifest.scenarios must be a non-empty list")
    seen: set[str] = set()
    for index, scenario_value in enumerate(values):
        scenario = _expect_object(scenario_value, f"scenario[{index}]")
        scenario_id = _require_id(scenario, "id", f"scenario[{index}]")
        if scenario_id in seen:
            raise ManifestError(f"duplicate scenario id: {scenario_id}")
        seen.add(scenario_id)
        task = _require_string(scenario, "task", f"scenario[{index}]")
        if task not in {"navigate_to_region", "acquire_item", "shared_resource_handoff"}:
            raise ManifestError(f"unsupported scenario task: {task}")
        _expect_object(scenario.get("goal"), f"scenario[{index}].goal")


def _validate_observations(observations: dict[str, Any]) -> None:
    _require_schema(observations, "observation_manifest")
    if not isinstance(observations.get("runs"), list):
        raise ManifestError("observation_manifest.runs must be a list")


def _validate_case_study(case_study: dict[str, Any]) -> None:
    _require_schema(case_study, "case_study_manifest")
    if case_study.get("evidence_class") != "synthetic_mock":
        raise ManifestError("case_study_manifest.evidence_class must be synthetic_mock")
    _require_id(case_study, "scenario_id", "case_study_manifest")
    seed = case_study.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ManifestError("case_study_manifest.seed must be a non-negative integer")
    for field in (
        "before_run_id",
        "after_run_id",
        "diagnosed_failure",
        "simulated_change",
        "claim_limit",
    ):
        _require_string(case_study, field, "case_study_manifest")


def _validate_main(manifest: dict[str, Any]) -> None:
    _require_schema(manifest, "experiment")
    _require_id(manifest, "benchmark_id", "experiment")
    adapter = manifest.get("adapter")
    if adapter not in _ALLOWED_ADAPTERS:
        raise ManifestError("experiment.adapter must be mock or replay")

    code = _expect_object(manifest.get("code"), "experiment.code")
    commit = _require_string(code, "git_commit", "experiment.code")
    if not _GIT_COMMIT.fullmatch(commit):
        raise ManifestError("experiment.code.git_commit must be a full Git object ID")
    dirty_hash = code.get("dirty_diff_sha256")
    if dirty_hash is not None and (
        not isinstance(dirty_hash, str) or not _SHA256.fullmatch(dirty_hash)
    ):
        raise ManifestError("experiment.code.dirty_diff_sha256 must be null or SHA-256")

    seeds = manifest.get("seeds")
    if (
        not isinstance(seeds, list)
        or len(seeds) < 2
        or any(isinstance(seed, bool) or not isinstance(seed, int) or seed < 0 for seed in seeds)
        or len(set(seeds)) != len(seeds)
    ):
        raise ManifestError("experiment.seeds must contain at least two unique non-negative integers")

    budgets = _expect_object(manifest.get("budgets"), "experiment.budgets")
    if set(budgets) != _BUDGET_FIELDS:
        raise ManifestError(f"experiment.budgets must contain exactly {sorted(_BUDGET_FIELDS)}")
    for field, value in budgets.items():
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value <= 0
        ):
            raise ManifestError(f"experiment.budgets.{field} must be positive")
        if field != "timeout_seconds" and not isinstance(value, int):
            raise ManifestError(f"experiment.budgets.{field} must be an integer")

    context = _expect_object(manifest.get("collection_context"), "experiment.collection_context")
    if set(context) != _CONTEXT_FIELDS:
        raise ManifestError(
            f"experiment.collection_context must contain exactly {sorted(_CONTEXT_FIELDS)}"
        )
    for field in _CONTEXT_FIELDS:
        _require_string(context, field, "experiment.collection_context")
    if context["git_commit"] != commit:
        raise ManifestError("collection_context.git_commit must match experiment.code.git_commit")

    conditions = manifest.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        raise ManifestError("experiment.conditions must be a non-empty list")
    ids: set[str] = set()
    baseline_count = 0
    for index, condition_value in enumerate(conditions):
        condition = _expect_object(condition_value, f"condition[{index}]")
        condition_id = _require_id(condition, "id", f"condition[{index}]")
        if condition_id in ids:
            raise ManifestError(f"duplicate condition id: {condition_id}")
        ids.add(condition_id)
        kind = condition.get("kind")
        if kind not in _ALLOWED_CONDITION_KINDS:
            raise ManifestError(f"condition[{index}].kind is unsupported")
        baseline_count += kind == "baseline"
    if baseline_count != 1:
        raise ManifestError("experiment.conditions must contain exactly one baseline")


def load_experiment(path: Path) -> LoadedExperiment:
    """Load and validate one immutable mock/replay experiment bundle."""

    path = Path(path)
    manifest, manifest_hash = _read_json(path, "experiment")
    _validate_main(manifest)
    base = path.parent
    scenarios, _ = _resolve_ref(base, manifest.get("scenario_manifest"), "scenario_manifest")
    reset, _ = _resolve_ref(base, manifest.get("reset_manifest"), "reset_manifest")
    model, _ = _resolve_ref(base, manifest.get("model_manifest"), "model_manifest")
    observations, _ = _resolve_ref(
        base, manifest.get("observation_manifest"), "observation_manifest"
    )
    case_study, _ = _resolve_ref(
        base, manifest.get("case_study_manifest"), "case_study_manifest"
    )
    _validate_scenarios(scenarios)
    _validate_reset(reset)
    _validate_model(model)
    _validate_observations(observations)
    _validate_case_study(case_study)
    if manifest["collection_context"]["world_snapshot_id"] != reset["world_id"]:
        raise ManifestError(
            "collection_context.world_snapshot_id must match reset_manifest.world_id"
        )
    if manifest["adapter"] == "mock" and model["provider"] != "mock":
        raise ManifestError("mock experiments require a mock model manifest")

    loaded_conditions: list[dict[str, Any]] = []
    for index, condition in enumerate(manifest["conditions"]):
        config, config_hash = _resolve_ref(
            base, condition.get("config"), f"condition[{index}].config"
        )
        _require_schema(config, f"condition[{index}].config")
        if config.get("condition_id") != condition["id"]:
            raise ManifestError(
                f"condition[{index}].config.condition_id must match condition id"
            )
        if config.get("kind") != condition["kind"]:
            raise ManifestError(f"condition[{index}].config.kind must match condition kind")
        loaded = dict(condition)
        loaded["config_data"] = config
        loaded["config_sha256"] = config_hash
        loaded_conditions.append(loaded)

    return LoadedExperiment(
        path=path,
        manifest_sha256=manifest_hash,
        manifest=manifest,
        scenarios=scenarios,
        reset=reset,
        model=model,
        observations=observations,
        case_study=case_study,
        conditions=tuple(loaded_conditions),
    )
