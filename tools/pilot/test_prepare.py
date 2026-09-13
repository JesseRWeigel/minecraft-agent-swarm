import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

from tools.pilot.prepare import PreparationError, prepare


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(64 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        shutil.copytree(
            REPOSITORY_ROOT / "tools" / "benchmark" / "fixtures" / "mock-pilot",
            self.bundle,
        )
        self.archive = self.root / "world.tar"
        self._write_archive(self.archive, [("ai-world/level.dat", b"frozen-world")])
        self._make_replay_bundle()
        self.identity = self.root / "runtime.json"
        experiment = self._read("experiment.json")
        self.identity.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "provider": "fixture-provider",
                    "model": "fixture-model",
                    "version": "2026-09-13",
                    "conditions": {
                        condition["id"]: condition["config"]["sha256"]
                        for condition in experiment["conditions"]
                    },
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        self.output = self.root / "prepared"

    def _read(self, name):
        return json.loads((self.bundle / name).read_text(encoding="utf-8"))

    def _write(self, name, value):
        path = self.bundle / name
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    @staticmethod
    def _write_archive(path, members):
        with tarfile.open(path, "w") as archive:
            for name, content in members:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))

    def _make_replay_bundle(self):
        model = self._read("model.json")
        model.update(provider="fixture-provider", model="fixture-model", version="2026-09-13")
        model.pop("inference_billing", None)
        self._write("model.json", model)
        reset = self._read("reset.json")
        reset["world_archive_sha256"] = digest(self.archive)
        reset.pop("synthetic", None)
        self._write("reset.json", reset)
        experiment = self._read("experiment.json")
        experiment["adapter"] = "replay"
        commit = "1" * 40
        experiment["code"]["controller"] = {"kind": "git_commit", "identity": commit}
        experiment["collection_context"]["git_commit"] = commit
        experiment["collection_context"]["operation_mode"] = "historical_replay"
        experiment["model_manifest"]["sha256"] = digest(self.bundle / "model.json")
        experiment["reset_manifest"]["sha256"] = digest(self.bundle / "reset.json")
        self._write("experiment.json", experiment)

    def test_prepares_verified_replay_inputs_without_running_a_trial(self):
        manifest = prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)
        self.assertEqual(manifest["status"], "prepared_not_run")
        self.assertEqual(manifest["source"]["adapter"], "replay")
        self.assertEqual(manifest["source"]["case_study_evidence_class"], "synthetic_mock")
        self.assertEqual(manifest["snapshot"]["sha256"], digest(self.archive))
        self.assertEqual(manifest["archive_scan"]["regular_file_count"], 1)
        self.assertEqual(manifest["runtime_identity"]["model"], "fixture-model")
        self.assertTrue((self.output / "inputs" / "world.tar").is_file())
        self.assertTrue((self.output / "experiment" / "experiment.json").is_file())
        self.assertEqual(json.loads((self.output / "manifest.json").read_text()), manifest)

    def test_rejects_synthetic_mock_experiment(self):
        experiment = self._read("experiment.json")
        experiment["adapter"] = "mock"
        experiment["code"]["controller"] = {"kind": "synthetic_fixture", "identity": "unavailable"}
        experiment["collection_context"]["git_commit"] = None
        self._write("experiment.json", experiment)
        with self.assertRaisesRegex(PreparationError, "mock"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)

    def test_rejects_snapshot_hash_mismatch_without_leaving_output(self):
        self.archive.write_bytes(b"changed")
        with self.assertRaisesRegex(PreparationError, "snapshot SHA-256 mismatch"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_runtime_identity_mismatch(self):
        identity = json.loads(self.identity.read_text())
        identity["version"] = "different"
        self.identity.write_text(json.dumps(identity))
        with self.assertRaisesRegex(PreparationError, "runtime model identity"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)

    def test_rejects_runtime_condition_config_mismatch(self):
        identity = json.loads(self.identity.read_text())
        identity["conditions"]["baseline"] = "0" * 64
        self.identity.write_text(json.dumps(identity))
        with self.assertRaisesRegex(PreparationError, "condition config identity"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)

    def test_rejects_existing_destination(self):
        self.output.mkdir()
        with self.assertRaisesRegex(PreparationError, "destination already exists"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)

    def test_rejects_destination_inside_source_bundle(self):
        with self.assertRaisesRegex(PreparationError, "overlap"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.bundle / "prepared")

    def test_rejects_symlinked_archive(self):
        linked = self.root / "linked.tar"
        linked.symlink_to(self.archive)
        with self.assertRaisesRegex(PreparationError, "symlink"):
            prepare(self.bundle / "experiment.json", linked, self.identity, self.output)

    def test_rejects_archive_with_traversing_member(self):
        self._write_archive(self.archive, [("../escape", b"bad")])
        reset = self._read("reset.json")
        reset["world_archive_sha256"] = digest(self.archive)
        self._write("reset.json", reset)
        experiment = self._read("experiment.json")
        experiment["reset_manifest"]["sha256"] = digest(self.bundle / "reset.json")
        self._write("experiment.json", experiment)
        with self.assertRaisesRegex(PreparationError, "unsafe archive member"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)

    def test_rejects_archive_link_member(self):
        with tarfile.open(self.archive, "w") as archive:
            info = tarfile.TarInfo("ai-world/current")
            info.type = tarfile.SYMTYPE
            info.linkname = "../../outside"
            archive.addfile(info)
        reset = self._read("reset.json")
        reset["world_archive_sha256"] = digest(self.archive)
        self._write("reset.json", reset)
        experiment = self._read("experiment.json")
        experiment["reset_manifest"]["sha256"] = digest(self.bundle / "reset.json")
        self._write("experiment.json", experiment)
        with self.assertRaisesRegex(PreparationError, "unsafe archive member type"):
            prepare(self.bundle / "experiment.json", self.archive, self.identity, self.output)


if __name__ == "__main__":
    unittest.main()
