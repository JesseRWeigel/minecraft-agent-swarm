import json
import errno
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest

from tools.pilot.server import (
    LIFECYCLE_FILENAME,
    ProcessError,
    ProcessResult,
    _cli_exit_code,
    _build_sandbox_argv,
    build_server_argv,
    run_owned,
    run_server,
)


class ServerProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_python(self, source, **kwargs):
        return run_owned(
            [sys.executable, "-c", source],
            cwd=self.root,
            env={"PATH": os.environ.get("PATH", "")},
            timeout_seconds=kwargs.pop("timeout_seconds", 2),
            stop_grace_seconds=kwargs.pop("stop_grace_seconds", 0.1),
            log_limit_bytes=kwargs.pop("log_limit_bytes", 4096),
            **kwargs,
        )

    def test_reports_early_exit_without_claiming_startup_or_readiness(self):
        result = self.run_python("import sys; print('boot text'); sys.exit(3)")
        self.assertEqual(result.returncode, 3)
        self.assertFalse(result.timed_out)
        self.assertFalse(result.stop_sent)
        self.assertFalse(result.ready)
        self.assertEqual(result.status, "exited")
        self.assertIn(b"boot text", result.stdout)

    def test_captures_bounded_stdout_and_stderr(self):
        result = self.run_python(
            "import sys; sys.stdout.write('a'*200+'OUTEND'); "
            "sys.stderr.write('b'*200+'ERREND')",
            log_limit_bytes=32,
        )
        self.assertEqual(len(result.stdout), 32)
        self.assertEqual(len(result.stderr), 32)
        self.assertTrue(result.stdout_truncated)
        self.assertTrue(result.stderr_truncated)
        self.assertTrue(result.stdout.endswith(b"OUTEND"))
        self.assertTrue(result.stderr.endswith(b"ERREND"))

    @unittest.skipUnless(os.name == "posix", "signal lifecycle requires POSIX")
    def test_continuous_output_cannot_starve_deadline_or_cleanup(self):
        source = (
            "import os,signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "chunk=b'x'*65536; "
            "\nwhile True:\n os.write(1,chunk); os.write(2,chunk)"
        )
        started = time.monotonic()
        result = self.run_python(
            source,
            timeout_seconds=0.05,
            stop_grace_seconds=0.05,
            log_limit_bytes=1024,
        )
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(result.timed_out)
        self.assertTrue(result.kill_sent)
        self.assertTrue(result.stdout_truncated)
        self.assertTrue(result.stderr_truncated)

    def test_deadline_sends_stop_and_allows_graceful_exit(self):
        result = self.run_python(
            "import sys; line=sys.stdin.readline(); print(line.strip()); "
            "sys.exit(0 if line == 'stop\\n' else 4)",
            timeout_seconds=0.05,
        )
        self.assertTrue(result.timed_out)
        self.assertTrue(result.stop_sent)
        self.assertFalse(result.term_sent)
        self.assertFalse(result.kill_sent)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"stop", result.stdout)

    @unittest.skipUnless(os.name == "posix", "process-group lifecycle requires POSIX")
    def test_kills_owned_group_when_parent_and_child_ignore_stop_and_term(self):
        sentinel = self.root / "survived"
        child = (
            "import time; from pathlib import Path; time.sleep(0.7); "
            f"Path({str(sentinel)!r}).write_text('bad')"
        )
        parent = (
            "import signal,subprocess,sys,time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            f"subprocess.Popen([sys.executable,'-c',{child!r}]); "
            "time.sleep(5)"
        )
        result = self.run_python(parent, timeout_seconds=0.05, stop_grace_seconds=0.05)
        self.assertTrue(result.term_sent)
        self.assertTrue(result.kill_sent)
        time.sleep(0.8)
        self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "posix", "process-group lifecycle requires POSIX")
    def test_cleans_descendants_when_leader_exits(self):
        sentinel = self.root / "orphan-survived"
        child = (
            "import time; from pathlib import Path; time.sleep(0.5); "
            f"Path({str(sentinel)!r}).write_text('bad')"
        )
        result = self.run_python(
            f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}])"
        )
        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.descendant_cleanup)
        time.sleep(0.6)
        self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "posix", "escaped-session lifecycle requires POSIX")
    def test_returns_bounded_and_reports_uncertainty_when_escaped_child_holds_pipes(self):
        pid_file = self.root / "escaped.pid"
        child = "import time; time.sleep(10)"
        parent = (
            "import subprocess,sys; from pathlib import Path; "
            f"child=subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True); "
            f"Path({str(pid_file)!r}).write_text(str(child.pid))"
        )
        started = time.monotonic()
        result = self.run_python(parent, stop_grace_seconds=0.05)
        elapsed = time.monotonic() - started
        escaped_pid = int(pid_file.read_text())
        try:
            self.assertLess(elapsed, 1.0)
            self.assertTrue(result.cleanup_uncertain)
            self.assertFalse(result.descendant_cleanup)
        finally:
            try:
                os.kill(escaped_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_rejects_invalid_process_inputs_before_spawn(self):
        invalid = [
            ([], self.root, {}, 1, 1, 10),
            (["relative"], self.root, {}, 1, 1, 10),
            ([sys.executable], self.root / "missing", {}, 1, 1, 10),
            ([sys.executable], self.root, {"BAD": 1}, 1, 1, 10),
            ([sys.executable], self.root, {}, 0, 1, 10),
            ([sys.executable], self.root, {}, 1, -1, 10),
            ([sys.executable], self.root, {}, 1, 1, 0),
        ]
        for args in invalid:
            with self.subTest(args=args):
                with self.assertRaises(ProcessError):
                    run_owned(args[0], cwd=args[1], env=args[2], timeout_seconds=args[3], stop_grace_seconds=args[4], log_limit_bytes=args[5])


class SandboxLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()

    def test_builds_fixed_networkless_bwrap_and_java_command(self):
        argv = build_server_argv(
            self.runtime,
            java_path=Path("/usr/bin/java"),
            bwrap_path=Path("/usr/bin/bwrap"),
        )
        self.assertEqual(argv[0], "/usr/bin/bwrap")
        self.assertIn("--unshare-all", argv)
        self.assertIn("--unshare-net", argv)
        self.assertIn("--clearenv", argv)
        self.assertIn("--die-with-parent", argv)
        self.assertIn("--new-session", argv)
        cap_index = argv.index("--cap-drop")
        self.assertEqual(argv[cap_index + 1], "ALL")
        self.assertNotIn("--share-net", argv)
        self.assertIn("--ro-bind", argv)
        bind_index = argv.index("--bind")
        self.assertEqual(argv[bind_index + 1 : bind_index + 3], [str(self.runtime), str(self.runtime)])
        self.assertEqual(
            argv[-7:],
            ["/usr/bin/java", "-Xms1G", "-Xmx2G", "-Djava.awt.headless=true", "-jar", "server.jar", "--nogui"],
        )

    @unittest.skipUnless(os.environ.get("PILOT_TEST_BWRAP"), "set PILOT_TEST_BWRAP to vetted binary")
    def test_real_bwrap_hides_host_clears_secret_blocks_outbound_and_writes_runtime(self):
        bwrap = Path(os.environ["PILOT_TEST_BWRAP"])
        host_canary = Path(self.temp.name) / "host-canary"
        host_canary.write_text("must stay outside")
        result_path = self.runtime / "sandbox-result.json"
        source = (
            "import json,os,socket; from pathlib import Path; "
            f"canary=Path({str(host_canary)!r}).exists(); "
            "connected=False; error=None; s=socket.socket(); s.settimeout(0.2); "
            "\ntry:\n s.connect(('1.1.1.1',53)); connected=True\n"
            "except OSError as exc:\n error=exc.errno\nfinally:\n s.close()\n"
            f"Path({str(result_path)!r}).write_text(json.dumps({{'canary':canary,'secret':os.environ.get('HOST_SECRET'),'connected':connected,'error':error}}))"
        )
        argv = _build_sandbox_argv(
            self.runtime,
            bwrap_path=bwrap,
            command=["/usr/bin/python3", "-c", source],
        )
        result = run_owned(
            argv,
            cwd=self.runtime,
            env={"PATH": "/usr/bin", "HOST_SECRET": "must-not-cross"},
            timeout_seconds=3,
            stop_grace_seconds=0.1,
            log_limit_bytes=4096,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        observed = json.loads(result_path.read_text())
        self.assertEqual(observed["canary"], False)
        self.assertIsNone(observed["secret"])
        self.assertEqual(observed["connected"], False)
        self.assertIn(
            observed["error"],
            {errno.ENETUNREACH, errno.ENETDOWN, errno.EHOSTUNREACH, errno.EACCES, errno.EPERM},
        )

    def test_run_server_verifies_fresh_runtime_before_runner(self):
        calls = []
        manifest = {
            "kind": "isolated_minecraft_runtime",
            "status": "restored_not_started",
            "files": [
                {"path": name, "sha256": "a" * 64, "bytes": 1}
                for name in ("server.jar", "eula.txt", "server.properties")
            ],
        }

        def verify(runtime, manifest_sha256):
            calls.append(("verify", runtime, manifest_sha256))
            return manifest

        def runner(argv, **kwargs):
            launching = json.loads((self.runtime / LIFECYCLE_FILENAME).read_text())
            self.assertEqual(launching["status"], "launching")
            self.assertEqual(kwargs["env"], {"PATH": "/usr/bin", "LANG": "C.UTF-8"})
            calls.append(("run", argv, kwargs))
            return type("Result", (), {"to_dict": lambda self: {"status": "exited"}})()

        result = run_server(
            self.runtime,
            manifest_sha256="b" * 64,
            timeout_seconds=1,
            stop_grace_seconds=0.1,
            java_path=Path("/usr/bin/java"),
            bwrap_path=Path("/usr/bin/bwrap"),
            verify_runtime=verify,
            runner=runner,
            validate_executables=False,
        )
        self.assertEqual(result.to_dict(), {"status": "exited"})
        self.assertEqual(calls[0][0], "verify")
        self.assertEqual(calls[1][0], "run")
        lifecycle = json.loads((self.runtime / LIFECYCLE_FILENAME).read_text())
        self.assertEqual(lifecycle["status"], "exited")
        self.assertEqual(lifecycle["manifest_sha256"], "b" * 64)
        self.assertFalse(lifecycle["live_benchmark"])
        self.assertIn("claim_limit", lifecycle)
        self.assertIn("cleanup_verified", lifecycle)
        self.assertEqual((self.runtime / LIFECYCLE_FILENAME).stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ProcessError, "already exists"):
            run_server(
                self.runtime,
                manifest_sha256="b" * 64,
                timeout_seconds=1,
                verify_runtime=verify,
                runner=runner,
                validate_executables=False,
            )

    def test_verification_failure_prevents_runner_and_lifecycle_marker(self):
        ran = False

        def runner(*args, **kwargs):
            nonlocal ran; ran = True

        with self.assertRaisesRegex(ProcessError, "verification"):
            run_server(
                self.runtime,
                manifest_sha256="c" * 64,
                timeout_seconds=1,
                verify_runtime=lambda *_: (_ for _ in ()).throw(ValueError("bad runtime")),
                runner=runner,
                validate_executables=False,
            )
        self.assertFalse(ran)
        self.assertFalse((self.runtime / LIFECYCLE_FILENAME).exists())

    def test_rejects_symlinked_runtime_before_verification(self):
        linked = Path(self.temp.name) / "linked-runtime"
        linked.symlink_to(self.runtime, target_is_directory=True)
        verified = False

        def verify(*_):
            nonlocal verified; verified = True

        with self.assertRaisesRegex(ProcessError, "symlink"):
            run_server(
                linked,
                manifest_sha256="d" * 64,
                timeout_seconds=1,
                verify_runtime=verify,
                validate_executables=False,
            )
        self.assertFalse(verified)

    def test_rejects_unbounded_lifecycle_limits_before_marker(self):
        for arguments in (
            {"timeout_seconds": 3601},
            {"timeout_seconds": 1, "stop_grace_seconds": 61},
            {"timeout_seconds": 1, "log_limit_bytes": 16 * 1024 * 1024 + 1},
        ):
            with self.subTest(arguments=arguments):
                with self.assertRaises(ProcessError):
                    run_server(
                        self.runtime,
                        manifest_sha256="e" * 64,
                        verify_runtime=lambda *_: {},
                        validate_executables=False,
                        **arguments,
                    )
                self.assertFalse((self.runtime / LIFECYCLE_FILENAME).exists())

    def test_cli_exit_code_rejects_failed_or_incomplete_observation(self):
        base = dict(
            status="exited", returncode=0, signal=None, timed_out=True, stop_sent=True,
            term_sent=False, kill_sent=False, descendant_cleanup=False,
            cleanup_uncertain=False, stdout=b"", stderr=b"", stdout_truncated=False,
            stderr_truncated=False, elapsed_seconds=1.0,
        )
        self.assertEqual(_cli_exit_code(ProcessResult(**base)), 0)
        for change in (
            {"returncode": 1},
            {"cleanup_uncertain": True},
            {"stdout_truncated": True},
            {"stderr_truncated": True},
        ):
            with self.subTest(change=change):
                self.assertEqual(_cli_exit_code(ProcessResult(**{**base, **change})), 1)


if __name__ == "__main__":
    unittest.main()
