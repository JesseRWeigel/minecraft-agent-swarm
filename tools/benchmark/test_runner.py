import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tools.benchmark.runner import BenchmarkError, run_benchmark


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tools" / "benchmark" / "fixtures" / "mock-pilot" / "experiment.json"


class RunnerTests(unittest.TestCase):
    def test_iron_pickaxe_replay_requires_independent_craft_and_fresh_inventory(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            experiment_path = root / "experiment.json"
            experiment = json.loads(experiment_path.read_text())
            scenario_path = root / "scenarios.json"
            scenarios = json.loads(scenario_path.read_text())
            scenarios["scenarios"].append({
                "id": "iron-pickaxe",
                "task": "craft_item",
                "goal": {
                    "actor": "atlas",
                    "item": "iron_pickaxe",
                    "recipe": "minecraft:iron_pickaxe",
                    "observer_id": "synthetic-evaluator",
                    "count": 1,
                },
            })
            self.write_json(scenario_path, scenarios)
            observations_path = root / "observations.json"
            observations = json.loads(observations_path.read_text())
            craft = {
                "event_id": "server-craft-1",
                "observer_id": "synthetic-evaluator",
                "actor": "atlas",
                "item": "iron_pickaxe",
                "recipe": "minecraft:iron_pickaxe",
                "count": 1,
            }
            for source in list(observations["runs"]):
                if source["scenario_id"] != "acquire":
                    continue
                row = copy.deepcopy(source)
                row["scenario_id"] = "iron-pickaxe"
                row["run_id"] = f'iron-pickaxe-{row["condition_id"]}-{row["seed"]}'
                row["model_self_report"] = "I crafted the iron pickaxe."
                row["telemetry_complete"] = True
                row["execution_status"] = "completed"
                before = 1 if row["seed"] == 33 else 0
                row["initial_state"] = {"actors": {"atlas": {"inventory": {"iron_pickaxe": before}}}}
                row["final_state"] = {"actors": {"atlas": {"inventory": {"iron_pickaxe": 1}}}}
                if row["seed"] != 44:
                    observer = "participant" if row["seed"] == 22 else craft["observer_id"]
                    row["final_state"]["observed_crafts"] = [dict(craft, observer_id=observer)]
                observations["runs"].append(row)
            self.write_json(observations_path, observations)
            for key, path in (("scenario_manifest", scenario_path), ("observation_manifest", observations_path)):
                experiment[key]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.write_json(experiment_path, experiment)

            report = run_benchmark(experiment_path)
            self.assertEqual(report["evidence_class"], "synthetic_mock")
            self.assertEqual(report["summary"]["trial_count"], 60)
            rows = {r["run_id"]: r for r in report["runs"]}
            for seed, (status, reason) in {
                11: ("completed", "observed_recipe_completion"),
                22: ("failed", "craft_evidence_missing"),
                33: ("invalid_initial", "craft_output_present_at_reset"),
                44: ("missing_telemetry", "predicate_observation_missing"),
            }.items():
                row = rows[f"iron-pickaxe-baseline-{seed}"]
                self.assertEqual((row["status"], row["reason_code"]), (status, reason))
            self.assertEqual(
                rows["iron-pickaxe-baseline-11"]["predicate"]["evidence"]["matching_event_ids"],
                ["server-craft-1"],
            )

    def test_mock_fixture_is_complete_deterministic_and_explicit(self):
        first = run_benchmark(FIXTURE)
        second = run_benchmark(FIXTURE)
        self.assertEqual(first, second)
        self.assertEqual(first["evidence_class"], "synthetic_mock")
        self.assertEqual(len(first["runs"]), 48)
        statuses = {row["status"] for row in first["runs"]}
        self.assertTrue({"completed", "failed", "timed_out", "interrupted", "missing_telemetry"} <= statuses)
        self.assertTrue(all(row["model_self_report"] is not None for row in first["runs"]))
        self.assertEqual(first["summary"]["trial_count"], 48)
        self.assertIn("paired_comparisons", first["summary"])

    def test_paired_coverage_distinguishes_observed_from_unscored_pairs(self):
        report = run_benchmark(FIXTURE)
        rows = {
            (row["condition_id"], row["scenario_id"], row["seed"]): row["status"]
            for row in report["runs"]
        }
        scored = {"completed", "failed", "timed_out"}
        for comparison in report["summary"]["paired_comparisons"]:
            baseline = comparison["baseline_condition"]
            candidate = comparison["candidate_condition"]
            coverage = {
                "both_scored": 0,
                "baseline_only_scored": 0,
                "candidate_only_scored": 0,
                "neither_scored": 0,
            }
            all_deltas, scored_deltas = [], []
            for (condition, scenario, seed), first in rows.items():
                if condition != baseline:
                    continue
                second = rows[candidate, scenario, seed]
                delta = int(second == "completed") - int(first == "completed")
                all_deltas.append(delta)
                if first in scored and second in scored:
                    category = "both_scored"
                    scored_deltas.append(delta)
                elif first in scored:
                    category = "baseline_only_scored"
                elif second in scored:
                    category = "candidate_only_scored"
                else:
                    category = "neither_scored"
                coverage[category] += 1
            self.assertGreater(coverage["both_scored"], 0)
            self.assertGreater(sum(coverage.values()) - coverage["both_scored"], 0)
            self.assertEqual(comparison["pair_coverage"], coverage)
            self.assertEqual(comparison["pair_count"], sum(coverage.values()))
            self.assertEqual(comparison["mean_paired_completion_delta"],
                             round(sum(all_deltas) / len(all_deltas), 6))
            self.assertEqual(comparison["scored_pair_completion_delta"],
                             round(sum(scored_deltas) / len(scored_deltas), 6))

    def test_paired_coverage_is_explicit_when_no_pair_can_be_scored(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations_path = root / "observations.json"
            observations = json.loads(observations_path.read_text())
            for row in observations["runs"]:
                if row["condition_id"] == "coaching":
                    row["telemetry_complete"] = False
            self.write_json(observations_path, observations)
            self.rehash_observations(root)
            report = run_benchmark(root / "experiment.json")
            comparison = next(
                item for item in report["summary"]["paired_comparisons"]
                if item["candidate_condition"] == "coaching"
            )
            self.assertEqual(comparison["pair_count"], 16)
            self.assertEqual(comparison["pair_coverage"], {
                "both_scored": 0,
                "baseline_only_scored": 14,
                "candidate_only_scored": 0,
                "neither_scored": 2,
            })
            self.assertIsNone(comparison["scored_pair_completion_delta"])
            self.assertEqual(comparison["wins"], 0)
            self.assertLess(comparison["mean_paired_completion_delta"], 0)

    def test_task_breakdown_preserves_failed_and_unverified_trials(self):
        report = run_benchmark(FIXTURE)
        rows = report["runs"]
        groups = report["summary"]["condition_scenario"]
        combinations = {(row["condition_id"], row["scenario_id"]) for row in rows}
        self.assertEqual(len(groups), len(combinations))
        self.assertEqual(
            {(group["condition_id"], group["scenario_id"]) for group in groups},
            combinations,
        )
        self.assertEqual(sum(group["trials"] for group in groups), len(rows))
        for group in groups:
            matching = [
                row for row in rows
                if (row["condition_id"], row["scenario_id"]) ==
                (group["condition_id"], group["scenario_id"])
            ]
            expected = {
                status: sum(row["status"] == status for row in matching)
                for status in {row["status"] for row in matching}
            }
            self.assertEqual(group["status_counts"], expected)
            scored = sum(expected.get(status, 0) for status in ("completed", "failed", "timed_out"))
            self.assertEqual(group["scored_trials"], scored)
            self.assertEqual(group["trials"], len(matching))
            self.assertEqual(group["completed"], expected.get("completed", 0))
            self.assertEqual(
                group["scored_completion_rate"],
                round(group["completed"] / scored, 6) if scored else None,
            )
            self.assertEqual(
                group["completion_rate"], round(group["completed"] / group["trials"], 6)
            )

    def test_task_breakdown_does_not_fabricate_rate_when_nothing_scored(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations_path = root / "observations.json"
            observations = json.loads(observations_path.read_text())
            for row in observations["runs"]:
                if row["scenario_id"] == "acquire" and row["condition_id"] == "baseline":
                    row["telemetry_complete"] = False
            self.write_json(observations_path, observations)
            experiment_path = root / "experiment.json"
            experiment = json.loads(experiment_path.read_text())
            experiment["observation_manifest"]["sha256"] = hashlib.sha256(
                observations_path.read_bytes()
            ).hexdigest()
            self.write_json(experiment_path, experiment)
            report = run_benchmark(root / "experiment.json")
            group = next(
                group for group in report["summary"]["condition_scenario"]
                if group["scenario_id"] == "acquire" and group["condition_id"] == "baseline"
            )
            self.assertEqual(group["trials"], 4)
            self.assertEqual(group["scored_trials"], 0)
            self.assertEqual(group["status_counts"], {"missing_telemetry": 4})
            self.assertEqual(group["completion_rate"], 0.0)
            self.assertIsNone(group["scored_completion_rate"])

    def test_report_records_checked_evaluator_fingerprints_without_fake_controller_commit(self):
        report = run_benchmark(FIXTURE)
        code = report["provenance"]["code"]
        self.assertEqual(
            code["controller"],
            {"kind": "synthetic_fixture", "identity": "unavailable"},
        )
        self.assertNotIn("git_commit", code["controller"])
        self.assertEqual(len(code["evaluator"]["files"]), 3)
        self.assertTrue(
            all(
                item["sha256"] == item["observed_sha256"]
                for item in code["evaluator"]["files"]
            )
        )

    def test_contradictory_self_report_cannot_make_a_failed_predicate_pass(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "navigate-baseline-11")
        self.assertEqual(row["model_self_report"], "I reached the target.")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["reason_code"], "predicate_not_met")

    def test_foreign_item_negative_control_does_not_count_as_handoff(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "handoff-baseline-11")
        self.assertEqual(row["model_self_report"], "Transferred the iron.")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["reason_code"], "transfer_evidence_missing")

    def test_recovery_negative_self_report_cannot_replace_observed_attempt(self):
        report = run_benchmark(FIXTURE)
        matches = [
            item for item in report["runs"] if item["run_id"] == "recover-baseline-11"
        ]
        self.assertEqual(len(matches), 1)
        row = matches[0]
        self.assertEqual(row["model_self_report"], "I recovered from the obstruction.")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["reason_code"], "recovery_attempt_not_observed")

    def test_recovery_report_exposes_independent_timing_and_outcome_evidence(self):
        report = run_benchmark(FIXTURE)
        row = next(
            item
            for item in report["runs"]
            if item["run_id"] == "recover-coordination-11"
        )
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["reason_code"], "observed_recovery_after_injection")
        evidence = row["predicate"]["evidence"]
        self.assertEqual(evidence["injection_kind"], "path_obstruction")
        self.assertEqual(evidence["injection_step"], 3)
        self.assertEqual(evidence["injection_outcome"], "interrupted")
        self.assertEqual(evidence["recovery_outcome"], "recovered")
        self.assertLessEqual(evidence["recovery_latency_ms"], 5000)

    def test_recovery_failed_outcome_and_excess_latency_remain_failures(self):
        report = run_benchmark(FIXTURE)
        by_id = {item["run_id"]: item for item in report["runs"]}
        self.assertEqual(
            (
                by_id["recover-baseline-22"]["status"],
                by_id["recover-baseline-22"]["reason_code"],
            ),
            ("failed", "recovery_outcome_not_met"),
        )
        self.assertEqual(
            (
                by_id["recover-baseline-33"]["status"],
                by_id["recover-baseline-33"]["reason_code"],
            ),
            ("failed", "recovery_latency_exceeded"),
        )

    def test_case_study_links_a_paired_synthetic_failure_and_fix(self):
        report = run_benchmark(FIXTURE)
        case = report["case_study"]
        self.assertEqual(case["evidence_class"], "synthetic_mock")
        self.assertEqual(case["before"]["status"], "failed")
        self.assertEqual(case["after"]["status"], "completed")
        self.assertEqual(case["before"]["scenario_id"], case["after"]["scenario_id"])
        self.assertEqual(case["before"]["seed"], case["after"]["seed"])

    def test_case_study_requires_an_observed_baseline_failure(self):
        cases = (
            ("navigate", 22, "missing_telemetry"),
            ("handoff", 22, "invalid_initial"),
            ("navigate", 11, "interrupted"),
            ("acquire", 33, "timed_out"),
        )
        for scenario, seed, status in cases:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as raw:
                root = Path(raw)
                self.copy_fixture(root)
                if status == "interrupted":
                    path = root / "observations.json"
                    observations = json.loads(path.read_text())
                    baseline = next(
                        row for row in observations["runs"]
                        if row["run_id"] == "navigate-baseline-11"
                    )
                    baseline["execution_status"] = "cancelled"
                    self.write_json(path, observations)
                    self.rehash_observations(root)
                path = root / "case-study.json"
                case = json.loads(path.read_text())
                case.update(
                    scenario_id=scenario,
                    seed=seed,
                    before_run_id=f"{scenario}-baseline-{seed}",
                    after_run_id=f"{scenario}-coordination-{seed}",
                )
                self.write_json(path, case)
                experiment_path = root / "experiment.json"
                experiment = json.loads(experiment_path.read_text())
                experiment["case_study_manifest"]["sha256"] = hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                self.write_json(experiment_path, experiment)
                if status == "timed_out":
                    report = run_benchmark(experiment_path)
                    self.assertEqual(report["case_study"]["before"]["status"], status)
                    self.assertEqual(report["case_study"]["after"]["status"], "completed")
                else:
                    with self.assertRaisesRegex(BenchmarkError, status):
                        run_benchmark(experiment_path)

    def test_missing_telemetry_and_terminal_status_take_precedence(self):
        report = run_benchmark(FIXTURE)
        missing = next(item for item in report["runs"] if item["run_id"] == "acquire-coaching-22")
        timed_out = next(item for item in report["runs"] if item["run_id"] == "acquire-baseline-33")
        interrupted = next(item for item in report["runs"] if item["run_id"] == "handoff-coordination-44")
        self.assertEqual((missing["status"], missing["reason_code"]), ("missing_telemetry", "telemetry_incomplete"))
        self.assertEqual(timed_out["status"], "timed_out")
        self.assertEqual(interrupted["status"], "interrupted")

    def test_already_met_goal_is_invalid_even_when_final_state_matches(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "handoff-baseline-22")
        self.assertEqual(row["status"], "invalid_initial")
        self.assertEqual(row["reason_code"], "goal_already_met")

    def test_unknown_metrics_remain_unknown_in_rows_and_summary(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "navigate-baseline-11")
        self.assertEqual(row["metrics"]["inference"]["input_tokens"], 0)
        self.assertIsNone(row["metrics"]["engineering"]["labor_time_minutes"])
        self.assertIsNone(row["metrics"]["inference"]["estimated_cost_usd"])
        baseline = next(item for item in report["summary"]["conditions"] if item["condition_id"] == "baseline")
        self.assertGreater(baseline["metrics"]["inference"]["input_tokens"]["missing"], 0)
        self.assertIsNone(baseline["metrics"]["inference"]["estimated_cost_usd"]["mean"])

    def test_rejects_unrecognized_metric_groups_instead_of_dropping_measurements(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            path = root / "observations.json"
            observations = json.loads(path.read_text())
            observations["runs"][0]["metrics"]["runtime_resource"] = {"peak_rss_bytes": 64}
            self.write_json(path, observations)
            self.rehash_observations(root)

            with self.assertRaisesRegex(BenchmarkError, r"run\.metrics has unknown groups: .*runtime_resource"):
                run_benchmark(root / "experiment.json")

    def test_report_mean_stays_finite_when_valid_measurements_overflow_their_sum(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            path = root / "observations.json"
            observations = json.loads(path.read_text())
            baseline_rows = [row for row in observations["runs"] if row["condition_id"] == "baseline"]
            for row in baseline_rows[:2]:
                row.setdefault("metrics", {}).setdefault("engineering", {})[
                    "infrastructure_cost_usd"
                ] = 1e308
            self.write_json(path, observations)
            self.rehash_observations(root)

            report = run_benchmark(root / "experiment.json")
            # The report should be usable by standard JSON parsers, not just
            # Python's permissive decoder of Infinity and NaN.
            json.dumps(report, allow_nan=False)
            baseline = next(row for row in report["summary"]["conditions"] if row["condition_id"] == "baseline")
            metric = baseline["metrics"]["engineering"]["infrastructure_cost_usd"]
            self.assertEqual(metric, {"known": 2, "missing": len(baseline_rows) - 2, "mean": 1e308})

    def test_paired_comparison_uses_matching_scenario_seed_units(self):
        report = run_benchmark(FIXTURE)
        comparison = next(
            item
            for item in report["summary"]["paired_comparisons"]
            if item["candidate_condition"] == "coordination"
        )
        self.assertEqual(comparison["baseline_condition"], "baseline")
        self.assertEqual(comparison["pair_count"], 16)
        self.assertEqual(
            comparison["wins"] + comparison["losses"] + comparison["ties"],
            comparison["pair_count"],
        )
        self.assertEqual(comparison["uncertainty"]["method"], "paired_bootstrap_percentile")

    def test_missing_enforced_metric_makes_budget_unverifiable(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "navigate-baseline-22")
        self.assertEqual(row["status"], "missing_telemetry")
        self.assertEqual(row["reason_code"], "budget_measurement_missing")
        self.assertIsNone(row["metrics"]["inference"]["input_tokens"])

    def test_missing_predicate_observation_is_missing_telemetry(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations = json.loads((root / "observations.json").read_text())
            target = next(row for row in observations["runs"] if row["run_id"] == "navigate-baseline-33")
            del target["final_state"]["actors"]["atlas"]["dimension"]
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            report = run_benchmark(root / "experiment.json")
            row = next(item for item in report["runs"] if item["run_id"] == "navigate-baseline-33")
            self.assertEqual(row["status"], "missing_telemetry")
            self.assertEqual(row["reason_code"], "predicate_observation_missing")

    def test_recovery_cannot_score_an_injection_beyond_the_reported_steps(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations_path = root / "observations.json"
            observations = json.loads(observations_path.read_text())
            impossible = "recover-coordination-11"
            exact_boundary = "recover-coordination-22"
            for run in observations["runs"]:
                if run["run_id"] == impossible:
                    run["steps"] = 2
                elif run["run_id"] == exact_boundary:
                    run["steps"] = 3
            self.write_json(observations_path, observations)
            self.rehash_observations(root)

            report = run_benchmark(root / "experiment.json")
            rows = {row["run_id"]: row for row in report["runs"]}
            self.assertEqual(
                (rows[impossible]["status"], rows[impossible]["reason_code"]),
                ("missing_telemetry", "recovery_injection_beyond_reported_steps"),
            )
            self.assertEqual(rows[exact_boundary]["status"], "completed")
            summary = next(
                row for row in report["summary"]["condition_scenario"]
                if row["condition_id"] == "coordination" and row["scenario_id"] == "recover"
            )
            self.assertEqual((summary["trials"], summary["scored_trials"], summary["completed"]),
                             (4, 3, 3))

    def test_recovery_latency_cannot_exceed_entire_trial_duration(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            path = root / "observations.json"
            observations = json.loads(path.read_text())
            too_short = "recover-coordination-11"
            boundary = "recover-coordination-22"
            for row in observations["runs"]:
                duration = {too_short: 2199, boundary: 2200}.get(row["run_id"])
                if duration is not None:
                    row["metrics"]["runtime_resources"]["wall_time_ms"] = duration
            self.write_json(path, observations)
            self.rehash_observations(root)

            report = run_benchmark(root / "experiment.json")
            rows = {row["run_id"]: row for row in report["runs"]}
            self.assertEqual(
                (rows[too_short]["status"], rows[too_short]["reason_code"]),
                ("missing_telemetry", "recovery_latency_beyond_trial_duration"),
            )
            self.assertEqual(rows[boundary]["status"], "completed")

    def test_malformed_steps_are_rejected_even_on_a_timed_out_run(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations = json.loads((root / "observations.json").read_text())
            target = next(row for row in observations["runs"] if row["run_id"] == "acquire-baseline-33")
            target["steps"] = "unknown"
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            with self.assertRaisesRegex(BenchmarkError, "steps"):
                run_benchmark(root / "experiment.json")

    def test_fractional_token_measurements_are_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations = json.loads((root / "observations.json").read_text())
            observations["runs"][0]["metrics"]["inference"]["input_tokens"] = 1.5
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            with self.assertRaisesRegex(BenchmarkError, "input_tokens"):
                run_benchmark(root / "experiment.json")

    def test_budget_overrun_is_not_counted_as_completion(self):
        report = run_benchmark(FIXTURE)
        row = next(item for item in report["runs"] if item["run_id"] == "navigate-coaching-44")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["reason_code"], "provider_request_budget_exceeded")

    def test_replay_mode_is_labeled_as_observation_replay(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            experiment = json.loads((root / "experiment.json").read_text())
            experiment["adapter"] = "replay"
            experiment["code"]["controller"] = {
                "kind": "git_commit",
                "identity": "1" * 40,
            }
            experiment["collection_context"]["git_commit"] = "1" * 40
            self.write_json(root / "experiment.json", experiment)
            report = run_benchmark(root / "experiment.json")
            self.assertEqual(report["evidence_class"], "replay_observations")
            self.assertFalse(report["claims_live_minecraft_outcomes"])

    def test_exact_matrix_rejects_missing_or_duplicate_runs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            self.copy_fixture(root)
            observations = json.loads((root / "observations.json").read_text())
            observations["runs"].pop()
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            with self.assertRaisesRegex(BenchmarkError, "missing run"):
                run_benchmark(root / "experiment.json")

            observations["runs"].append(copy.deepcopy(observations["runs"][0]))
            observations["runs"].append(copy.deepcopy(observations["runs"][0]))
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            with self.assertRaisesRegex(BenchmarkError, "duplicate run"):
                run_benchmark(root / "experiment.json")

    def test_cli_validates_and_writes_report_without_live_commands(self):
        with tempfile.TemporaryDirectory() as raw:
            output = Path(raw) / "report.json"
            command = [
                sys.executable,
                "-m",
                "tools.benchmark.runner",
                "run",
                "--manifest",
                str(FIXTURE),
                "--output",
                str(output),
            ]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["evidence_class"], "synthetic_mock")
            validate = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "tools.benchmark.runner",
                    "validate",
                    "--manifest",
                    str(FIXTURE),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(validate.returncode, 0, validate.stderr)
            self.assertIn("validated", validate.stdout)

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    def copy_fixture(self, destination):
        source = FIXTURE.parent
        for path in source.iterdir():
            if path.is_file():
                (destination / path.name).write_bytes(path.read_bytes())

    def rehash_observations(self, root):
        experiment = json.loads((root / "experiment.json").read_text())
        experiment["observation_manifest"]["sha256"] = hashlib.sha256(
            (root / "observations.json").read_bytes()
        ).hexdigest()
        self.write_json(root / "experiment.json", experiment)


if __name__ == "__main__":
    unittest.main()
