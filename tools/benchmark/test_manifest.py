import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.benchmark.manifest import ManifestError, load_experiment


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write(
            "scenarios.json",
            {
                "schema_version": 1,
                "scenarios": [
                    {
                        "id": "nav",
                        "task": "navigate_to_region",
                        "goal": {
                            "actor": "atlas",
                            "min": [0, 0, 0],
                            "max": [1, 1, 1],
                        },
                    }
                ],
            },
        )
        self.write(
            "reset.json",
            {
                "schema_version": 1,
                "world_id": "fixture-world",
                "world_archive_sha256": "a" * 64,
                "server_version": "fixture-1",
            },
        )
        self.write(
            "model.json",
            {
                "schema_version": 1,
                "provider": "mock",
                "model": "deterministic-fixture",
                "version": "1",
            },
        )
        self.write(
            "baseline.json",
            {
                "schema_version": 1,
                "condition_id": "baseline",
                "kind": "baseline",
                "mode": "independent",
            },
        )
        self.write(
            "case-study.json",
            {
                "schema_version": 1,
                "evidence_class": "synthetic_mock",
                "scenario_id": "nav",
                "seed": 11,
                "before_run_id": "nav-baseline-11",
                "after_run_id": "nav-baseline-22",
                "diagnosed_failure": "fixture failure",
                "simulated_change": "fixture change",
                "claim_limit": "synthetic only",
            },
        )
        self.write("observations.json", {"schema_version": 1, "runs": []})
        self.write(
            "experiment.json",
            {
                "schema_version": 1,
                "benchmark_id": "fixture",
                "adapter": "mock",
                "scenario_manifest": self.ref("scenarios.json"),
                "reset_manifest": self.ref("reset.json"),
                "model_manifest": self.ref("model.json"),
                "observation_manifest": self.ref("observations.json"),
                "case_study_manifest": self.ref("case-study.json"),
                "code": self.evaluator_code(),
                "conditions": [
                    {
                        "id": "baseline",
                        "kind": "baseline",
                        "config": self.ref("baseline.json"),
                    }
                ],
                "seeds": [11, 22],
                "budgets": {
                    "max_steps": 20,
                    "timeout_seconds": 30,
                    "max_provider_requests": 4,
                    "max_input_tokens": 1000,
                    "max_output_tokens": 500,
                },
                "collection_context": {
                    "operation_mode": "evaluation",
                    "trial_id": "fixture-trial",
                    "git_commit": None,
                    "world_snapshot_id": "fixture-world",
                },
            },
        )

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def ref(self, name):
        path = self.root / name
        return {"path": name, "sha256": digest(path)}

    @staticmethod
    def evaluator_code():
        evaluator_root = Path(__file__).resolve().parent
        return {
            "controller": {"kind": "synthetic_fixture", "identity": "unavailable"},
            "evaluator": {
                "kind": "content_sha256",
                "files": [
                    {
                        "path": f"tools/benchmark/{name}",
                        "sha256": digest(evaluator_root / name),
                    }
                    for name in ("manifest.py", "predicates.py", "runner.py")
                ],
            },
        }

    def test_loads_and_resolves_a_fully_pinned_manifest(self):
        loaded = load_experiment(self.root / "experiment.json")
        self.assertEqual(loaded.manifest["adapter"], "mock")
        self.assertEqual(loaded.reset["world_id"], "fixture-world")
        self.assertEqual(loaded.conditions[0]["config_data"]["mode"], "independent")

    def test_synthetic_controller_and_evaluator_sources_are_content_pinned(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["code"] = self.evaluator_code()
        manifest["collection_context"]["git_commit"] = None
        self.write("experiment.json", manifest)

        loaded = load_experiment(self.root / "experiment.json")

        self.assertEqual(loaded.manifest["code"]["controller"]["identity"], "unavailable")
        self.assertEqual(
            {item["path"] for item in loaded.evaluator_files},
            {
                "tools/benchmark/manifest.py",
                "tools/benchmark/predicates.py",
                "tools/benchmark/runner.py",
            },
        )
        self.assertTrue(
            all(item["sha256"] == item["observed_sha256"] for item in loaded.evaluator_files)
        )

    def test_changed_evaluator_source_hash_is_rejected(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["code"] = self.evaluator_code()
        manifest["code"]["evaluator"]["files"][0]["sha256"] = "0" * 64
        manifest["collection_context"]["git_commit"] = None
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "evaluator.*hash mismatch"):
            load_experiment(self.root / "experiment.json")

    def test_synthetic_controller_cannot_carry_a_fake_git_commit(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["code"] = self.evaluator_code()
        manifest["code"]["controller"]["git_commit"] = "0" * 40
        manifest["collection_context"]["git_commit"] = None
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "controller.*exactly"):
            load_experiment(self.root / "experiment.json")

    def test_mock_experiment_cannot_claim_a_controller_commit(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["code"] = self.evaluator_code()
        manifest["code"]["controller"] = {
            "kind": "git_commit",
            "identity": "0" * 40,
        }
        manifest["collection_context"]["git_commit"] = "0" * 40
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "mock.*synthetic"):
            load_experiment(self.root / "experiment.json")

    def test_duplicate_json_keys_are_rejected(self):
        path = self.root / "experiment.json"
        raw = path.read_text()
        path.write_text(
            raw.replace('"schema_version": 1', '"schema_version": 1, "schema_version": 1', 1),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ManifestError, "duplicate JSON key"):
            load_experiment(path)

    def test_nonfinite_json_constants_are_rejected_even_in_unused_fields(self):
        model = self.root / "model.json"
        raw = model.read_text().rstrip()
        model.write_text(raw[:-1] + ', "diagnostic": NaN}\n', encoding="utf-8")
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["model_manifest"] = self.ref("model.json")
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "non-finite JSON constant"):
            load_experiment(self.root / "experiment.json")

    def test_overflowing_json_numbers_are_rejected_even_in_unused_fields(self):
        model = self.root / "model.json"
        raw = model.read_text().rstrip()
        model.write_text(raw[:-1] + ', "diagnostic": 1e400}\n', encoding="utf-8")
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["model_manifest"] = self.ref("model.json")
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "non-finite JSON number"):
            load_experiment(self.root / "experiment.json")

    def test_boolean_schema_version_is_rejected(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["schema_version"] = True
        self.write("experiment.json", manifest)

        with self.assertRaisesRegex(ManifestError, "schema_version"):
            load_experiment(self.root / "experiment.json")

    def test_changed_referenced_bytes_are_rejected(self):
        (self.root / "model.json").write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(ManifestError, "hash mismatch"):
            load_experiment(self.root / "experiment.json")

    def test_unsafe_or_symlink_references_are_rejected(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["model_manifest"]["path"] = "../model.json"
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "relative"):
            load_experiment(self.root / "experiment.json")

        model = self.root / "model.json"
        target = self.root / "actual-model.json"
        model.rename(target)
        model.symlink_to(target.name)
        manifest["model_manifest"] = {"path": "model.json", "sha256": digest(target)}
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "symlink"):
            load_experiment(self.root / "experiment.json")

    def test_rejects_live_adapter_and_incomplete_provenance(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["adapter"] = "live"
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "mock or replay"):
            load_experiment(self.root / "experiment.json")

        manifest["adapter"] = "replay"
        manifest["code"]["controller"] = {"kind": "git_commit", "identity": "1" * 40}
        manifest["collection_context"]["git_commit"] = "1" * 40
        manifest["collection_context"]["operation_mode"] = None
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "collection_context"):
            load_experiment(self.root / "experiment.json")

    def test_condition_config_identity_must_match_its_manifest_entry(self):
        config = json.loads((self.root / "baseline.json").read_text())
        config["condition_id"] = "different"
        self.write("baseline.json", config)
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["conditions"][0]["config"] = self.ref("baseline.json")
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "condition_id"):
            load_experiment(self.root / "experiment.json")

    def test_count_budgets_must_be_integers(self):
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["budgets"]["max_input_tokens"] = 1.5
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "max_input_tokens"):
            load_experiment(self.root / "experiment.json")

    def test_rejects_invalid_reset_and_budget_manifests(self):
        reset = json.loads((self.root / "reset.json").read_text())
        reset["world_archive_sha256"] = "not-a-hash"
        self.write("reset.json", reset)
        manifest = json.loads((self.root / "experiment.json").read_text())
        manifest["reset_manifest"] = self.ref("reset.json")
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "world_archive_sha256"):
            load_experiment(self.root / "experiment.json")

        reset["world_archive_sha256"] = "a" * 64
        self.write("reset.json", reset)
        manifest["reset_manifest"] = self.ref("reset.json")
        manifest["budgets"]["timeout_seconds"] = 0
        self.write("experiment.json", manifest)
        with self.assertRaisesRegex(ManifestError, "timeout_seconds"):
            load_experiment(self.root / "experiment.json")


if __name__ == "__main__":
    unittest.main()
