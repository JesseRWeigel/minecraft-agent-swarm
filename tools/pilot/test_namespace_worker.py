import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.pilot import namespace_worker as worker


class Pipe:
    def write(self, value):
        pass

    def flush(self):
        pass


class Server:
    def __init__(self, returncode=0, stop_timeout=False):
        self.returncode = None
        self.stdin = Pipe()
        self.final_returncode = returncode
        self.stop_timeout = stop_timeout
        self.terminated = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.stop_timeout and not self.terminated:
            raise subprocess.TimeoutExpired("java", timeout)
        self.returncode = -15 if self.terminated else self.final_returncode
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.returncode = -9


class WorkerTests(unittest.TestCase):
    def run_case(self, server, *, ready=True, client=0, mode="forward"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".qualification-rcon-password").write_text("private")
            previous = Path.cwd()
            os.chdir(root)
            try:
                argv = ["namespace_worker.py", str(root / "evidence.json"), mode]
                run_effect = (
                    subprocess.TimeoutExpired("client", 90)
                    if client == "timeout"
                    else None
                )
                client_result = mock.Mock(returncode=client)
                with (
                    mock.patch.object(sys, "argv", argv),
                    mock.patch.object(worker, "wait_port", return_value=ready),
                    mock.patch.object(worker.subprocess, "Popen", return_value=server),
                    mock.patch.object(
                        worker.subprocess,
                        "run",
                        return_value=client_result,
                        side_effect=run_effect,
                    ) as run,
                ):
                    returncode = worker.main()
                value = json.loads((root / "namespace-result.json").read_text())
                return returncode, value, run.call_args
            finally:
                os.chdir(previous)

    def test_clean_java_zero_is_only_success(self):
        returncode, value, _ = self.run_case(Server(0))
        self.assertEqual(returncode, 0)
        self.assertEqual(value["status"], "passed")
        self.assertTrue(value["stop_sent"])
        self.assertFalse(value["term_sent"])

    def test_java_nonzero_and_stop_escalation_fail(self):
        returncode, value, _ = self.run_case(Server(1))
        self.assertEqual(returncode, 1)
        self.assertEqual(value["java_returncode"], 1)
        returncode, value, _ = self.run_case(Server(0, True))
        self.assertEqual(returncode, 1)
        self.assertTrue(value["term_sent"])

    def test_startup_timeout_skips_client_and_fails(self):
        returncode, value, call = self.run_case(Server(0), ready=False)
        self.assertEqual(returncode, 1)
        self.assertEqual(value["readiness"], "timeout")
        self.assertIsNone(call)

    def test_client_timeout_fails_and_still_stops_java(self):
        returncode, value, _ = self.run_case(Server(0), client="timeout")
        self.assertEqual(returncode, 1)
        self.assertEqual(value["client"], "timeout")
        self.assertTrue(value["stop_sent"])
        self.assertEqual(value["java_returncode"], 0)

    def test_stationary_maps_to_only_fixed_client_flag(self):
        returncode, _, call = self.run_case(Server(0), mode="stationary")
        self.assertEqual(returncode, 0)
        self.assertEqual(call.args[0][-1], "--stationary")


if __name__ == "__main__":
    unittest.main()