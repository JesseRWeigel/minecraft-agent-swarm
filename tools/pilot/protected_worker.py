"""Fixed-client experiment supervisor, invoked only inside the outer namespace.

The host controller supplies immutable code and tools. This module is not a
standalone host launcher and never supplies observer credentials to the child.
"""
import json
import math
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time

from tools.pilot.participant_transport import ParticipantTransport

TRIAL = "movement-fixture-v1"
ACTION = "walk-01"
FIXTURE_SHA256 = "3a696ca577186c8d2f308fd07fa31d72a3c2a4d98018beb2e64afacd5b358ac7"


def write_result(path, value):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(raw)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def participant_argv(mode):
    if mode not in {"forward", "stationary"}:
        raise ValueError("invalid fixed movement mode")
    args = ["/pilot-bwrap", "--die-with-parent", "--new-session",
            "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
            "--cap-drop", "ALL", "--clearenv",
            "--setenv", "HOME", "/participant-state", "--setenv", "LANG", "C.UTF-8",
            "--ro-bind", "/usr", "/usr"]
    for path in ("/lib", "/lib64"):
        if Path(path).exists():
            args.extend(["--ro-bind", path, path])
    args.extend(["--proc", "/proc", "--dev", "/dev",
                 "--size", "16777216", "--tmpfs", "/tmp",
                 "--size", "16777216", "--tmpfs", "/participant-state",
                 "--ro-bind", "/pilot-tools", "/pilot-tools",
                 "--ro-bind", "/participant-code", "/participant-code",
                 "--chdir", "/participant-state", "--",
                 "/pilot-tools/bin/node", "--max-old-space-size=256",
                 "/participant-code/protected-participant-cli.mjs",
                 "--trial-id", TRIAL, "--action-id", ACTION, "--movement", mode])
    return args


def capture_process(argv, request, *, timeout=30, stdout_limit=65536, stderr_limit=4096):
    """Bound a trusted helper's pipes and lifetime; retain bounded failed output.

    stdin contains a small supervisor request, never participant-controlled data.
    The namespace owns descendant cleanup in addition to this helper's group.
    """
    payload = (json.dumps(request, separators=(",", ":")) + "\n").encode()
    if len(payload) > 4096:
        raise ValueError("oversize observer request")
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, close_fds=True, start_new_session=True, bufsize=0,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    selector = selectors.DefaultSelector()
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": stdout_limit, "stderr": stderr_limit}
    error = None
    started = time.monotonic()
    deadline = started + timeout
    pending = memoryview(payload)
    try:
        for stream, label, event in ((process.stdin, "stdin", selectors.EVENT_WRITE),
                                    (process.stdout, "stdout", selectors.EVENT_READ),
                                    (process.stderr, "stderr", selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, event, label)
        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                error = "observer_deadline"
                break
            for key, _ in selector.select(min(0.05, remaining)):
                stream, label = key.fileobj, key.data
                if label == "stdin":
                    try:
                        count = os.write(stream.fileno(), pending)
                    except BlockingIOError:
                        continue
                    if count <= 0:
                        raise OSError("observer input unavailable")
                    pending = pending[count:]
                    if not pending:
                        selector.unregister(stream)
                        stream.close()
                else:
                    try:
                        data = os.read(stream.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not data:
                        selector.unregister(stream)
                        continue
                    available = limits[label] - len(captured[label])
                    captured[label].extend(data[:available])
                    if len(data) > available:
                        error = "observer_output_limit"
                        break
            if error:
                break
        if time.monotonic() >= deadline:
            error = "observer_deadline"
    except (OSError, ValueError):
        error = "observer_transport_failure"
    finally:
        if error or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            error = "observer_cleanup_uncertain"
        selector.close()
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed:
                stream.close()
    return {"returncode": process.returncode, "error": error,
            "stdout": bytes(captured["stdout"]), "stderr": bytes(captured["stderr"]),
            "pid": process.pid, "started_monotonic": started, "finished_monotonic": time.monotonic()}


def observe(phase, password):
    captured = capture_process(
        ["/pilot-tools/bin/node", "--max-old-space-size=256", "/observer-code/protected-observer-cli.mjs"],
        {"schema_version": 1, "phase": phase, "trial_id": TRIAL, "action_id": ACTION,
         "password": password})
    # Preserve even malformed/truncated output privately; no caller's raw text is logged.
    name = Path.cwd() / ("observer-" + phase)
    for channel in ("stdout", "stderr"):
        fd = os.open(str(name) + "." + channel, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(captured[channel])
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
    value = None
    try:
        value = json.loads(captured["stdout"])
    except (ValueError, UnicodeError, RecursionError):
        pass
    result = {"returncode": captured["returncode"], "error": captured["error"], "result": value,
              "pid": captured["pid"], "started_monotonic": captured["started_monotonic"],
              "finished_monotonic": captured["finished_monotonic"]}
    write_result(str(name) + ".json", result)
    if captured["error"] or captured["returncode"] != 0 or not isinstance(value, dict):
        raise RuntimeError("observer failed")
    return value


def valid_sample(value, phase):
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != 1 or value.get("status") != "sampled":
        return False
    if (value.get("source"), value.get("actor"), value.get("phase"), value.get("trialId"), value.get("actionId")) != (
            "server_rcon", "PilotProbe", phase, TRIAL, ACTION):
        return False
    obs = value.get("observations", {})
    if not isinstance(obs, dict):
        return False
    point = obs.get("position", {})
    if not isinstance(point, dict):
        return False
    numbers = [point.get(k) for k in ("x", "y", "z")] + [obs.get("health")]
    if any(type(n) not in (int, float) for n in numbers):
        return False
    try:
        return (all(math.isfinite(n) and abs(n) <= 30_000_000 for n in numbers)
                and obs.get("dimension") == "minecraft:overworld" and 0 < obs["health"] <= 20)
    except (ValueError, OverflowError):
        return False


def score(before, terminal, mode):
    """Server observations alone determine movement, never child claims."""
    failed = {"movement_succeeded": False, "negative_control_observed": False, "observations_valid": False}
    if mode not in {"forward", "stationary"} or not valid_sample(before, "before") or not valid_sample(terminal, "terminal"):
        return failed
    b, a = before["observations"], terminal["observations"]
    bp, ap = b["position"], a["position"]
    if b["health"] != 20 or any(abs(bp[k] - target) > 0.05 for k, target in (("x", 0.5), ("y", 200), ("z", 0.5))):
        return failed
    dx, dy, dz = [ap[k] - bp[k] for k in ("x", "y", "z")]
    distance = math.hypot(dx, dz)
    straight = abs(dx) <= 0.1 and abs(dy) <= 0.05
    return {"observations_valid": True, "horizontal_displacement": distance,
            "delta": {"x": dx, "y": dy, "z": dz},
            "movement_succeeded": mode == "forward" and straight and 0.5 <= dz <= 10,
            "negative_control_observed": mode == "stationary" and straight and distance < 0.05}


def fixture_valid(value):
    if not isinstance(value, dict) or value.get("schema_version") != 1 or value.get("phase") != "fixture":
        return False
    setup = value.get("setup")
    if not isinstance(setup, dict) or setup.get("status") != "configured":
        return False
    fixture = setup.get("fixture")
    if not isinstance(fixture, dict) or fixture.get("sha256") != FIXTURE_SHA256:
        return False
    checks = setup.get("baselineChecks")
    if not isinstance(checks, list) or len(checks) != 5 or any(not isinstance(c, dict) or c.get("status") != "verified" for c in checks):
        return False
    if {c.get("name") for c in checks} != {"orientation", "inventory", "game_mode", "food", "effects"}:
        return False
    if value.get("baselineVerification") != {"status": "verified"}:
        return False
    baseline = value.get("baseline")
    if not valid_sample(baseline, "before"):
        return False
    return score(baseline, {**baseline, "phase": "terminal"}, "stationary")["negative_control_observed"]


def stop_server(server, result):
    """Attempt every cleanup stage even when a pipe or earlier wait fails."""
    if server is None:
        return
    try:
        if server.poll() is None:
            try:
                server.stdin.write(b"stop\n"); server.stdin.flush()
                result["stop_sent"] = True
                server.wait(timeout=15)
            except Exception:
                pass
        if server.poll() is None:
            result["term_sent"] = True
            try:
                server.terminate(); server.wait(timeout=5)
            except Exception:
                pass
        if server.poll() is None:
            result["kill_sent"] = True
            try:
                server.kill(); server.wait(timeout=5)
            except Exception:
                result["error"] = "server_cleanup_uncertain"
        result["java_returncode"] = server.poll()
    finally:
        try:
            server.stdin.close()
        except Exception:
            result["error"] = "server_pipe_cleanup_failed"


def wait_port(port, deadline, server):
    while time.monotonic() < deadline:
        if server.poll() is not None:
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"forward", "stationary"}:
        return 2
    # A host invocation cannot mistake this module for an unrestricted launcher.
    host_netns = Path("/observer-code/host-network-namespace").read_text().strip()
    if os.readlink("/proc/self/ns/net") == host_netns:
        raise RuntimeError("outer private network required")
    mode = sys.argv[1]
    password = Path(".qualification-rcon-password").read_text().strip()
    result = {"schema_version": 1, "status": "failed", "movement_mode": mode,
              "trial_id": TRIAL, "action_id": ACTION, "independent_observer_process": False,
              "participant_returncode": None, "java_returncode": None,
              "stop_sent": False, "term_sent": False, "kill_sent": False,
              "before": None, "terminal": None, "fixture": None, "score": None,
              "participant_forced_cleanup": False, "error": None}
    server = participant = transport = None
    try:
        server = subprocess.Popen(["/usr/bin/java", "-Xms512M", "-Xmx2G", "-Djava.awt.headless=true",
            "-jar", "server.jar", "--nogui"], stdin=subprocess.PIPE, close_fds=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(Path.cwd())})
        deadline = time.monotonic() + 60
        if not (wait_port(25585, deadline, server) and wait_port(25595, deadline, server)):
            raise RuntimeError("server readiness failed")
        participant = subprocess.Popen(participant_argv(mode), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, close_fds=True, bufsize=0, env={"PATH": "/usr/bin:/bin"})
        transport = ParticipantTransport(participant, trial_id=TRIAL, action_id=ACTION)
        transport.wait_ready()
        result["fixture"] = observe("fixture", password)
        if not fixture_valid(result["fixture"]):
            raise RuntimeError("fixture verification failed")
        result["before"] = observe("before", password)
        result["independent_observer_process"] = True
        result["participant_pid"] = participant.pid
        if not valid_sample(result["before"], "before") or not score(result["before"], {**result["before"], "phase": "terminal"}, "stationary")["negative_control_observed"]:
            raise RuntimeError("fixed actor baseline failed")
        transport.send_begin()
        transport.wait_action_finished()
        # Allow residual ordinary physics to settle while client remains connected.
        time.sleep(0.3)
        result["terminal"] = observe("terminal", password)
        result["score"] = score(result["before"], result["terminal"], mode)
        transport.send_finalize()
        transport.wait_exit()
    except Exception:
        result["error"] = "protected_qualification_failed"
    finally:
        if participant is not None:
            try:
                if participant.poll() is None:
                    result["participant_forced_cleanup"] = True
                    participant.kill()
                    participant.wait(timeout=5)
                result["participant_returncode"] = participant.returncode
            except Exception:
                result["error"] = "participant_cleanup_uncertain"
        if transport is not None:
            try:
                transport.close()
            except Exception:
                result["error"] = "participant_pipe_cleanup_failed"
        try:
            stop_server(server, result)
        except Exception:
            result["error"] = "server_cleanup_uncertain"
        clean = result["error"] is None and result["participant_returncode"] == 0 and result["java_returncode"] == 0 and result["stop_sent"] and not any(result[k] for k in ("term_sent", "kill_sent", "participant_forced_cleanup"))
        accepted = result["score"] and (result["score"]["movement_succeeded"] if mode == "forward" else result["score"]["negative_control_observed"])
        result["status"] = "qualified" if clean and accepted else "failed"
        write_result("protected-result.json", result)
    return 0 if result["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
