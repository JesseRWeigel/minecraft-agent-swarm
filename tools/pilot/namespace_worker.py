"""Fixed in-namespace Java/qualification supervisor. No arbitrary commands."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path


def write_result(path, value):
    fd = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        raw = (json.dumps(value, sort_keys=True) + "\n").encode()
        view = memoryview(raw)
        while view:
            view = view[os.write(fd, view) :]
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def wait_port(port, deadline, server):
    while time.monotonic() < deadline:
        if server.poll() is not None:
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in {"forward", "stationary"}:
        raise SystemExit("evidence path and fixed movement mode required")
    evidence = Path(sys.argv[1])
    movement = sys.argv[2]
    result_path = Path.cwd() / "namespace-result.json"
    secret = (Path.cwd() / ".qualification-rcon-password").read_text().strip()
    outcome = {
        "schema_version": 1,
        "status": "failed",
        "readiness": "not_ready",
        "client": "not_started",
        "client_returncode": None,
        "java_returncode": None,
        "stop_sent": False,
        "term_sent": False,
        "kill_sent": False,
    }
    server = None
    try:
        env = {"HOME": str(Path.cwd()), "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"}
        server = subprocess.Popen(
            [
                "/usr/bin/java",
                "-Xms1G",
                "-Xmx2G",
                "-Djava.awt.headless=true",
                "-jar",
                "server.jar",
                "--nogui",
            ],
            stdin=subprocess.PIPE,
            stdout=sys.stdout,
            stderr=sys.stderr,
            env=env,
        )
        deadline = time.monotonic() + 60
        ready = wait_port(25585, deadline, server) and wait_port(25595, deadline, server)
        if not ready:
            outcome["readiness"] = "timeout" if server.poll() is None else "early_exit"
        else:
            outcome["readiness"] = "ready"
            client_argv = [
                "/pilot-tools/bin/node",
                "/pilot-tools/qualification-client.mjs",
                "--output",
                str(evidence),
            ]
            if movement == "stationary":
                client_argv.append("--stationary")
            try:
                client = subprocess.run(
                    client_argv,
                    env={**env, "PILOT_RCON_PASSWORD": secret},
                    timeout=90,
                    check=False,
                )
                outcome["client_returncode"] = client.returncode
                outcome["client"] = "exited"
            except subprocess.TimeoutExpired:
                outcome["client"] = "timeout"
    except Exception:
        outcome["readiness"] = "launch_or_runtime_failure"
    finally:
        if server is not None:
            if server.poll() is None:
                try:
                    server.stdin.write(b"stop\n")
                    server.stdin.flush()
                    outcome["stop_sent"] = True
                    server.wait(timeout=15)
                except Exception:
                    if server.poll() is None:
                        server.terminate()
                        outcome["term_sent"] = True
                        try:
                            server.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            server.kill()
                            outcome["kill_sent"] = True
                            server.wait()
            outcome["java_returncode"] = server.returncode
        passed = (
            outcome["readiness"] == "ready"
            and outcome["client_returncode"] == 0
            and outcome["java_returncode"] == 0
            and outcome["stop_sent"]
            and not outcome["term_sent"]
            and not outcome["kill_sent"]
        )
        outcome["status"] = "passed" if passed else "failed"
        write_result(result_path, outcome)
    return 0 if outcome["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())