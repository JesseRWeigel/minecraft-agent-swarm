"""Fixed oak-log participant bridge within the isolated game namespace."""
import os
from action_descriptors import validate_action_descriptors
import json
import socket
import subprocess
import sys
import threading
import time
from game_bridge import GAME_ENDPOINT, pump


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"forward", "stationary", "mine_only", "blocked", "model"}:
        return 2
    action_mode = sys.argv[1] == "model"
    if action_mode: validate_action_descriptors(3, 4)
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
            outcome.update(status="failed", error_type=type(error).__name__[:64], errno=getattr(error, "errno", None), relay_diagnostics=getattr(error,"bridge_diagnostics",None))
        finally:
            listener.close()

    thread = threading.Thread(target=relay, daemon=True)
    child = None
    thread.start()
    try:
        child = subprocess.Popen(["/pilot-tools/bin/node", "--max-old-space-size=256", "/participant-code/oak-participant-cli.mjs", "--trial-id", "collect-oak-log-v1", "--action-id", "collect-01", "--movement", sys.argv[1]], close_fds=True, pass_fds=(3,4) if action_mode else ())
        if action_mode:
            os.close(3); os.close(4)
        deadline = time.monotonic() + 175
        while child.poll() is None:
            if outcome["status"] == "failed" or time.monotonic() >= deadline:
                print(json.dumps({"relay":outcome,"child_returncode":child.poll(),"phase":"child_running","deadline_expired":time.monotonic()>=deadline}),file=sys.stderr,flush=True)
                raise RuntimeError("game bridge failed")
            time.sleep(0.05)
        thread.join(timeout=2)
        if outcome["status"] != "completed" or thread.is_alive():
            print(json.dumps({"relay": outcome, "child_returncode": child.returncode, "relay_alive": thread.is_alive()}), file=sys.stderr, flush=True)
            raise RuntimeError("game bridge did not complete")
        return child.returncode
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=2)
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
