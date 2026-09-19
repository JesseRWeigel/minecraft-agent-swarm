"""Prepare and run one fresh, private, network-isolated qualification runtime."""
from __future__ import annotations
import hashlib,json,os,secrets,stat
from pathlib import Path
from tools.pilot import restore as restore_mod
from tools.pilot.server import _build_sandbox_argv,_validate_executable,run_owned,ProcessError

from tools.pilot.client_tools import verify_tools
QUAL_PROPERTIES="""server-ip=127.0.0.1
server-port=25585
level-name=ai-world
enable-rcon=true
rcon.port=25595
enable-query=false
enable-status=false
online-mode=false
enforce-secure-profile=false
max-players=5
view-distance=4
simulation-distance=4
enable-command-block=false
sync-chunk-writes=true
"""
class QualificationError(ValueError): pass

def _private_new(path):
 p=Path(path)
 if p.exists() or p.is_symlink(): raise QualificationError("qualification workspace must be new")
 p.mkdir(mode=0o700,parents=False);os.chmod(p,0o700);return p

def _write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
 try: os.write(fd,data);os.fchmod(fd,0o600)
 finally: os.close(fd)

def _sha(path):
 h=hashlib.sha256()
 with Path(path).open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
 return h.hexdigest()

def _passed_evidence(path):
 try:
  info=path.stat()
  if info.st_mode & 0o077 or info.st_size>1024*1024:return False
  return json.loads(path.read_text()).get("status")=="passed"
 except (OSError,ValueError,AttributeError):return False

def _worker_outcome(path):
 try:
  info=path.stat()
  if info.st_mode & 0o077 or info.st_size>65536:return None
  value=json.loads(path.read_text())
  fields={"schema_version","status","readiness","client","client_returncode","java_returncode","stop_sent","term_sent","kill_sent"}
  if not isinstance(value,dict) or set(value)!=fields:return None
  return value
 except (OSError,ValueError,AttributeError):return None

def run_qualification(*,workspace,restore_kwargs,tool_snapshot,tool_manifest_sha256,bwrap_path=Path("/usr/bin/bwrap"),runner=run_owned,restore_fn=restore_mod.restore,validate_bwrap=True):
 workspace=_private_new(workspace);runtime=workspace/"runtime";tools_input=Path(tool_snapshot)
 if validate_bwrap: bwrap_path=_validate_executable(Path(bwrap_path),"bwrap",expected_name="bwrap")
 if validate_bwrap: bwrap_path=_validate_executable(Path(bwrap_path),"bwrap",expected_name="bwrap",allowed_root=Path("/opt/codex-pilot-tools"))
 verify_tools(tools_input,tool_manifest_sha256)
 tools=tools_input.resolve(strict=True)
 required=[tools/"bin/node",tools/"qualification-client.mjs",tools/"node_modules"]
 if any(not p.exists() or p.is_symlink() for p in required):raise QualificationError("incomplete qualification tool snapshot")
 try:
  manifest=restore_fn(output=runtime,**restore_kwargs)
  manifest_path=runtime/"runtime-manifest.json";manifest_sha=_sha(manifest_path)
  restore_mod.verify_runtime(runtime,manifest_sha)
  original_properties=_sha(runtime/"server.properties")
  password=secrets.token_urlsafe(32)
  properties=QUAL_PROPERTIES+f"rcon.password={password}\n"
  (runtime/"server.properties").write_text(properties);os.chmod(runtime/"server.properties",0o600)
  secret_path=runtime/".qualification-rcon-password";_write(secret_path,(password+chr(10)).encode())
  evidence=runtime/"qualification-evidence.json"
  worker_source=Path(__file__).with_name("namespace_worker.py").resolve(strict=True)
  code=workspace/"code";code.mkdir(mode=0o700);worker=code/"namespace_worker.py";_write(worker,worker_source.read_bytes());worker_hash=_sha(worker)
  java=_validate_executable(Path("/usr/bin/java"),"Java",expected_name="java",allowed_root=Path("/usr/lib/jvm")) if validate_bwrap else Path("/usr/bin/java")
  python_source=Path("/usr/bin/python3").resolve(strict=True);python=_validate_executable(python_source,"Python",expected_name=python_source.name,allowed_root=Path("/usr")) if validate_bwrap else python_source
  argv=_build_sandbox_argv(runtime,bwrap_path=Path(bwrap_path),command=[str(python),"/pilot-code/namespace_worker.py",str(evidence)])
  marker=argv.index("--proc");argv[marker:marker]=["--ro-bind",str(tools),"/pilot-tools","--ro-bind",str(code),"/pilot-code"]
  result=runner(argv,cwd=runtime,env={"PATH":"/usr/bin:/bin","LANG":"C"},timeout_seconds=180,stop_grace_seconds=15,log_limit_bytes=1024*1024)
  worker_outcome=_worker_outcome(runtime/"namespace-result.json")
  summary={"schema_version":1,"status":"completed" if worker_outcome is not None and worker_outcome.get("status")=="passed" and result.returncode==0 and not result.timed_out and not result.cleanup_uncertain and not result.stdout_truncated and not result.stderr_truncated and _passed_evidence(evidence) else "failed","runtime_manifest_sha256":manifest_sha,"snapshot_sha256":manifest.get("snapshot_sha256"),"server_jar_sha256":manifest.get("server_jar_sha256"),"qualification_config":{"base_server_properties_sha256":original_properties,"online_mode":False,"enforce_secure_profile":False,"game_port":25585,"rcon_port":25595},"worker_sha256":worker_hash,"tool_manifest_sha256":tool_manifest_sha256,"qualification_server_properties_sha256":_sha(runtime/"server.properties"),"tool_client_sha256":_sha(tools/"qualification-client.mjs"),"independent_observer_process":False,"claim_limit":"Same-process Mineflayer and RCON qualification only; not an independent observer or benchmark result.","process":result.to_dict(),"namespace_lifecycle":worker_outcome}
  _write(workspace/"qualification-summary.json",(json.dumps(summary,sort_keys=True,indent=2)+"\n").encode())
  return summary
 finally:
  if "secret_path" in locals(): secret_path.unlink(missing_ok=True)
  password=None
