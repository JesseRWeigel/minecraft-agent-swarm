import copy
import json
import os
from pathlib import Path
import sys
import unittest

from tools.pilot.protected_worker import ACTION, TRIAL, FIXTURE_SHA256, capture_process, participant_argv, score, stop_server
from tools.pilot.protected_qualification import run_protected_qualification, validate_result


def sample(phase, z=0.5):
    return {"schemaVersion": 1, "status": "sampled", "source": "server_rcon", "actor": "PilotProbe", "phase": phase,
            "trialId": TRIAL, "actionId": ACTION,
            "observations": {"position": {"x": 0.5, "y": 200, "z": z}, "dimension": "minecraft:overworld", "health": 20, "uuid": "f14b12b9-4db5-3b00-ab8c-cdacc19f233d", "roster": ["PilotProbe"], "gameMode": 0}}


def outcome(mode="forward"):
    return {"schema_version": 1, "status": "qualified", "movement_mode": mode,
            "trial_id": TRIAL, "action_id": ACTION, "independent_observer_process": True,
            "error": None, "participant_returncode": 0, "java_returncode": 0,
            "stop_sent": True, "term_sent": False, "kill_sent": False, "participant_forced_cleanup": False,
            "network_policy": "game_only_unix_v1", "game_bridge": {"connections":1,"status":"completed","identity":{"policy":"fixed_offline_login_v1","username":"PilotProbe","uuid":"f14b12b9-4db5-3b00-ab8c-cdacc19f233d","protocol":769,"status":"admitted"}},
            "fixture": {"schema_version": 1, "phase": "fixture", "baselineVerification": {"status": "verified"},
                "setup": {"status": "configured", "fixture": {"sha256": FIXTURE_SHA256}, "baselineChecks": [{"name": n, "status": "verified"} for n in ["orientation", "inventory", "game_mode", "food", "effects"]]},
                "baseline": sample("before")},
            "before": sample("before"), "terminal": sample("terminal", 4.0 if mode == "forward" else 0.5),
            "score": {"movement_succeeded": True}}


class ProtectedWorkerTests(unittest.TestCase):
    def test_server_state_distinguishes_positive_and_negative(self):
        self.assertTrue(score(sample("before"), sample("terminal", 4.0), "forward")["movement_succeeded"])
        self.assertTrue(score(sample("before"), sample("terminal"), "stationary")["negative_control_observed"])
        self.assertFalse(score(sample("before"), sample("terminal"), "forward")["movement_succeeded"])
        self.assertFalse(score(sample("before"), sample("terminal", 4), "stationary")["negative_control_observed"])

    def test_missing_dead_misidentified_or_nonfinite_observation_never_passes(self):
        cases = [None, {}, {**sample("terminal", 4), "actor": "other"}, {**sample("terminal", 4), "phase": "before"}]
        for health in [0, True, float("nan"), float("inf")]:
            row = sample("terminal", 4); row["observations"]["health"] = health; cases.append(row)
        for row in cases:
            with self.subTest(row=row):
                self.assertFalse(score(sample("before"), row, "forward")["movement_succeeded"])
                self.assertFalse(score(sample("before"), row, "stationary")["negative_control_observed"])

    def test_rejects_changed_start_wrong_direction_and_falling(self):
        self.assertFalse(score(sample("before", 2), sample("terminal", 5), "forward")["movement_succeeded"])
        self.assertFalse(score(sample("before"), sample("terminal", -3), "forward")["movement_succeeded"])
        row = sample("terminal", 4); row["observations"]["position"]["y"] = 190
        self.assertFalse(score(sample("before"), row, "forward")["movement_succeeded"])

    def test_host_recomputes_score_and_requires_clean_lifecycle(self):
        self.assertTrue(validate_result(outcome(), "forward"))
        self.assertTrue(validate_result(outcome("stationary"), "stationary"))
        forged = outcome(); forged["terminal"] = sample("terminal")
        self.assertFalse(validate_result(forged, "forward"))
        for key, value in [("term_sent", True), ("participant_forced_cleanup", True), ("java_returncode", False), ("participant_returncode", 1), ("error", "oops")]:
            row = outcome(); row[key] = value
            self.assertFalse(validate_result(row, "forward"))

    def test_host_requires_game_only_network_policy_and_bridge_cleanup(self):
        for field, value in [("network_policy", "shared"), ("game_bridge", None),
                             ("game_bridge", {"connections":2,"status":"completed"}),
                             ("game_bridge", {"connections":1,"status":"cleanup_uncertain"}),
                             ("game_bridge", {"connections":1,"status":"stopped"})]:
            row = outcome(); row[field] = value
            self.assertFalse(validate_result(row, "forward"))

    def test_failed_or_wrong_fixture_cannot_be_rescued_by_movement(self):
        for mutation in [lambda f: f.update(baselineVerification={"status":"failed"}),
                         lambda f: f["setup"].update(status="failed"),
                         lambda f: f["setup"]["fixture"].update(sha256="0"*64),
                         lambda f: f["setup"].update(baselineChecks=[]),
                         lambda f: f.update(baseline=sample("before", 10))]:
            row = outcome(); mutation(row["fixture"])
            self.assertFalse(validate_result(row, "forward"))

    def test_identity_and_roster_mismatch_cannot_be_scored(self):
        for field, value in [("uuid", None), ("uuid", "00000000-0000-0000-0000-000000000000"),
                             ("roster", []), ("roster", ["PilotProbe", "Other"])]:
            row = sample("terminal", 4)
            row["observations"][field] = value
            self.assertFalse(score(sample("before"), row, "forward")["movement_succeeded"])
        row = outcome()
        row["game_bridge"].pop("identity")
        self.assertFalse(validate_result(row, "forward"))

    def test_non_survival_or_missing_mode_never_scores_even_with_forged_success(self):
        for mode in ("forward", "stationary"):
            for phase in ("before", "terminal"):
                for value in (None, True, False, 0.0, "0", 1, 2, 3, -1):
                    row = outcome(mode)
                    row[phase]["observations"]["gameMode"] = value
                    row["score"] = {"movement_succeeded": True, "negative_control_observed": True}
                    self.assertFalse(validate_result(row, mode), (mode, phase, value))
            row = outcome(mode)
            del row["terminal"]["observations"]["gameMode"]
            self.assertFalse(validate_result(row, mode))

    def test_cleanup_continues_after_broken_java_stdin_and_timeout(self):
        class Stream:
            closed = False
            def write(self, _): raise BrokenPipeError()
            def close(self): self.closed = True
        class Server:
            stdin = Stream()
            returncode = None
            def poll(self): return self.returncode
            def terminate(self): self.returncode = -15
            def wait(self, timeout): return self.returncode
        server = Server(); result = {"stop_sent": False, "term_sent": False, "kill_sent": False, "error": None}
        stop_server(server, result)
        self.assertTrue(result["term_sent"])
        self.assertFalse(result["stop_sent"])
        self.assertEqual(result["java_returncode"], -15)
        self.assertTrue(server.stdin.closed)

    def test_nested_argv_has_no_observer_mount_or_credentials(self):
        args = participant_argv("forward")
        self.assertIn("--unshare-pid", args)
        self.assertIn("--unshare-net", args)  # game-only Unix bridge across private networks
        self.assertNotIn("--share-net", args)
        self.assertNotIn("/observer-code", args)
        self.assertNotIn("/trial-runtime", args)
        self.assertNotIn("password", " ".join(args))
        self.assertEqual(args.count("--size"), 2)
        with self.assertRaises(ValueError): participant_argv("arbitrary")

    def test_permission_probe_is_fixed_stationary_and_uses_same_namespace(self):
        args = participant_argv("stationary", command_probe=True)
        self.assertEqual(args[-2:], ["stationary", "permissions"])
        self.assertNotIn("/observer-code", args)
        self.assertIn("--unshare-net", args)
        with self.assertRaises(ValueError): participant_argv("forward", command_probe=True)

    def test_explicit_launch_required_before_any_workspace_mutation(self):
        with self.assertRaisesRegex(ValueError, "launch=True"):
            run_protected_qualification(workspace=Path('/not-created'), restore_kwargs={}, tool_snapshot=Path('/none'), tool_manifest_sha256='a'*64)

    def test_fault_injection_cannot_be_accepted_even_with_successful_samples(self):
        for case in ("death", "disconnect", "observer_timeout", "disk_full", "creative_mode", "command_denied", "command_authorized", "unknown"):
            row = outcome(); row["failure_case"] = case
            self.assertFalse(validate_result(row, "forward"))

    def test_unknown_failure_case_rejected_before_workspace_mutation(self):
        with self.assertRaisesRegex(ValueError, "failure case"):
            run_protected_qualification(launch=True, failure_case="arbitrary-command",
                workspace=Path('/not-created'), restore_kwargs={}, tool_snapshot=Path('/none'),
                tool_manifest_sha256='a'*64)

    def test_suspended_real_helper_times_out_and_is_reaped(self):
        result = capture_process([sys.executable, "-c", "import time; time.sleep(1); print('unexpected')"], {},
                                 timeout=0.15, suspend_for_test=True)
        self.assertEqual(result["error"], "observer_deadline")
        self.assertEqual(result["returncode"], -9)
        self.assertEqual(result["stdout"], b"")
        self.assertTrue(result["suspended_for_test"])
        with self.assertRaises(ProcessLookupError): os.kill(result["pid"], 0)

    def test_invalid_resource_profile_rejected_before_workspace_mutation(self):
        with self.assertRaisesRegex(ValueError,"resource profile"):
            run_protected_qualification(launch=True,resource_profile="unlimited",workspace=Path('/not-created'),
                                       restore_kwargs={},tool_snapshot=Path('/none'),tool_manifest_sha256='a'*64)

    def test_helper_uses_private_stdin_and_bounded_capture(self):
        result = capture_process([sys.executable, "-c", "import sys,json; v=json.load(sys.stdin); print(json.dumps({'received':v['phase']}))"], {"phase": "before", "password": "synthetic-secret"}, timeout=2)
        self.assertEqual(result["returncode"], 0)
        self.assertIsNone(result["error"])
        self.assertNotIn(b"synthetic-secret", result["stdout"])
        self.assertEqual(json.loads(result["stdout"]), {"received": "before"})

    def test_helper_output_flood_and_silence_fail_without_hanging(self):
        for source, expected in [("import sys; sys.stdout.write('x'*10000); sys.stdout.flush()", "observer_output_limit"), ("import time; time.sleep(10)", "observer_deadline")]:
            result = capture_process([sys.executable, "-c", source], {}, timeout=0.15, stdout_limit=100)
            self.assertEqual(result["error"], expected)
            self.assertLessEqual(len(result["stdout"]), 100)
            self.assertIsInstance(result["returncode"], int)


if __name__ == '__main__': unittest.main()
