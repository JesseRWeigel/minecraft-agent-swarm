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
def reachable(address, family=socket.AF_INET):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            probe.connect(address)
            return True
    except OSError:
        return False

result = {
    "network_namespace": os.readlink("/proc/self/ns/net"),
    "rcon_reachable": reachable(("127.0.0.1", 25595)),
    "other_outer_port_reachable": reachable(("127.0.0.1", 25601)),
    "ipv6_rcon_reachable": reachable(("::1", 25595), socket.AF_INET6),
    "abstract_socket_reachable": reachable("\0outer-private-control", socket.AF_UNIX),
    "bridge_directory_write_blocked": write_blocked("/game-bridge/new-file"),
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
    prefix = bytes.fromhex("10008106093132372e302e302e3163f1021c000a50696c6f7450726f6265f14b12b94db53b00ab8ccdacc19f233d")
    client.sendall(prefix + b"namespace-probe")
    result["echo"] = client.recv(128).decode("utf8")
result["second_game_connection_reachable"] = reachable(("127.0.0.1", 25585))
result["second_bridge_connection_reachable"] = reachable("/game-bridge/game.sock", socket.AF_UNIX)
print(json.dumps(result, sort_keys=True), flush=True)
'''


OUTER = r'''
import json, os, socket, subprocess, threading
from pathlib import Path
from tools.pilot.protected_worker import participant_argv
from tools.pilot.game_bridge import GameBridge

canaries = []
for port in [25595, 25601]:
    canary = socket.socket()
    canary.bind(("127.0.0.1", port)); canary.listen(1)
    canaries.append(canary)
ipv6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
ipv6.bind(("::1", 25595)); ipv6.listen(1)
canaries.append(ipv6)
abstract = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
abstract.bind("\0outer-private-control"); abstract.listen(1)
canaries.append(abstract)
bridge = GameBridge(Path("/runtime/game-bridge"))
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 25585))
listener.listen(1)
listener.settimeout(3)
seen = {}
def echo_once():
    connection, _ = listener.accept()
    with connection:
        prefix = bytes.fromhex("10008106093132372e302e302e3163f1021c000a50696c6f7450726f6265f14b12b94db53b00ab8ccdacc19f233d")
        data = b""
        while len(data) < len(prefix)+len(b"namespace-probe"):
            chunk = connection.recv(128)
            if not chunk: raise RuntimeError("early EOF")
            data += chunk
        assert data.startswith(prefix)
        message = data[len(prefix):]
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
bridge_result = bridge.close()
for canary in canaries: canary.close()
participant = None
try:
    lines = stdout.decode("utf8").splitlines()
    if len(lines) == 1:
        participant = json.loads(lines[0])
except (UnicodeError, ValueError):
    pass
trusted = {
    "bridge": bridge_result,
    "network_namespace": os.readlink("/proc/self/ns/net"),
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
        self.qualify(False)

    @unittest.skipUnless(os.environ.get("PILOT_TEST_BWRAP"), "explicit Bubblewrap qualification required")
    def test_model_action_pipes_cross_production_namespace_without_host_fds(self):
        self.qualify(True)

    def qualify(self, model):
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
            fake_node, outer = textwrap.dedent(FAKE_NODE), textwrap.dedent(OUTER)
            if model:
                fake_node = fake_node.replace('print(json.dumps(result, sort_keys=True), flush=True)', 'assert os.read(3,64) == b"bounded-action"\nos.write(4,b"bounded-reply")\nprint(json.dumps(result, sort_keys=True), flush=True)')
                outer = outer.replace('from tools.pilot.game_bridge import GameBridge', 'from tools.pilot.game_bridge import GameBridge\nfrom tools.pilot.action_descriptors import ActionDescriptors, spawn_action_sandbox')
                outer = outer.replace('try:\n    process = subprocess.Popen(', 'descriptors=ActionDescriptors.create()\nargs=participant_argv("stationary")\nargs[-1]="model"\nargs[args.index("/participant-code/game_bridge_client.py")]="/participant-code/oak_bridge_client.py"\ntry:\n    process = spawn_action_sandbox(')
                outer = outer.replace('participant_argv("stationary"), stdin=subprocess.DEVNULL,', 'args, descriptors, stdin=subprocess.DEVNULL,')
                outer = outer.replace('stderr=subprocess.PIPE, close_fds=True,', 'stderr=subprocess.PIPE,')
                outer = outer.replace('    stdout, stderr = process.communicate(timeout=5)', '    os.write(descriptors.host_write,b"bounded-action")\n    stdout, stderr = process.communicate(timeout=5)\n    import select\n    assert select.select([descriptors.host_read],[],[],2)[0]\n    seen["action_reply"]=os.read(descriptors.host_read,64).decode()')
                outer = outer.replace('    os.close(secret_fd)', '    os.close(secret_fd)\n    descriptors.close_child();descriptors.close_host()')
            files = {
                runtime / "runtime-canary": "runtime-only-canary",
                runtime / "inheritable-secret": "inheritable-host-fd-secret",
                observer / "secret": "observer-only-secret",
                participant_code / "code-canary": "immutable-code",
                pilot_tools / "tool-canary": "immutable-tool",
                pilot_tools / "bin" / "node": fake_node,
                root / "outer.py": outer,
            }
            for name in ("game_bridge.py", "game_bridge_client.py", "oak_bridge_client.py", "action_descriptors.py"):
                files[participant_code / name] = (repository / "tools/pilot" / name).read_text()
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
            self.assertNotEqual(trusted["network_namespace"], participant["network_namespace"])
            self.assertEqual(trusted["bridge"]["connections"], 1)
            self.assertNotIn(trusted["bridge"]["status"], ("failed", "cleanup_uncertain"))
            self.assertTrue(participant["bridge_directory_write_blocked"])
            self.assertEqual(trusted["nested_returncode"], 0, trusted["nested_stderr"])
            self.assertTrue(trusted["echo_thread_finished"])
            self.assertEqual(trusted["echo_observed"], {"request": "namespace-probe", **({"action_reply":"bounded-reply"} if model else {})})
            self.assertEqual(participant["echo"], "private-outer:namespace-probe")
            for key in ("observer_secret_visible", "runtime_canary_visible", "test_source_visible",
                        "host_secret_in_environment", "outer_process_visible",
                        "rcon_reachable", "other_outer_port_reachable", "ipv6_rcon_reachable", "abstract_socket_reachable",
                        "second_game_connection_reachable", "second_bridge_connection_reachable",
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
