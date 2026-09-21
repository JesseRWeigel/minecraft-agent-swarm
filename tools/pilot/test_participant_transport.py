import json
import os
import subprocess
import sys
import textwrap
import time
import unittest
from unittest.mock import patch

from tools.pilot.participant_protocol import MAX_TOTAL_BYTES
from tools.pilot.participant_transport import DEFAULT_MAX_STDERR_BYTES, ParticipantTransport, ParticipantTransportError

READY = {"schema_version": 1, "type": "ready", "trial_id": "trial-01", "action_id": "walk-01"}
FINISHED = {"schema_version": 1, "type": "action_finished", "trial_id": "trial-01", "action_id": "walk-01"}
BEGIN = {"schema_version": 1, "type": "begin", "trial_id": "trial-01", "action_id": "walk-01"}
FINALIZE = {"schema_version": 1, "type": "finalize", "trial_id": "trial-01", "action_id": "walk-01"}


def child(script):
    return subprocess.Popen([sys.executable, "-u", "-c", textwrap.dedent(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def reap(process):
    if process.poll() is None:
        process.kill()
    process.wait(timeout=2)
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            stream.close()


class ParticipantTransportTests(unittest.TestCase):
    def make(self, script, **kwargs):
        process = child(script)
        self.addCleanup(reap, process)
        transport = ParticipantTransport(process, trial_id="trial-01", action_id="walk-01", **kwargs)
        self.addCleanup(transport.close)
        return process, transport

    def test_real_process_completes_exact_full_handshake(self):
        process, transport = self.make(f'''
            import json, sys
            print(json.dumps({READY!r}, separators=(",", ":")), flush=True)
            if sys.stdin.buffer.readline() != (json.dumps({BEGIN!r}, separators=(",", ":")) + "\\n").encode(): raise SystemExit(21)
            print(json.dumps({FINISHED!r}, separators=(",", ":")), flush=True)
            if sys.stdin.buffer.readline() != (json.dumps({FINALIZE!r}, separators=(",", ":")) + "\\n").encode(): raise SystemExit(22)
            print("bounded diagnostic", file=sys.stderr, flush=True)
        ''')
        self.assertEqual(transport.wait_ready(), "ready")
        transport.send_begin()
        self.assertEqual(transport.wait_action_finished(), "action_finished")
        transport.send_finalize()
        transport.wait_exit()
        self.assertEqual(process.returncode, 0)
        self.assertEqual(transport.stderr, b"bounded diagnostic\n")
        self.assertEqual(transport.stdout_bytes, len(json.dumps(READY, separators=(",", ":"))) + len(json.dumps(FINISHED, separators=(",", ":"))) + 2)

    def test_silent_process_fails_at_phase_deadline_while_idle(self):
        process, _ = self.make("import time; time.sleep(30)")
        started = time.monotonic()
        with patch("tools.pilot.participant_protocol.READY_TIMEOUT_SECONDS", 0.1):
            transport = ParticipantTransport(process, trial_id="trial-01", action_id="walk-01", overall_timeout=2.0)
            with self.assertRaisesRegex(ParticipantTransportError, "phase deadline"):
                transport.wait_ready()
        self.assertLess(time.monotonic() - started, 1.0)

    def test_overall_deadline_is_enforced_before_longer_phase_deadline(self):
        _, transport = self.make("import time; time.sleep(30)", overall_timeout=0.1)
        with self.assertRaisesRegex(ParticipantTransportError, "overall deadline"):
            transport.wait_ready()

    def test_oversized_stdout_fails_closed(self):
        _, transport = self.make(f"import sys; sys.stdout.buffer.write(b'x' * {MAX_TOTAL_BYTES + 1}); sys.stdout.flush(); import time; time.sleep(30)")
        with self.assertRaisesRegex(ParticipantTransportError, "stdout byte limit"):
            transport.wait_ready()

    def test_oversized_stderr_fails_and_retains_only_bounded_prefix(self):
        _, transport = self.make(f"import sys; sys.stderr.buffer.write(b'e' * {DEFAULT_MAX_STDERR_BYTES + 1}); sys.stderr.flush(); import time; time.sleep(30)")
        with self.assertRaisesRegex(ParticipantTransportError, "stderr byte limit"):
            transport.wait_ready()
        self.assertEqual(transport.stderr, b"e" * DEFAULT_MAX_STDERR_BYTES)

    def test_malformed_and_early_eof_fail_closed(self):
        _, malformed = self.make("print('not-json', flush=True)")
        with self.assertRaisesRegex(ParticipantTransportError, "invalid participant JSON"):
            malformed.wait_ready()
        _, early = self.make(f"import json; print(json.dumps({READY!r}), flush=True)")
        self.assertEqual(early.wait_ready(), "ready")
        early.send_begin()
        with self.assertRaisesRegex(ParticipantTransportError, "EOF before finalization"):
            early.wait_action_finished()

    def test_nonzero_exit_after_valid_handshake_fails(self):
        _, transport = self.make(f'''
            import json, sys
            print(json.dumps({READY!r}), flush=True); sys.stdin.buffer.readline()
            print(json.dumps({FINISHED!r}), flush=True); sys.stdin.buffer.readline()
            raise SystemExit(7)
        ''')
        transport.wait_ready(); transport.send_begin()
        transport.wait_action_finished(); transport.send_finalize()
        with self.assertRaisesRegex(ParticipantTransportError, "status 7"):
            transport.wait_exit()

    def test_constructor_rejects_process_without_binary_pipes(self):
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        self.addCleanup(reap, process)
        with self.assertRaisesRegex(ValueError, "binary stdin, stdout, and stderr pipes"):
            ParticipantTransport(process, trial_id="trial-01", action_id="walk-01")

    def test_constructor_rejects_limits_above_fixed_caps_and_invalid_initial_clock(self):
        process = child("import time; time.sleep(30)")
        self.addCleanup(reap, process)
        for kwargs in ({"overall_timeout": 90.1}, {"max_stderr_bytes": 4097}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                ParticipantTransport(process, trial_id="trial-01", action_id="walk-01", **kwargs)
        with self.assertRaisesRegex(ParticipantTransportError, "monotonic clock"):
            ParticipantTransport(process, trial_id="trial-01", action_id="walk-01", now=lambda: float("nan"))

    def test_overall_deadline_is_checked_after_observation_window_before_begin(self):
        class Clock:
            value = 100.0
            def __call__(self): return self.value

        clock = Clock()
        _, transport = self.make(f"import json; print(json.dumps({READY!r}), flush=True); import time; time.sleep(30)", now=clock, overall_timeout=1.0)
        self.assertEqual(transport.wait_ready(), "ready")
        clock.value = 101.0
        with self.assertRaisesRegex(ParticipantTransportError, "overall deadline"):
            transport.send_begin()

    def test_close_is_idempotent_and_does_not_terminate_child(self):
        process, transport = self.make("import time; time.sleep(30)")
        transport.close()
        transport.close()
        self.assertIsNone(process.poll())

    def test_invalid_protocol_configuration_does_not_change_caller_pipe_modes(self):
        process = child("import time; time.sleep(30)")
        self.addCleanup(reap, process)
        before = tuple(os.get_blocking(stream.fileno()) for stream in (process.stdin, process.stdout, process.stderr))
        with self.assertRaises(ValueError):
            ParticipantTransport(process, trial_id="../invalid", action_id="walk-01")
        after = tuple(os.get_blocking(stream.fileno()) for stream in (process.stdin, process.stdout, process.stderr))
        self.assertEqual(after, before)

    def test_selector_is_closed_when_pipe_setup_fails(self):
        process = child("import time; time.sleep(30)")
        self.addCleanup(reap, process)

        class BrokenSelector:
            closed = False
            def register(self, *_args, **_kwargs): raise OSError("synthetic setup failure")
            def close(self): self.closed = True

        selector = BrokenSelector()
        with patch("tools.pilot.participant_transport.selectors.DefaultSelector", return_value=selector):
            with self.assertRaisesRegex(OSError, "synthetic setup failure"):
                ParticipantTransport(process, trial_id="trial-01", action_id="walk-01")
        self.assertTrue(selector.closed)

    def test_send_checks_deadline_after_final_write(self):
        class Clock:
            value = 100.0
            def __call__(self): return self.value

        clock = Clock()
        _, transport = self.make(f"import json; print(json.dumps({READY!r}), flush=True); import time; time.sleep(30)", now=clock, overall_timeout=1.0)
        transport.wait_ready()
        real_write = os.write

        def expiring_write(fd, data):
            count = real_write(fd, data)
            clock.value = 101.0
            return count

        with patch("tools.pilot.participant_transport.os.write", side_effect=expiring_write):
            with self.assertRaisesRegex(ParticipantTransportError, "overall deadline"):
                transport.send_begin()

    def test_wait_exit_rechecks_deadline_after_completed_lifecycle(self):
        class Clock:
            value = 100.0
            def __call__(self): return self.value

        clock = Clock()
        _, transport = self.make(f'''
            import json, sys
            print(json.dumps({READY!r}), flush=True); sys.stdin.buffer.readline()
            print(json.dumps({FINISHED!r}), flush=True); sys.stdin.buffer.readline()
        ''', now=clock, overall_timeout=1.0)
        transport.wait_ready(); transport.send_begin()
        transport.wait_action_finished(); transport.send_finalize(); transport.wait_exit()
        clock.value = 101.0
        with self.assertRaisesRegex(ParticipantTransportError, "overall deadline"):
            transport.wait_exit()


if __name__ == "__main__":
    unittest.main()
