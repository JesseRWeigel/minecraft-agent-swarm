"""Explicit, bounded Linux cgroup enforcement probes; never launch the swarm.

Run with --launch --output NEW_DIRECTORY. Each scenario has its own transient
user scope; no delegation settings, persistent units or live processes change.
"""
import argparse
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

MEMORY_BYTES = 128 * 1024 * 1024
TASKS = 16
SCENARIOS = ("baseline", "memory", "pids", "cpu")


def read_limits(directory):
    values = {key: (directory / name).read_text().strip() for key, name in (
        ("memory", "memory.max"), ("swap", "memory.swap.max"),
        ("pids", "pids.max"), ("cpu", "cpu.max"))}
    return values


def limits_match(values):
    if not isinstance(values, dict):
        return False
    if (values.get("memory"), values.get("swap"), values.get("pids")) != (str(MEMORY_BYTES), "0", str(TASKS)):
        return False
    try:
        quota, period = map(int, values["cpu"].split())
        return quota > 0 and period > 0 and quota * 4 == period
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def counters(path):
    return {name: int(value) for name, value in (line.split() for line in path.read_text().splitlines())}


def cgroup_directory(unit):
    lines = Path("/proc/self/cgroup").read_text().splitlines()
    if len(lines) != 1 or not lines[0].startswith("0::/"):
        raise ValueError("cgroup v2 required")
    relative = lines[0][4:]
    if Path(relative).name != unit or ".." in Path(relative).parts:
        raise ValueError("unexpected cgroup membership")
    directory = (Path("/sys/fs/cgroup") / relative).resolve(strict=True)
    directory.relative_to("/sys/fs/cgroup")
    return directory


def worker(scenario, unit):
    directory = cgroup_directory(unit)
    limits = read_limits(directory)
    result = {"schema_version": 1, "scenario": scenario, "limits": limits,
              "enforcement_observed": False, "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if not limits_match(limits):
        result["error"] = "limits_not_applied"
        return result  # no workload without verified effective kernel limits
    start = time.monotonic()
    if scenario == "baseline":
        result["enforcement_observed"] = True
    elif scenario == "memory":
        before = counters(directory / "memory.events")
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_fd)
            os.setsid()  # detached process groups still inherit the cgroup
            same = cgroup_directory(unit) == directory
            os.write(write_fd, b"same" if same else b"different"); os.close(write_fd)
            allocation = bytearray(256 * 1024 * 1024)
            os._exit(0 if allocation[0] == 0 else 2)
        os.close(write_fd)
        try:
            membership = os.read(read_fd, 16).decode()
            _, status = os.waitpid(child, 0)
        finally:
            os.close(read_fd)
        after = counters(directory / "memory.events")
        result.update(child_same_cgroup_after_setsid=membership == "same", child_exitcode=os.waitstatus_to_exitcode(status),
                      before=before, after=after)
        result["enforcement_observed"] = (membership == "same" and result["child_exitcode"] == -signal.SIGKILL
                                          and after.get("oom_kill", 0) > before.get("oom_kill", 0))
    elif scenario == "pids":
        before = counters(directory / "pids.events")
        children = []; rejected = False
        try:
            for _ in range(32):  # independently finite even on an ineffective controller
                try:
                    child = os.fork()
                except OSError as error:
                    rejected = error.errno == errno.EAGAIN
                    break
                if child == 0:
                    time.sleep(10); os._exit(0)
                children.append(child)
            after = counters(directory / "pids.events")
            result.update(created_children=len(children), fork_rejected=rejected, before=before, after=after)
            result["enforcement_observed"] = rejected and after.get("max", 0) > before.get("max", 0)
        finally:
            for child in children:
                try: os.kill(child, signal.SIGKILL)
                except ProcessLookupError: pass
            for child in children: os.waitpid(child, 0)
    elif scenario == "cpu":
        before = counters(directory / "cpu.stat")
        deadline = time.monotonic()+1.5
        while time.monotonic() < deadline:
            pass
        after = counters(directory / "cpu.stat")
        result.update(before=before, after=after)
        result["enforcement_observed"] = (after.get("nr_throttled", 0) > before.get("nr_throttled", 0)
                                          and after.get("throttled_usec", 0) > before.get("throttled_usec", 0))
    else:
        raise ValueError("invalid scenario")
    result["elapsed_seconds"] = time.monotonic()-start
    result["final_limits"] = read_limits(directory)
    result["enforcement_observed"] &= result["final_limits"] == limits
    return result


def scope_empty(properties):
    """Confirm no scoped tasks remain, not merely a non-active unit label."""
    if properties.get("ActiveState") not in {"inactive", "failed"}:
        return False
    group = properties.get("ControlGroup", "")
    if not group:
        return True  # manager no longer owns a cgroup for this scope
    if not group.startswith("/") or ".." in Path(group).parts:
        return False
    path = Path("/sys/fs/cgroup") / group.lstrip("/")
    try:
        return counters(path / "cgroup.events").get("populated") == 0
    except FileNotFoundError:
        return not path.exists()


def run_probe(scenario, output):
    if scenario not in SCENARIOS:
        raise ValueError("invalid scenario")
    unit = "codex-resource-probe-" + uuid.uuid4().hex + ".scope"
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
    argv = ["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--unit="+unit,
            "--property=MemoryMax="+str(MEMORY_BYTES), "--property=MemorySwapMax=0",
            "--property=OOMPolicy=continue",  # diagnostic recorder must survive child OOM
            "--property=TasksMax="+str(TASKS), "--property=CPUQuota=25%", "--property=RuntimeMaxSec=15",
            "/usr/bin/python3", str(Path(__file__).resolve()), "--worker", scenario, "--unit", unit]
    record = {"schema_version":1, "scenario":scenario, "status":"failed", "unit":unit,
              "started_at_utc":datetime.now(timezone.utc).isoformat(), "result":None,
              "diagnostic_oom_policy":"continue"}
    try:
        completed = subprocess.run(argv, env=env, capture_output=True, timeout=20)
        record.update(returncode=completed.returncode, stderr=completed.stderr[-4096:].decode(errors="replace"))
        record["stdout"] = completed.stdout[-16384:].decode(errors="replace")
        result = json.loads(completed.stdout)
        record["result"] = result
        if (completed.returncode == 0 and result.get("enforcement_observed") is True
                and limits_match(result.get("limits")) and result.get("scenario") == scenario):
            record["status"] = "qualified"
    except Exception:
        record["error"] = "probe_launch_or_evidence_failed"
    finally:
        # Only the uniquely named scope belonging to this invocation is targeted.
        try:
            stopped = subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], env=env,
                                     capture_output=True, timeout=5)
            state = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit, "--property=ActiveState", "--property=ControlGroup"],
                                   env=env, capture_output=True, timeout=5)
            properties = dict(line.split("=",1) for line in state.stdout.decode().splitlines() if "=" in line)
            record["cleanup_state"] = properties.get("ActiveState")
            record["cleanup_confirmed"] = scope_empty(properties)
        except Exception:
            record["cleanup_confirmed"] = False
        if not record["cleanup_confirmed"]:
            record["status"] = "failed"
        (output / (scenario+".json")).write_text(json.dumps(record,indent=2)+"\n")
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=SCENARIOS, help=argparse.SUPPRESS)
    parser.add_argument("--unit", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.unit)), flush=True)
        return 0
    if not args.launch or args.output is None:
        parser.error("explicit --launch and new --output directory required")
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    records = [run_probe(scenario, args.output) for scenario in SCENARIOS]
    print(json.dumps({"schema_version":1, "scope":"Synthetic kernel resource enforcement only; no game or model launched",
                      "results":records},indent=2))
    return 0 if all(r["status"] == "qualified" for r in records) else 1


if __name__ == "__main__": raise SystemExit(main())
