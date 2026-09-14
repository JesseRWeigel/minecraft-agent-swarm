"""Strictly synthetic qualification of the prospective pilot lifecycle.

No Minecraft server, network client, external provider, or executable hook exists here.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import random
import re
import tempfile
import sys
import tarfile

from tools.benchmark.predicates import evaluate_goal, PredicateError
from tools.pilot import prepare as prep
from tools.pilot.budgets import BudgetLimits, BudgetTracker, BudgetExceeded
from tools.pilot.smoke_fixture import FAKE_IDENTITY, create_fixture

MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_CASES = 128
MAX_STEPS = 256


class SmokeError(ValueError):
    """Inputs cannot qualify for the synthetic-only controller."""


def _json(raw, label):
    return prep._parse_json(prep.CapturedFile(Path(label), raw, hashlib.sha256(raw).hexdigest()), label)


def _relative(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise SmokeError("invalid relative path")
    parts = value.split("/")
    if any(p in {"", ".", ".."} for p in parts) or PurePosixPath(value).is_absolute():
        raise SmokeError("invalid relative path")
    return value


def _write(path, value, root):
    prep._write_private(path, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode(), root)


def _position(state, actor):
    return [state["actors"][actor]["position"][axis] for axis in "xyz"]


def _validate_state(state):
    if set(state) != {"schema_version", "synthetic", "actors"} or type(state["schema_version"]) is not int or state["schema_version"] != 1 or state["synthetic"] is not True:
        raise SmokeError("world fixture must be schema 1 and synthetic")
    actors = state["actors"]
    if not isinstance(actors, dict) or not 1 <= len(actors) <= 8:
        raise SmokeError("fixture must contain 1 to 8 actors")
    for name, actor in actors.items():
        if not re.fullmatch(r"[A-Za-z0-9_]{1,16}", name) or not isinstance(actor, dict) or set(actor) != {"position", "dimension"}:
            raise SmokeError("invalid fixture actor")
        pos = actor["position"]
        if not isinstance(pos, dict) or set(pos) != set("xyz") or any(type(v) is not int or abs(v) > 10000 for v in pos.values()):
            raise SmokeError("fixture positions must be bounded integer coordinates")
        if actor["dimension"] not in {"minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"}:
            raise SmokeError("unsupported fixture dimension")


def _load(prepared, pin):
    if not isinstance(pin, str) or not re.fullmatch(r"[0-9a-f]{64}", pin):
        raise SmokeError("manifest pin must be SHA-256")
    prep._reject_symlink_components(prepared, "prepared directory")
    captured = prep._capture_file(prepared / "manifest.json", "prepared manifest", MAX_FILE_BYTES)
    if captured.sha256 != pin:
        raise SmokeError("prepared manifest hash mismatch")
    manifest = _json(captured.raw, "prepared manifest")
    required = {"schema_version", "status", "live_ready", "reset_performed", "claim_limit", "source", "snapshot", "archive_scan", "storage_preflight", "runtime_identity_sha256", "copied_files"}
    if set(manifest) != required or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1 or manifest["status"] != "prepared_not_run" or manifest["live_ready"] is not False or manifest["reset_performed"] is not False:
        raise SmokeError("invalid prepared manifest contract")
    entries = manifest["copied_files"]
    if not isinstance(entries, list) or not 7 <= len(entries) <= 40:
        raise SmokeError("invalid copied file count")
    files = {}; total = len(captured.raw)
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes"}:
            raise SmokeError("invalid copied file record")
        name = _relative(entry["path"])
        if name in files or name == "manifest.json" or type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= MAX_FILE_BYTES:
            raise SmokeError("duplicate or oversized copied file")
        if not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise SmokeError("invalid copied hash")
        item = prep._capture_file(prepared / name, name, MAX_FILE_BYTES)
        if item.sha256 != entry["sha256"] or len(item.raw) != entry["bytes"]:
            raise SmokeError("copied file hash or size mismatch")
        total += len(item.raw)
        if total > MAX_TOTAL_BYTES:
            raise SmokeError("prepared fixture exceeds aggregate limit")
        files[name] = item.raw
    # Reject unexpected files and all symlinks, without following linked directories.
    seen = set(); count = 0
    for directory, dirs, names in os.walk(prepared, followlinks=False):
        count += len(dirs) + len(names)
        if count > 256:
            raise SmokeError("prepared tree exceeds entry limit")
        for name in dirs + names:
            if (Path(directory) / name).is_symlink():
                raise SmokeError("prepared tree contains a symlink")
        seen.update((Path(directory) / name).relative_to(prepared).as_posix() for name in names)
    if seen != set(files) | {"manifest.json"}:
        raise SmokeError("prepared tree has unlisted or missing files")
    if "plan/plan.json" not in files or "runtime-identity.json" not in files:
        raise SmokeError("required prepared input missing")
    # Revalidate captured bytes, never reopen mutable original inputs for execution.
    with tempfile.TemporaryDirectory(prefix="pilot-verify-") as temporary:
        private = Path(temporary)
        for name, raw in files.items():
            prep._write_private(private / name, raw, private)
        loaded = prep._load_plan(private / "plan" / "plan.json")
        identity = prep._load_identity(private / "runtime-identity.json", loaded)
    if loaded.model != FAKE_IDENTITY or loaded.snapshot["synthetic"] is not True or loaded.snapshot["archive_format"] != "tar" or loaded.reset["reset_procedure"] != "synthetic_fixture":
        raise SmokeError("only built-in fake provider and synthetic uncompressed tar fixtures are supported")
    expected_source = {"kind": loaded.plan["kind"], "plan_id": loaded.plan["plan_id"], "plan_sha256": loaded.plan_file.sha256, "code_source_identity": loaded.plan["code"]["source_identity"]}
    if manifest["source"] != expected_source or manifest["runtime_identity_sha256"] != identity.sha256:
        raise SmokeError("prepared identity disagrees with captured inputs")
    snapshot = manifest["snapshot"]
    if not isinstance(snapshot, dict) or set(snapshot) != {"path", "sha256", "bytes", "synthetic", "world_id", "server_version"} or snapshot["synthetic"] is not True:
        raise SmokeError("invalid synthetic snapshot summary")
    archive_path = _relative(snapshot["path"])
    if not archive_path.startswith("inputs/") or not archive_path.endswith(".tar") or archive_path not in files:
        raise SmokeError("invalid snapshot archive path")
    archive = files[archive_path]
    if snapshot["sha256"] != loaded.snapshot["archive_sha256"] or snapshot["sha256"] != hashlib.sha256(archive).hexdigest() or type(snapshot["bytes"]) is not int or snapshot["bytes"] != len(archive) or snapshot["world_id"] != loaded.reset["world_id"] or snapshot["server_version"] != loaded.reset["server_version"]:
        raise SmokeError("snapshot summary disagrees with captured inputs")
    required_files = {"plan/plan.json", "runtime-identity.json", archive_path}
    for key in ("snapshot_manifest", "reset_manifest", "model_manifest", "scenario_manifest"):
        required_files.add("plan/" + _relative(loaded.plan[key]["path"]))
    required_files.update("plan/" + _relative(c["config"]["path"]) for c in loaded.plan["conditions"])
    if set(files) != required_files:
        raise SmokeError("copied file set does not match prospective plan")
    scan = prep._scan_tar_stream(io.BytesIO(archive), 1, 65536)
    if scan != manifest["archive_scan"] or scan["regular_file_count"] != 1:
        raise SmokeError("archive scan disagrees with prepared manifest")
    header = tarfile.TarInfo.frombuf(archive[:512], "utf-8", "strict")
    if header.name != "world/state.json" or header.type not in {tarfile.REGTYPE, tarfile.AREGTYPE}:
        raise SmokeError("only world/state.json may be restored")
    raw_state = archive[512:512 + header.size]
    state = _json(raw_state, "world fixture"); _validate_state(state)
    scenarios = loaded.scenarios["scenarios"]
    cases = len(loaded.plan["seeds"]) * len(loaded.plan["conditions"]) * len(scenarios)
    if cases > MAX_CASES or loaded.plan["budgets"]["max_steps"] > MAX_STEPS:
        raise SmokeError("synthetic smoke case/step bound exceeded")
    for scenario in scenarios:
        if set(scenario) != {"id", "task", "goal"} or scenario["task"] != "navigate_to_region":
            raise SmokeError("smoke supports navigation only")
        goal = scenario["goal"]
        if set(goal) != {"actor", "dimension", "min", "max"} or goal["actor"] not in state["actors"]:
            raise SmokeError("invalid navigation goal")
        result = evaluate_goal(scenario, state, state)
        if result.reason in {"goal_already_met", "missing_observation"}:
            raise SmokeError("navigation fixture must have an unmet observable goal")
        if any(type(v) is not int or abs(v) > 10000 for v in goal["min"] + goal["max"]):
            raise SmokeError("navigation bounds must be bounded integers")
    for config in loaded.configs.values():
        if set(config) != {"schema_version", "condition_id", "kind", "fake_behavior"} or config["fake_behavior"] not in {"move_to_goal", "claim_only", "fail"}:
            raise SmokeError("unsupported fake condition")
    return loaded, state, files, snapshot["sha256"]


def _fake_step(state, scenario, behavior, rng):
    if behavior == "fail":
        raise RuntimeError("synthetic provider failure")
    if behavior == "claim_only":
        return "I completed the task"  # Deliberately ignored by the predicate.
    actor = state["actors"][scenario["goal"]["actor"]]
    axes = list(range(3)); rng.shuffle(axes)
    for index in axes:
        axis = "xyz"[index]; value = actor["position"][axis]
        low, high = scenario["goal"]["min"][index], scenario["goal"]["max"][index]
        if value < low:
            actor["position"][axis] += 1; break
        if value > high:
            actor["position"][axis] -= 1; break
    return "synthetic action"


def run(prepared: Path, manifest_sha256: str, output: Path):
    prepared, output = Path(prepared), Path(output)
    try:
        loaded, initial, files, archive_hash = _load(prepared, manifest_sha256)
        prep._validate_destination(output, [prepared])
        limits = BudgetLimits.from_dict(loaded.plan["budgets"])
        prep._mkdir_private(output)
        # Preserve partial evidence on unexpected failure; never recursively delete.
        _write(output / "started.json", {"schema_version": 1, "synthetic": True, "prepared_manifest_sha256": manifest_sha256}, output)
        results = []
        for seed in loaded.plan["seeds"]:
            for condition in loaded.plan["conditions"]:
                for scenario in loaded.scenarios["scenarios"]:
                    case_id = f"case-{len(results):04d}"
                    case_dir = output / "cases" / case_id
                    state = copy.deepcopy(initial)
                    _write(case_dir / "initial-state.json", state, output)
                    tracker = BudgetTracker(limits); events = []
                    rng = random.Random(seed)
                    behavior = loaded.configs[condition["id"]]["fake_behavior"]
                    outcome = "budget_exhausted"; reason = "unknown"
                    while True:
                        try:
                            tracker.consume_step()
                            tracker.reserve_request(1, 1)
                        except BudgetExceeded as exc:
                            reason = str(exc); break
                        try:
                            _fake_step(state, scenario, behavior, rng)
                        except RuntimeError:
                            outcome = "provider_error"; reason = "synthetic_provider_failure"; break
                        try:
                            tracker.finish_request(1)
                        except BudgetExceeded as exc:
                            reason = str(exc); break
                        observed = evaluate_goal(scenario, initial, state)
                        events.append({"step": len(events) + 1, "position": _position(state, scenario["goal"]["actor"]), "predicate_passed": observed.passed, "predicate_reason": observed.reason})
                        if observed.passed:
                            outcome = "succeeded"; reason = observed.reason; break
                    final_predicate = evaluate_goal(scenario, initial, state)
                    result = {"case_id": case_id, "seed": seed, "condition_id": condition["id"], "scenario_id": scenario["id"], "outcome": outcome, "reason": reason, "synthetic": True, "evidence_class": "synthetic_offline", "live_benchmark": False, "reset_kind": "fresh_synthetic_state_copy", "snapshot_sha256": archive_hash, "initial_position": _position(initial, scenario["goal"]["actor"]), "final_position": _position(state, scenario["goal"]["actor"]), "predicate": {"passed": final_predicate.passed, "reason": final_predicate.reason, "evidence": final_predicate.evidence}, "usage": tracker.snapshot(), "usage_basis": "fixed fake accounting units; not model token measurements", "events": events}
                    _write(case_dir / "final-state.json", state, output)
                    _write(case_dir / "result.json", result, output)
                    results.append(result)
        source_hashes = {}
        for module_path in [Path(__file__), Path(__file__).with_name("budgets.py"), Path(prep.__file__), Path(__file__).parents[1] / "benchmark" / "predicates.py"]:
            source_hashes[module_path.name] = prep._capture_file(module_path, "controller source", MAX_FILE_BYTES).sha256
        report = {"execution_source_hashes": source_hashes, "source_identity_note": "Prepared plan commit is a declaration; execution files are separately fingerprinted, not verified against that commit.", "schema_version": 1, "status": "synthetic_smoke_completed", "synthetic": True, "live_benchmark": False, "server_started": False, "provider": FAKE_IDENTITY, "prepared_manifest_sha256": manifest_sha256, "claim_limit": "Offline fixture qualification only. No Minecraft server, real model, measured token cost, or coordination advantage.", "cases": results}
        _write(output / "report.json", report, output)
        return report
    except (prep.PreparationError, PredicateError, OSError, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, SmokeError):
            raise
        raise SmokeError(str(exc)) from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("run")
    command.add_argument("--prepared", type=Path, required=True)
    command.add_argument("--manifest-sha256", required=True)
    command.add_argument("--output", type=Path, required=True)
    demo = sub.add_parser("demo")
    demo.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "demo":
            prepared = create_fixture(args.output)
            pin = prep._capture_file(prepared / "manifest.json", "manifest", MAX_FILE_BYTES).sha256
            report = run(prepared, pin, args.output / "smoke-run")
            report_path = args.output / "smoke-run" / "report.json"
        else:
            report = run(args.prepared, args.manifest_sha256, args.output)
            report_path = args.output / "report.json"
    except (SmokeError, prep.PreparationError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2
    print(json.dumps({"status": report["status"], "live_benchmark": False, "case_count": len(report["cases"]), "report": str(report_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
