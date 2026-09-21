"""Opt-in check of the production protected-participant mount layout.

The nested executable is a Python probe standing in for Node/Mineflayer. This
qualifies namespace wiring assembled by ``protected_worker.participant_argv``;
live game behavior remains a separate end-to-end qualification.
"""
import json
import os
from pathlib import Path
import tempfile
import textwrap
import unittest

from tools.pilot.server import _validate_executable, run_owned


FAKE_NODE = r'''#!/usr/bin/python3
import json, os, socket, stat
from pathlib import Path

def write_blocked(path):
    try:
        Path(path).write_text("tamper")
        return False
    except OSError:
        return True

processes = []
for entry in Path("/proc").iterdir():
    if entry.name.isdigit():
        try:
            processes.append((entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"))
        except OSError:
            pass
regular = []
for entry in Path("/proc/self/fd").iterdir():
    try:
        if stat.S_ISREG(entry.stat().st_mode):
            regular.append(entry.read_bytes()[:4096])
    except OSError:
        pass
Path("/participant-state/scratch-ok").write_text("scratch")
Path("/tmp/tmp-ok").write_text("tmp")
result = {
    "observer_secret_visible": Path("/observer-code/secret").exists(),
    "runtime_canary_visible": Path("/runtime/runtime-canary").exists(),
    "test_source_visible": Path("/test-source").exists(),
    "host_secret_in_environment": "PROTECTED_HOST_SECRET" in os.environ,
    "tools_write_blocked": write_blocked("/pilot-tools/tool-canary"),
    "code_write_blocked": write_blocked("/participant-code/code-canary"),
    "participant_scratch_usable": Path("/participant-state/scratch-ok").read_text() == "scratch",
    "tmp_usable": Path("/tmp/tmp-ok").read_text() == "tmp",
    "outer_process_visible": any("/outer.py" in command for command in processes),
    "pid1_root_observer_secret_visible": Path("/proc/1/root/observer-code/secret").exists(),
    "pid1_root_runtime_canary_visible": Path("/proc/1/root/runtime/runtime-canary").exists(),
    "pid1_root_test_source_visible": Path("/proc/1/root/test-source").exists(),
    "host_secret_in_regular_fd": any(b"inheritable-host-fd-secret" in value for value in regular),
}
with socket.create_connection(("127.0.0.1", 25585), timeout=2) as client:
    client.sendall(b"namespace-probe")
    result["echo"] = client.recv(128).decode("utf8")
print(json.dumps(result, sort_keys=True), flush=True)
'''


OUTER = r'''
import json, os, socket, subprocess, threading
from pathlib import Path
from tools.pilot.protected_worker import participant_argv

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 25585))
listener.listen(1)
listener.settimeout(3)
seen = {}
def echo_once():
    connection, _ = listener.accept()
    with connection:
        message = connection.recv(128)
        seen["request"] = message.decode("utf8")
        connection.sendall(b"private-outer:" + message)
thread = threading.Thread(target=echo_once)
thread.start()
secret_fd = os.open("/runtime/inheritable-secret", os.O_RDONLY)
os.set_inheritable(secret_fd, True)
try:
    process = subprocess.Popen(
        participant_argv("stationary"), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        env={"PATH": "/usr/bin:/bin", "PROTECTED_HOST_SECRET": "outer-environment-secret"},
    )
    stdout, stderr = process.communicate(timeout=5)
finally:
    os.close(secret_fd)
thread.join(timeout=3)
listener.close()
participant = None
try:
    lines = stdout.decode("utf8").splitlines()
    if len(lines) == 1:
        participant = json.loads(lines[0])
except (UnicodeError, ValueError):
    pass
trusted = {
    "nested_returncode": process.returncode,
    "nested_stderr": stderr[-4096:].decode("utf8", errors="replace"),
    "echo_observed": seen,
    "echo_thread_finished": not thread.is_alive(),
    "participant": participant,
    "observer_secret_unchanged": Path("/observer-code/secret").read_text() == "observer-only-secret",
    "runtime_canary_unchanged": Path("/runtime/runtime-canary").read_text() == "runtime-only-canary",
    "tool_canary_unchanged": Path("/pilot-tools/tool-canary").read_text() == "immutable-tool",
    "code_canary_unchanged": Path("/participant-code/code-canary").read_text() == "immutable-code",
}
raw = (json.dumps(trusted, sort_keys=True) + "\n").encode()
fd = os.open("/runtime/trusted-result.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, raw)
finally:
    os.close(fd)
raise SystemExit(0 if process.returncode == 0 and not thread.is_alive() and participant is not None else 1)
'''


class ProtectedNamespaceTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PILOT_TEST_BWRAP"), "explicit Bubblewrap qualification required")
    def test_production_builder_hides_outer_mounts_and_keeps_private_loopback(self):
        bwrap = _validate_executable(Path(os.environ["PILOT_TEST_BWRAP"]), "bwrap", expected_name="bwrap")
        repository = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime, observer = root / "runtime", root / "observer-code"
            participant_code, pilot_tools = root / "participant-code", root / "pilot-tools"
            (pilot_tools / "bin").mkdir(parents=True)
            (pilot_tools / "node_modules").mkdir()
            for directory in (runtime, observer, participant_code):
                directory.mkdir(mode=0o700)
            files = {
                runtime / "runtime-canary": "runtime-only-canary",
                runtime / "inheritable-secret": "inheritable-host-fd-secret",
                observer / "secret": "observer-only-secret",
                participant_code / "code-canary": "immutable-code",
                pilot_tools / "tool-canary": "immutable-tool",
                pilot_tools / "bin" / "node": textwrap.dedent(FAKE_NODE),
                root / "outer.py": textwrap.dedent(OUTER),
            }
            for path, content in files.items():
                path.write_text(content)
                path.chmod(0o700 if path.name in {"node", "outer.py"} else 0o600)

            argv = [str(bwrap), "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net",
                    "--cap-drop", "ALL", "--clearenv", "--setenv", "HOME", "/runtime",
                    "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONPATH", "/test-source",
                    "--ro-bind", "/usr", "/usr"]
            for system_path in (Path("/lib"), Path("/lib64")):
                if system_path.exists():
                    argv.extend(["--ro-bind", str(system_path), str(system_path)])
            argv.extend(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run",
                         "--bind", str(runtime), "/runtime", "--ro-bind", str(observer), "/observer-code",
                         "--ro-bind", str(participant_code), "/participant-code",
                         "--ro-bind", str(pilot_tools), "/pilot-tools", "--ro-bind", str(bwrap), "/pilot-bwrap",
                         "--ro-bind", str(repository), "/test-source", "--ro-bind", str(root / "outer.py"), "/outer.py",
                         "--chdir", "/runtime", "--", "/usr/bin/python3", "/outer.py"])
            outcome = run_owned(argv, cwd=root, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                timeout_seconds=7, stop_grace_seconds=1, log_limit_bytes=64 * 1024)
            self.assertEqual(outcome.returncode, 0, outcome.stderr.decode(errors="replace"))
            self.assertFalse(outcome.timed_out)
            self.assertFalse(outcome.cleanup_uncertain)
            self.assertFalse(outcome.stdout_truncated)
            self.assertFalse(outcome.stderr_truncated)
            trusted = json.loads((runtime / "trusted-result.json").read_text())
            participant = trusted["participant"]
            self.assertEqual(trusted["nested_returncode"], 0, trusted["nested_stderr"])
            self.assertTrue(trusted["echo_thread_finished"])
            self.assertEqual(trusted["echo_observed"], {"request": "namespace-probe"})
            self.assertEqual(participant["echo"], "private-outer:namespace-probe")
            for key in ("observer_secret_visible", "runtime_canary_visible", "test_source_visible",
                        "host_secret_in_environment", "outer_process_visible",
                        "pid1_root_observer_secret_visible", "pid1_root_runtime_canary_visible",
                        "pid1_root_test_source_visible", "host_secret_in_regular_fd"):
                self.assertFalse(participant[key], key)
            for key in ("tools_write_blocked", "code_write_blocked", "participant_scratch_usable", "tmp_usable"):
                self.assertTrue(participant[key], key)
            for key in ("observer_secret_unchanged", "runtime_canary_unchanged", "tool_canary_unchanged", "code_canary_unchanged"):
                self.assertTrue(trusted[key], key)
            self.assertEqual((runtime / "trusted-result.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
