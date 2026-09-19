"""Opt-in synthetic qualification of nested participant containment."""
import json
import os
from pathlib import Path
import tempfile
import textwrap
import unittest

from tools.pilot.server import _validate_executable, run_owned


CHILD = r'''
import json, os, socket, stat
from pathlib import Path
result = {}
with socket.create_connection(("127.0.0.1", int(os.environ["ECHO_PORT"])), timeout=3) as client:
    client.sendall(b"participant-ping")
    result["echo"] = client.recv(64).decode()
result["outer_env_secret_visible"] = "OUTER_SECRET" in os.environ
result["observer_secret_visible"] = Path("/observer/secret").exists()
result["observer_evidence_visible"] = Path("/observer/evidence").exists()
try:
    Path("/observer/evidence").write_text("tamper")
    result["observer_write_blocked"] = False
except OSError:
    result["observer_write_blocked"] = True
try:
    Path("/tools/canary").write_text("tamper")
    result["tool_write_blocked"] = False
except OSError:
    result["tool_write_blocked"] = True
processes = []
for entry in Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    try:
        command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        processes.append({"pid": entry.name, "command": command[:256]})
    except OSError:
        pass
result["outer_process_visible"] = any("/outer.py" in item["command"] for item in processes)
result["visible_pids"] = sorted(item["pid"] for item in processes)
regular_fd_bytes = []
for entry in Path("/proc/self/fd").iterdir():
    try:
        if not stat.S_ISREG(entry.stat().st_mode):
            continue
        with entry.open("rb") as descriptor:
            regular_fd_bytes.append(descriptor.read(4096))
    except OSError:
        pass
result["observer_secret_in_regular_fd"] = any(b"observer-secret" in data for data in regular_fd_bytes)
result["outer_secret_in_regular_fd"] = any(b"outer-only-secret" in data for data in regular_fd_bytes)
result["pid1_root_observer_secret_visible"] = Path("/proc/1/root/observer/secret").exists()
path = Path("/participant-state/result.json")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, (json.dumps(result, sort_keys=True) + "\n").encode())
finally:
    os.close(fd)
'''

OUTER = r'''
import json, os, socket, subprocess, threading
from pathlib import Path
secret_fd = os.open("/observer/secret", os.O_RDONLY)
os.set_inheritable(secret_fd, True)
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
listener.settimeout(5)
port = listener.getsockname()[1]
observed = {}
def accept_once():
    connection, _ = listener.accept()
    with connection:
        message = connection.recv(64)
        observed["message"] = message.decode()
        connection.sendall(b"outer-echo:" + message)
thread = threading.Thread(target=accept_once)
thread.start()
argv = [
    "/pilot-bwrap", "--die-with-parent", "--new-session",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--cap-drop", "ALL", "--clearenv",
    "--setenv", "HOME", "/participant-state", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "ECHO_PORT", str(port), "--ro-bind", "/usr", "/usr",
]
for system_path in ("/lib", "/lib64"):
    if Path(system_path).exists():
        argv.extend(["--ro-bind", system_path, system_path])
argv.extend([
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run",
    "--ro-bind", "/outer-tools", "/tools",
    "--bind", "/participant-state", "/participant-state",
    "--chdir", "/participant-state", "--", "/usr/bin/python3", "/tools/child.py",
])
child = subprocess.run(
    argv,
    timeout=10,
    check=False,
    capture_output=True,
    text=True,
    close_fds=True,
    stdin=subprocess.DEVNULL,
)
os.lseek(secret_fd, 0, os.SEEK_SET)
outer_secret_fd_valid = os.read(secret_fd, 4096) == b"observer-secret"
os.close(secret_fd)
thread.join(timeout=5)
listener.close()
participant = json.loads(Path("/participant-state/result.json").read_text())
trusted = {
    "nested_returncode": child.returncode,
    "nested_stderr": child.stderr[-4096:],
    "echo_observed": observed,
    "participant": participant,
    "observer_secret_unchanged": Path("/observer/secret").read_text() == "observer-secret",
    "observer_evidence_unchanged": Path("/observer/evidence").read_text() == "observer-evidence",
    "tool_canary_unchanged": Path("/outer-tools/canary").read_text() == "immutable",
    "outer_secret_fd_valid": outer_secret_fd_valid,
}
path = Path("/observer/outer-result.json")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, (json.dumps(trusted, sort_keys=True) + "\n").encode())
finally:
    os.close(fd)
raise SystemExit(0 if child.returncode == 0 and not thread.is_alive() else 1)
'''


class NestedParticipantNamespaceTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PILOT_TEST_BWRAP"), "explicit Bubblewrap qualification required")
    def test_nested_participant_inherits_only_outer_network(self):
        supplied = Path(os.environ["PILOT_TEST_BWRAP"])
        bwrap = _validate_executable(supplied, "bwrap", expected_name="bwrap")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            observer = root / "observer"
            participant = root / "participant-state"
            tools = root / "tools"
            for directory in (observer, participant, tools):
                directory.mkdir(mode=0o700)
            (observer / "secret").write_text("observer-secret")
            (observer / "evidence").write_text("observer-evidence")
            (tools / "canary").write_text("immutable")
            (tools / "child.py").write_text(textwrap.dedent(CHILD))
            outer = root / "outer.py"
            outer.write_text(textwrap.dedent(OUTER))
            for path in (observer / "secret", observer / "evidence", tools / "canary", tools / "child.py", outer):
                path.chmod(0o600)

            argv = [
                str(bwrap), "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net",
                "--cap-drop", "ALL", "--clearenv", "--setenv", "HOME", "/participant-state",
                "--setenv", "LANG", "C.UTF-8", "--setenv", "OUTER_SECRET", "outer-only-secret",
                "--ro-bind", "/usr", "/usr",
            ]
            for system_path in (Path("/lib"), Path("/lib64")):
                if system_path.exists():
                    argv.extend(["--ro-bind", str(system_path), str(system_path)])
            argv.extend([
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run",
                "--ro-bind", str(bwrap), "/pilot-bwrap",
                "--ro-bind", str(tools), "/outer-tools",
                "--bind", str(observer), "/observer",
                "--bind", str(participant), "/participant-state",
                "--ro-bind", str(outer), "/outer.py",
                "--chdir", "/participant-state", "--", "/usr/bin/python3", "/outer.py",
            ])
            result = run_owned(
                argv,
                cwd=root,
                env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                timeout_seconds=20,
                stop_grace_seconds=2,
                log_limit_bytes=64 * 1024,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self.assertFalse(result.timed_out)
            self.assertFalse(result.cleanup_uncertain)
            self.assertFalse(result.stdout_truncated)
            self.assertFalse(result.stderr_truncated)

            trusted = json.loads((observer / "outer-result.json").read_text())
            child = trusted["participant"]
            self.assertEqual(trusted["nested_returncode"], 0, trusted["nested_stderr"])
            self.assertEqual(trusted["echo_observed"], {"message": "participant-ping"})
            self.assertEqual(child["echo"], "outer-echo:participant-ping")
            self.assertFalse(child["outer_env_secret_visible"])
            self.assertFalse(child["observer_secret_visible"])
            self.assertFalse(child["observer_evidence_visible"])
            self.assertTrue(child["observer_write_blocked"])
            self.assertTrue(child["tool_write_blocked"])
            self.assertFalse(child["outer_process_visible"])
            self.assertFalse(child["observer_secret_in_regular_fd"])
            self.assertFalse(child["outer_secret_in_regular_fd"])
            self.assertFalse(child["pid1_root_observer_secret_visible"])
            self.assertEqual(child["visible_pids"], ["1", "2"])
            self.assertTrue(trusted["observer_secret_unchanged"])
            self.assertTrue(trusted["observer_evidence_unchanged"])
            self.assertTrue(trusted["tool_canary_unchanged"])
            self.assertTrue(trusted["outer_secret_fd_valid"])
            self.assertEqual((observer / "secret").read_text(), "observer-secret")
            self.assertEqual((observer / "evidence").read_text(), "observer-evidence")
            self.assertEqual((tools / "canary").read_text(), "immutable")
            self.assertEqual((observer / "outer-result.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((participant / "result.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()