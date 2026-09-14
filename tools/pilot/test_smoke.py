import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.pilot.smoke import SmokeError, run
from tools.pilot.smoke_fixture import create_fixture


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def fixture(self, behavior="move_to_goal", budgets=None):
        prepared = create_fixture(self.root / "fixture", behavior=behavior, budgets=budgets)
        pin = hashlib.sha256((prepared / "manifest.json").read_bytes()).hexdigest()
        return prepared, pin

    def test_end_to_end_resets_each_case_and_observes_success(self):
        prepared, pin = self.fixture()
        with patch("socket.socket", side_effect=AssertionError("network forbidden")), patch("subprocess.Popen", side_effect=AssertionError("process forbidden")):
            report = run(prepared, pin, self.root / "run")
        self.assertEqual(report["status"], "synthetic_smoke_completed")
        self.assertFalse(report["live_benchmark"])
        self.assertEqual(len(report["cases"]), 4)
        for case in report["cases"]:
            self.assertEqual(case["outcome"], "succeeded")
            self.assertEqual(case["initial_position"], [0, 0, 0])
            self.assertEqual(case["final_position"], [2, 1, 0])
            self.assertGreater(case["usage"]["steps"], 0)
        paths = list((self.root / "run" / "cases").glob("*/initial-state.json"))
        self.assertEqual(len(paths), 4)
        self.assertEqual(len({p.stat().st_ino for p in paths}), 4)
        for p in (self.root / "run").rglob("*"):
            self.assertEqual(p.stat().st_mode & 0o777, 0o700 if p.is_dir() else 0o600)

    def test_claim_only_does_not_pass_and_exhaustion_is_retained(self):
        prepared, pin = self.fixture("claim_only")
        report = run(prepared, pin, self.root / "run")
        self.assertTrue(all(c["outcome"] == "budget_exhausted" for c in report["cases"]))
        self.assertTrue(all(c["final_position"] == [0, 0, 0] for c in report["cases"]))

    def test_provider_failure_is_retained(self):
        prepared, pin = self.fixture("fail")
        report = run(prepared, pin, self.root / "run")
        self.assertTrue(all(c["outcome"] == "provider_error" for c in report["cases"]))

    def test_rejects_tampered_manifest_and_referenced_bytes_before_output(self):
        prepared, pin = self.fixture()
        with self.assertRaises(SmokeError):
            run(prepared, "0" * 64, self.root / "bad")
        self.assertFalse((self.root / "bad").exists())
        (prepared / "plan" / "baseline.json").write_text("{}")
        with self.assertRaises(SmokeError):
            run(prepared, pin, self.root / "bad")
        self.assertFalse((self.root / "bad").exists())

    def test_rejects_rehashed_manifest_claim_changes(self):
        prepared, _ = self.fixture()
        p = prepared / "manifest.json"
        manifest = json.loads(p.read_text()); manifest["snapshot"]["synthetic"] = False
        p.write_text(json.dumps(manifest)); pin = hashlib.sha256(p.read_bytes()).hexdigest()
        with self.assertRaises(SmokeError):
            run(prepared, pin, self.root / "bad")

    def test_never_overwrites_destination_or_follows_input_symlink(self):
        prepared, pin = self.fixture()
        target = self.root / "existing"; target.mkdir(); sentinel = target / "keep"; sentinel.write_text("preserve")
        with self.assertRaises(SmokeError):
            run(prepared, pin, target)
        self.assertEqual(sentinel.read_text(), "preserve")
        linked = self.root / "linked"; linked.symlink_to(prepared, target_is_directory=True)
        with self.assertRaises(SmokeError):
            run(linked, pin, self.root / "bad")

    def test_rejects_unlisted_file_and_tampered_archive(self):
        prepared, pin = self.fixture()
        extra = prepared / "extra.json"; extra.write_text("{}")
        with self.assertRaises(SmokeError):
            run(prepared, pin, self.root / "bad")
        extra.unlink()
        (prepared / "inputs" / "world.tar").write_bytes(b"corrupted")
        with self.assertRaises(SmokeError):
            run(prepared, pin, self.root / "bad")
        self.assertFalse((self.root / "bad").exists())

    def test_late_provider_completion_is_not_success(self):
        from tools.pilot.budgets import BudgetTracker
        prepared, pin = self.fixture()
        now = [0.0]
        def late_step(*args):
            state, scenario, _, _rng = args
            state["actors"]["atlas"]["position"] = dict(x=2, y=1, z=0)
            now[0] += 31
        with patch("tools.pilot.smoke.BudgetTracker", side_effect=lambda limits: BudgetTracker(limits, clock=lambda: now[0])), patch("tools.pilot.smoke._fake_step", side_effect=late_step):
            report = run(prepared, pin, self.root / "run")
        self.assertTrue(all(c["outcome"] == "budget_exhausted" for c in report["cases"]))
        self.assertTrue(all(c["usage"]["output_tokens"] == 1 for c in report["cases"]))

    def test_request_budget_stops_before_extra_provider_call(self):
        limits = dict(max_steps=20, timeout_seconds=30, max_provider_requests=1, max_input_tokens=10, max_output_tokens=10)
        prepared, pin = self.fixture(budgets=limits)
        report = run(prepared, pin, self.root / "run")
        self.assertTrue(all(c["outcome"] == "budget_exhausted" for c in report["cases"]))
        self.assertTrue(all(c["usage"]["provider_requests"] == 1 for c in report["cases"]))


if __name__ == "__main__":
    unittest.main()
