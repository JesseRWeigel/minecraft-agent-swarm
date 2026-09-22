"""Inner-side fixed local game proxy and participant launcher.

Executed in the participant's separate network namespace. No observer mount,
credential, arbitrary target, command argument, or forwarding request exists.
"""
import json
import socket
import subprocess
import sys
import threading
import time
from game_bridge import GAME_ENDPOINT, pump


def main():
    if len(sys.argv) not in {2, 3} or sys.argv[1] not in {"forward", "stationary"}:
        return 2
    probe = len(sys.argv) == 3
    if probe and (sys.argv[2] != "permissions" or sys.argv[1] != "stationary"):
        return 2
    stop = threading.Event()
    outcome = {"status": "waiting"}
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(GAME_ENDPOINT)
    listener.listen(1)
    listener.settimeout(0.1)
    def relay():
        try:
            while not stop.is_set():
                try:
                    client, _ = listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                return
            listener.close()
            with client, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as bridge:
                bridge.settimeout(2)
                bridge.connect("/game-bridge/game.sock")
                outcome.update(pump(client, bridge, stop))
        except Exception as error:
            outcome.update(status="failed", error_type=type(error).__name__, errno=getattr(error,"errno",None))
        finally:
            listener.close()
    thread = threading.Thread(target=relay, daemon=True)
    child = None
    thread.start()
    try:
        child = subprocess.Popen(["/pilot-tools/bin/node", "--max-old-space-size=256",
            "/participant-code/protected-participant-cli.mjs", "--trial-id", "movement-fixture-v1",
            "--action-id", "walk-01", "--movement", sys.argv[1]] + (["--command-probe", "permissions"] if probe else []), close_fds=True)
        deadline = time.monotonic()+175
        while child.poll() is None:
            if outcome["status"] == "failed" or time.monotonic() >= deadline:
                raise RuntimeError("game bridge failed")
            time.sleep(0.05)
        # A successful child must also have a fully drained, normally closed
        # relay. Cancellation in finally is cleanup, never success evidence.
        thread.join(timeout=2)
        if outcome["status"] != "completed" or thread.is_alive():
            print(json.dumps({"relay":outcome,"child_returncode":child.returncode,"relay_alive":thread.is_alive()}),file=sys.stderr,flush=True)
            raise RuntimeError("game bridge did not complete")
        return child.returncode
    finally:
        if child is not None and child.poll() is None:
            child.kill(); child.wait(timeout=2)
        stop.set()
        thread.join(timeout=3)
        if thread.is_alive():
            raise RuntimeError("game bridge cleanup uncertain")


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        print("participant bridge failed", file=sys.stderr)
        code = 1
    raise SystemExit(code)
