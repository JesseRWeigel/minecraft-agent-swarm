"""Fail-closed cgroup scope around the complete fixed-client trial tree.

The scope worker is captured outside the game mounts before launch. Only the
host supervisor sees its reports or the systemd user-manager socket.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

PROFILES = {
    "game": {"memory": 4*1024**3, "tasks": 256, "cpu_percent": 200},
    "memory_failure": {"memory": 128*1024**2, "tasks": 256, "cpu_percent": 200},
}


def write_new(path, value):
    raw = (json.dumps(value, sort_keys=True)+"\n").encode()
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(raw)
        while view: view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def read_values(directory):
    values = {key:(directory/name).read_text().strip() for key,name in (
        ("memory","memory.max"),("swap","memory.swap.max"),("tasks","pids.max"),("cpu","cpu.max"))}
    for name in ("memory.events", "pids.events", "cpu.stat"):
        values[name] = {k:int(v) for k,v in (line.split() for line in (directory/name).read_text().splitlines())}
    return values


def limits_match(values, profile):
    if profile not in PROFILES or not isinstance(values, dict): return False
    policy = PROFILES[profile]
    if (values.get("memory"),values.get("swap"),values.get("tasks")) != (str(policy["memory"]),"0",str(policy["tasks"])):
        return False
    try:
        quota, period = map(int, values["cpu"].split())
        return quota > 0 and period > 0 and quota*100 == period*policy["cpu_percent"]
    except (KeyError,TypeError,ValueError,AttributeError): return False


def no_violations(before, after):
    for name, keys in (("memory.events", ("max","oom","oom_kill","oom_group_kill")), ("pids.events", ("max",))):
        for key in keys:
            a, b = before.get(name,{}).get(key), after.get(name,{}).get(key)
            if type(a) is not int or type(b) is not int or a < 0 or b != a: return False
    return True


def worker(config_path):
    config_raw = config_path.read_bytes()
    config = json.loads(config_raw)
    config_sha256 = hashlib.sha256(config_raw).hexdigest()
    unit, profile = config["unit"], config["profile"]
    lines = Path("/proc/self/cgroup").read_text().splitlines()
    if len(lines) != 1 or not lines[0].startswith("0::/"): return 2
    relative = lines[0][4:]
    if Path(relative).name != unit or ".." in Path(relative).parts: return 2
    group = (Path("/sys/fs/cgroup")/relative).resolve(strict=True)
    group.relative_to("/sys/fs/cgroup")
    before = read_values(group)
    start = {"schema_version":1,"unit":unit,"profile":profile,"effective":before,
             "source_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
             "config_sha256":config_sha256,
             "limits_verified":limits_match(before,profile)}
    write_new(config_path.parent/'start.json',start)
    if not start["limits_verified"]: return 2  # never spawn the trial on missing/incorrect limits
    child = subprocess.Popen(config["argv"], cwd=config["cwd"], env=config["env"], close_fds=True)
    code = child.wait()
    after = read_values(group)
    finish = {"schema_version":1,"unit":unit,"profile":profile,"effective":after,
              "child_returncode":code,"limits_verified":limits_match(after,profile),
              "no_limit_violations":no_violations(before,after)}
    write_new(config_path.parent/'end.json',finish)
    return 0 if code == 0 and finish["limits_verified"] and finish["no_limit_violations"] else 1


def validate_evidence(start, end, profile, unit, source_sha256, config_sha256):
    if not isinstance(start,dict) or not isinstance(end,dict): return False
    for value in (start,end):
        if (type(value.get("schema_version")) is not int or value["schema_version"] != 1
                or value.get("profile") != profile or value.get("unit") != unit
                or value.get("limits_verified") is not True
                or not limits_match(value.get("effective"),profile)): return False
    return (start.get("source_sha256") == source_sha256 and start.get("config_sha256") == config_sha256
            and type(end.get("child_returncode")) is int
            and end["child_returncode"] == 0 and end.get("no_limit_violations") is True
            and no_violations(start["effective"],end["effective"]))


def cleanup(unit, env):
    result = {"confirmed":False}
    try:
        subprocess.run(["/usr/bin/systemctl","--user","stop",unit],env=env,capture_output=True,timeout=5)
        process = subprocess.run(["/usr/bin/systemctl","--user","show",unit,
            "--property=ActiveState","--property=ControlGroup","--property=Result"],env=env,capture_output=True,timeout=5)
        fields = dict(line.split("=",1) for line in process.stdout.decode().splitlines() if "=" in line)
        result.update(active_state=fields.get("ActiveState"),unit_result=fields.get("Result"))
        if fields.get("ActiveState") not in {"inactive","failed"} or "ControlGroup" not in fields: return result
        group = fields["ControlGroup"]
        if not group:
            result["confirmed"] = True
        elif group.startswith("/") and ".." not in Path(group).parts and Path(group).name == unit:
            path = Path("/sys/fs/cgroup")/group.lstrip("/")
            if not path.exists(): result["confirmed"] = True
            else:
                events = dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
                result["confirmed"] = events.get("populated") == "0"
    except Exception: pass
    return result


def run_scoped(argv, *, workspace, cwd, env, profile="game", runner=None):
    if profile not in PROFILES: raise ValueError("invalid resource profile")
    from tools.pilot.server import run_owned, _validate_executable
    from tools.pilot import prepare
    runner = runner or run_owned
    for name in ("systemd-run","systemctl"):
        _validate_executable(Path('/usr/bin')/name,name,expected_name=name)
    python = Path("/usr/bin/python3").resolve(strict=True)
    _validate_executable(python,"Python",expected_name=python.name,allowed_root=Path("/usr"))
    directory = Path(workspace)/'resources'
    directory.mkdir(mode=0o700)
    source = prepare._capture_file(Path(__file__),"resource scope worker",1024*1024)
    helper = directory/'worker.py'
    fd=os.open(helper,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'wb') as stream: stream.write(source.raw)
    unit = 'codex-game-trial-'+uuid.uuid4().hex+'.scope'
    config = directory/'config.json'
    write_new(config,{"unit":unit,"profile":profile,"argv":argv,"cwd":str(cwd),"env":env})
    config_sha256 = prepare._capture_file(config,"resource launch config",1024*1024).sha256
    policy=PROFILES[profile]
    scope_env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8","XDG_RUNTIME_DIR":f"/run/user/{os.getuid()}"}
    command=["/usr/bin/systemd-run","--user","--scope","--quiet","--unit="+unit,
        "--property=MemoryMax="+str(policy['memory']),"--property=MemorySwapMax=0",
        "--property=TasksMax="+str(policy['tasks']),"--property=CPUQuota="+str(policy['cpu_percent'])+'%',
        "--property=OOMPolicy=stop","--property=RuntimeMaxSec=210",
        str(python),str(helper),"--worker",str(config)]
    process=None
    evidence={"schema_version":1,"profile":profile,"unit":unit,"source_sha256":source.sha256,"config_sha256":config_sha256,
              "start":None,"end":None,"valid":False}
    try:
        process=runner(command,cwd=cwd,env=scope_env,timeout_seconds=180,stop_grace_seconds=10,log_limit_bytes=1024*1024)
    finally:
        evidence['cleanup']=cleanup(unit,scope_env)
        for phase in ('start','end'):
            path=directory/(phase+'.json')
            if path.exists():
                try:
                    raw=prepare._capture_file(path,"resource evidence",65536)
                    evidence[phase]=json.loads(raw.raw)
                    evidence[phase+'_sha256']=raw.sha256
                except Exception: pass
        evidence['valid']=(evidence['cleanup']['confirmed'] and validate_evidence(evidence['start'],evidence['end'],profile,unit,source.sha256,config_sha256))
        write_new(directory/'summary.json',evidence)
    return process,evidence


if __name__ == '__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='--worker': raise SystemExit(2)
    try: code=worker(Path(sys.argv[2]))
    except Exception: code=2
    raise SystemExit(code)
