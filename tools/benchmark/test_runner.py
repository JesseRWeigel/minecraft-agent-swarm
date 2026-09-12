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
    def test_mock_fixture_is_complete_deterministic_and_explicit(self):
        first = run_benchmark(FIXTURE)
        second = run_benchmark(FIXTURE)
        self.assertEqual(first, second)
        self.assertEqual(first["evidence_class"], "synthetic_mock")
        self.assertEqual(len(first["runs"]), 36)
        statuses = {row["status"] for row in first["runs"]}
        self.assertTrue({"completed", "failed", "timed_out", "interrupted", "missing_telemetry"} <= statuses)
        self.assertTrue(all(row["model_self_report"] is not None for row in first["runs"]))
        self.assertEqual(first["summary"]["trial_count"], 36)
        self.assertIn("paired_comparisons", first["summary"])

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

    def test_case_study_links_a_paired_synthetic_failure_and_fix(self):
        report = run_benchmark(FIXTURE)
        case = report["case_study"]
        self.assertEqual(case["evidence_class"], "synthetic_mock")
        self.assertEqual(case["before"]["status"], "failed")
        self.assertEqual(case["after"]["status"], "completed")
        self.assertEqual(case["before"]["scenario_id"], case["after"]["scenario_id"])
        self.assertEqual(case["before"]["seed"], case["after"]["seed"])

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

    def test_paired_comparison_uses_matching_scenario_seed_units(self):
        report = run_benchmark(FIXTURE)
        comparison = next(
            item
            for item in report["summary"]["paired_comparisons"]
            if item["candidate_condition"] == "coordination"
        )
        self.assertEqual(comparison["baseline_condition"], "baseline")
        self.assertEqual(comparison["pair_count"], 12)
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
            target = next(row for row in observations["runs"] if row["run_id"] == "navigate-baseline-11")
            del target["final_state"]["actors"]["atlas"]["dimension"]
            self.write_json(root / "observations.json", observations)
            self.rehash_observations(root)
            report = run_benchmark(root / "experiment.json")
            row = next(item for item in report["runs"] if item["run_id"] == "navigate-baseline-11")
            self.assertEqual(row["status"], "missing_telemetry")
            self.assertEqual(row["reason_code"], "predicate_observation_missing")

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
