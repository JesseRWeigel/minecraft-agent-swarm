"""Real optional qualification of shared loopback and read-only tool mounts."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from tools.pilot.server import _build_sandbox_argv, run_owned


class SharedNamespaceTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PILOT_TEST_BWRAP"), "explicit Bubblewrap qualification required")
    def test_child_client_reaches_private_server_but_cannot_modify_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            tools = root / "tools"
            tools.mkdir()
            canary = tools / "pinned.txt"
            canary.write_text("immutable")
            source = r"""
import errno,json,socket,subprocess,sys
from pathlib import Path
listener=socket.socket()
listener.bind(('127.0.0.1',0))
listener.listen(1)
listener.settimeout(3)
child_code="import socket,sys; s=socket.create_connection(('127.0.0.1',int(sys.argv[1])),timeout=2); s.sendall(b'private-client'); s.close()"
child=subprocess.Popen(['/usr/bin/python3','-c',child_code,str(listener.getsockname()[1])])
with listener.accept()[0] as connection:
    observed=connection.recv(64).decode()
listener.close()
returncode=child.wait(timeout=3)
readonly=False
try:
    Path('/pilot-tools/pinned.txt').write_text('corrupted')
except OSError as error:
    readonly=error.errno in (errno.EROFS,errno.EACCES,errno.EPERM)
Path('result.json').write_text(json.dumps({'message':observed,'child_returncode':returncode,'readonly':readonly}))
"""
            argv = _build_sandbox_argv(
                runtime,
                bwrap_path=Path(os.environ["PILOT_TEST_BWRAP"]),
                command=["/usr/bin/python3", "-c", source],
            )
            marker = argv.index("--proc")
            argv[marker:marker] = ["--ro-bind", str(tools), "/pilot-tools"]
            result = run_owned(argv, cwd=runtime, env={"PATH": "/usr/bin"}, timeout_seconds=8,
                               stop_grace_seconds=0.5, log_limit_bytes=4096)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self.assertFalse(result.cleanup_uncertain)
            self.assertEqual(json.loads((runtime / "result.json").read_text()), {
                "message": "private-client", "child_returncode": 0, "readonly": True,
            })
            self.assertEqual(canary.read_text(), "immutable")


if __name__ == "__main__":
    unittest.main()
