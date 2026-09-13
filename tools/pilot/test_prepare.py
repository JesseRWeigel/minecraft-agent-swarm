import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout

from tools.pilot.prepare import PreparationError, main, prepare


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.archive = self.root / "world.tar"
        self._write_archive(self.archive, [("ai-world/level.dat", b"frozen-world")])
        self._write_plan(synthetic=False)
        self.identity = self.root / "runtime.json"
        self._write_identity()
        self.output = self.root / "prepared"

    def _read(self, name):
        return json.loads((self.bundle / name).read_text(encoding="utf-8"))

    def _write(self, name, value):
        path = self.bundle / name
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def _ref(self, name):
        return {"path": name, "sha256": digest(self.bundle / name)}

    def _write_identity(self):
        plan = self._read("plan.json")
        self.identity.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "provider": "fixture-provider",
                    "model": "fixture-model",
                    "version": "2026-09-13",
                    "conditions": {
                        item["id"]: item["config"]["sha256"] for item in plan["conditions"]
                    },
                },
                sort_keys=True,
            ) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _write_archive(path, members):
        with tarfile.open(path, "w") as archive:
            for name, content in members:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))

    def _write_plan(self, synthetic):
        snapshot_hash = digest(self.archive)
        self._write("snapshot.json", {"schema_version": 1, "archive_format": "tar", "archive_sha256": snapshot_hash, "synthetic": synthetic})
        self._write("reset.json", {"schema_version": 1, "world_id": "fixture-world", "server_version": "fixture-server-1", "snapshot_sha256": snapshot_hash, "reset_procedure": "synthetic_fixture" if synthetic else "reviewed_restore_v1"})
        self._write("model.json", {"schema_version": 1, "provider": "fixture-provider", "model": "fixture-model", "version": "2026-09-13"})
        self._write("scenarios.json", {"schema_version": 1, "scenarios": [{"id": "navigate", "task": "navigate_to_region", "goal": {"actor": "atlas", "min": [0, 0, 0], "max": [2, 2, 2]}}]})
        self._write("baseline.json", {"schema_version": 1, "condition_id": "baseline", "kind": "baseline"})
        self._write("coordination.json", {"schema_version": 1, "condition_id": "coordination", "kind": "coordination"})
        self._write("plan.json", {
            "schema_version": 1, "kind": "prospective_pilot_plan", "plan_id": "pilot-001", "seeds": [11, 22],
            "budgets": {"max_steps": 20, "timeout_seconds": 30, "max_provider_requests": 4, "max_input_tokens": 1000, "max_output_tokens": 500},
            "snapshot_manifest": self._ref("snapshot.json"), "reset_manifest": self._ref("reset.json"), "model_manifest": self._ref("model.json"), "scenario_manifest": self._ref("scenarios.json"),
            "conditions": [{"id": "baseline", "kind": "baseline", "config": self._ref("baseline.json")}, {"id": "coordination", "kind": "coordination", "config": self._ref("coordination.json")}],
            "code": {"source_identity": {"kind": "git_commit", "identity": "1" * 40}},
        })

    def _prepare(self, **kwargs):
        kwargs.setdefault("reserve_bytes", 0)
        return prepare(self.bundle / "plan.json", self.archive, self.identity, self.output, **kwargs)

    def _repin_snapshot(self):
        snapshot = self._read("snapshot.json"); snapshot["archive_sha256"] = digest(self.archive); self._write("snapshot.json", snapshot)
        reset = self._read("reset.json"); reset["snapshot_sha256"] = digest(self.archive); self._write("reset.json", reset)
        plan = self._read("plan.json"); plan["snapshot_manifest"] = self._ref("snapshot.json"); plan["reset_manifest"] = self._ref("reset.json"); self._write("plan.json", plan)

    def test_prepares_prospective_inputs_privately_without_outcomes(self):
        previous = os.umask(0o022)
        try:
            manifest = self._prepare()
        finally:
            os.umask(previous)
        self.assertEqual(manifest["status"], "prepared_not_run")
        self.assertFalse(manifest["live_ready"]); self.assertFalse(manifest["reset_performed"])
        self.assertEqual(manifest["source"]["kind"], "prospective_pilot_plan")
        self.assertEqual(manifest["source"]["plan_id"], "pilot-001")
        self.assertFalse(manifest["snapshot"]["synthetic"])
        self.assertEqual(manifest["storage_preflight"]["reserve_bytes"], 0)
        self.assertEqual(manifest["archive_scan"]["regular_file_count"], 1)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        for path in self.output.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        self.assertEqual(json.loads((self.output / "manifest.json").read_text()), manifest)

    def test_synthetic_plan_stays_non_live_and_cannot_name_real_reset(self):
        self._write_plan(synthetic=True); self._write_identity()
        manifest = self._prepare()
        self.assertTrue(manifest["snapshot"]["synthetic"]); self.assertFalse(manifest["live_ready"])
        reset = self._read("reset.json"); reset["reset_procedure"] = "reviewed_restore_v1"; self._write("reset.json", reset)
        plan = self._read("plan.json"); plan["reset_manifest"] = self._ref("reset.json"); self._write("plan.json", plan)
        with self.assertRaisesRegex(PreparationError, "synthetic.*reset_procedure"):
            prepare(self.bundle / "plan.json", self.archive, self.identity, self.root / "other", reserve_bytes=0)

    def test_rejects_boolean_schema_version(self):
        identity = json.loads(self.identity.read_text()); identity["schema_version"] = True; self.identity.write_text(json.dumps(identity))
        with self.assertRaisesRegex(PreparationError, "schema_version"):
            self._prepare()

    def test_rejects_snapshot_and_runtime_identity_mismatches(self):
        self.archive.write_bytes(b"changed")
        with self.assertRaisesRegex(PreparationError, "snapshot SHA-256 mismatch"):
            self._prepare()
        self._write_archive(self.archive, [("ai-world/level.dat", b"frozen-world")])
        identity = json.loads(self.identity.read_text()); identity["version"] = "different"; self.identity.write_text(json.dumps(identity))
        with self.assertRaisesRegex(PreparationError, "runtime model identity"):
            self._prepare()
        identity["version"] = "2026-09-13"; identity["conditions"]["baseline"] = "0" * 64; self.identity.write_text(json.dumps(identity))
        with self.assertRaisesRegex(PreparationError, "condition config identity"):
            self._prepare()

    def test_rejects_existing_destination_overlap_and_symlink(self):
        self.output.mkdir()
        with self.assertRaisesRegex(PreparationError, "destination already exists"):
            self._prepare()
        self.output.rmdir()
        with self.assertRaisesRegex(PreparationError, "overlap"):
            prepare(self.bundle / "plan.json", self.archive, self.identity, self.bundle / "prepared", reserve_bytes=0)
        linked = self.root / "linked.tar"; linked.symlink_to(self.archive)
        with self.assertRaisesRegex(PreparationError, "symlink"):
            prepare(self.bundle / "plan.json", linked, self.identity, self.output, reserve_bytes=0)

    def test_rejects_unsafe_truncated_and_trailing_archives(self):
        cases = []
        self._write_archive(self.archive, [("../escape", b"bad")]); cases.append((self.archive.read_bytes(), "unsafe archive member path"))
        with tarfile.open(self.archive, "w") as archive:
            info = tarfile.TarInfo("ai-world/current"); info.type = tarfile.SYMTYPE; info.linkname = "../../outside"; archive.addfile(info)
        cases.append((self.archive.read_bytes(), "unsafe archive member type"))
        with tarfile.open(self.archive, "w") as archive:
            for content in (b"one", b"two"):
                info = tarfile.TarInfo("ai-world/duplicate.dat"); info.size = len(content); archive.addfile(info, io.BytesIO(content))
        cases.append((self.archive.read_bytes(), "duplicate archive member"))
        self._write_archive(self.archive, [("ai-world/large.dat", b"x" * 4096)]); cases.append((self.archive.read_bytes()[:1024], "valid tar stream"))
        self._write_archive(self.archive, [("ai-world/level.dat", b"ok")]); cases.append((self.archive.read_bytes() + b"nonzero trailing payload", "trailing data"))
        for index, (raw, message) in enumerate(cases):
            with self.subTest(index=index):
                self.archive.write_bytes(raw); self._repin_snapshot()
                with self.assertRaisesRegex(PreparationError, message):
                    prepare(self.bundle / "plan.json", self.archive, self.identity, self.root / f"bad-{index}", reserve_bytes=0)

    def test_rejects_archive_when_storage_reserve_would_be_crossed(self):
        with self.assertRaisesRegex(PreparationError, "free-space reserve"):
            self._prepare(reserve_bytes=10**30)

    def test_cli_prints_only_minimal_preparation_summary(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = main([
                "prepare", "--plan", str(self.bundle / "plan.json"),
                "--world-archive", str(self.archive),
                "--runtime-identity", str(self.identity),
                "--output", str(self.output), "--reserve-bytes", "0",
            ])
        summary = json.loads(output.getvalue())
        self.assertEqual(result, 0)
        self.assertEqual(set(summary), {"status", "manifest", "manifest_sha256"})


if __name__ == "__main__":
    unittest.main()
