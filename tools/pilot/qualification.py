"""Prepare and run one fresh, private, network-isolated qualification runtime."""
from __future__ import annotations
import hashlib
import json
import math
import os
import secrets
from pathlib import Path
from tools.pilot import prepare as prep
from tools.pilot import restore as restore_mod
from tools.pilot.client_tools import verify_tools
from tools.pilot.server import _build_sandbox_argv, _validate_executable, run_owned
QUAL_PROPERTIES = 'server-ip=127.0.0.1\nserver-port=25585\nlevel-name=ai-world\nenable-rcon=true\nrcon.port=25595\nenable-query=false\nenable-status=false\nonline-mode=false\nenforce-secure-profile=false\nmax-players=5\nview-distance=4\nsimulation-distance=4\nenable-command-block=false\nsync-chunk-writes=true\n'

class QualificationError(ValueError):
    pass

def _private_new(path):
    p = Path(path)
    if not p.is_absolute():
        raise QualificationError('qualification workspace must be absolute')
    try:
        prep._reject_symlink_components(p, 'qualification workspace', include_leaf=False)
    except prep.PreparationError as exc:
        raise QualificationError(str(exc)) from exc
    if p.exists() or p.is_symlink():
        raise QualificationError('qualification workspace must be new')
    p.mkdir(mode=0o700, parents=False)
    os.chmod(p, 0o700)
    return p

def _write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)

def _sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def _capture_json(path, maximum):
    try:
        fd, info = prep._open_regular(Path(path), 'qualification evidence', maximum)
    except (prep.PreparationError, OSError):
        return (None, None)
    try:
        if info.st_mode & 0o077:
            return (None, None)
        chunks = []
        remaining = info.st_size
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                return (None, None)
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1) or prep._archive_signature(info) != prep._archive_signature(os.fstat(fd)):
            return (None, None)
    finally:
        os.close(fd)
    raw = b''.join(chunks)
    try:
        return (json.loads(raw), hashlib.sha256(raw).hexdigest())
    except (UnicodeError, json.JSONDecodeError):
        return (None, None)

def _position(value):
    if not isinstance(value, dict):
        return None
    items = [value.get(key) for key in ("x", "y", "z")]
    if any(type(item) not in (int, float) for item in items):
        return None
    point = tuple(float(item) for item in items)
    return point if all(math.isfinite(item) for item in point) else None


def _evidence(path, mode):
    value, digest = _capture_json(path, 1024 * 1024)
    identity_valid = (
        isinstance(value, dict)
        and type(value.get("schemaVersion")) is int and value.get("schemaVersion") == 1
        and value.get("movementMode") == mode
        and value.get("username") == "PilotProbe"
        and value.get("minecraftVersion") == "1.21.4"
        and value.get("claimsLiveBenchmarkResult") is False
        and value.get("endpoint")
        == {"host": "127.0.0.1", "gamePort": 25585, "rconPort": 25595}
    )
    if not identity_valid:
        return None, None, False
    before = value.get("before")
    after = value.get("after")
    mineflayer = value.get("mineflayer")
    checks = value.get("checks")
    if not all(isinstance(item, dict) for item in (before, after, mineflayer, checks)):
        return value, digest, False
    before_position = _position(before.get("position"))
    after_position = _position(after.get("position"))
    mine_after = _position(mineflayer.get("after"))
    if None in (before_position, after_position, mine_after):
        return value, digest, False
    horizontal = math.hypot(
        after_position[0] - before_position[0],
        after_position[2] - before_position[2],
    )
    agreement = math.dist(after_position, mine_after)
    common = (
        isinstance(after.get("health"), (int, float))
        and not isinstance(after.get("health"), bool)
        and math.isfinite(after["health"])
        and after["health"] > 0
        and before.get("dimension") in {
            "minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"
        }
        and before.get("dimension") == after.get("dimension")
        and agreement <= 1.5
        and value.get("handshakeSent") is True
        and checks.get("transportIntact") is True
        and checks.get("initialPositionsAgree") is True
        and checks.get("terminalSettled") is True
    )
    if mode == "forward":
        valid = value.get("status") == "passed" and common and 0.5 <= horizontal <= 10
    else:
        valid = value.get("status") == "failed" and common and 0 <= horizontal < 0.5
    return value, digest, valid


def _worker_outcome(path, mode):
    value, digest = _capture_json(path, 65536)
    fields = {
        "schema_version", "status", "readiness", "client", "client_returncode",
        "java_returncode", "stop_sent", "term_sent", "kill_sent",
    }
    if not isinstance(value, dict) or set(value) != fields:
        return None, digest, False
    base = (
        type(value.get("schema_version")) is int
        and value.get("schema_version") == 1
        and value.get("readiness") == "ready"
        and value.get("client") == "exited"
        and type(value.get("java_returncode")) is int
        and value.get("java_returncode") == 0
        and value.get("stop_sent") is True
        and value.get("term_sent") is False
        and value.get("kill_sent") is False
    )
    expected = (
        value.get("status") == ("passed" if mode == "forward" else "failed")
        and type(value.get("client_returncode")) is int
        and value.get("client_returncode") == (0 if mode == "forward" else 1)
    )
    return value, digest, base and expected

def run_qualification(*, workspace, restore_kwargs, tool_snapshot, tool_manifest_sha256, movement_mode='forward', bwrap_path=Path('/usr/bin/bwrap'), runner=run_owned, restore_fn=restore_mod.restore, validate_executables=True):
    if movement_mode not in {'forward', 'stationary'}:
        raise QualificationError('invalid movement mode')
    workspace = _private_new(workspace)
    runtime = workspace / 'runtime'
    tools_input = Path(tool_snapshot)
    if validate_executables:
        bwrap_path = _validate_executable(Path(bwrap_path), 'bwrap', expected_name='bwrap')
    verify_tools(tools_input, tool_manifest_sha256)
    tools = tools_input.resolve(strict=True)
    required = [tools / 'bin/node', tools / 'qualification-client.mjs', tools / 'node_modules']
    if any((not p.exists() or p.is_symlink() for p in required)):
        raise QualificationError('incomplete qualification tool snapshot')
    secret_path = None
    result = None
    worker_outcome = None
    worker_digest = None
    evidence_value = None
    evidence_digest = None
    error = None
    try:
        manifest = restore_fn(output=runtime, **restore_kwargs)
        manifest_path = runtime / 'runtime-manifest.json'
        manifest_sha = _sha(manifest_path)
        restore_mod.verify_runtime(runtime, manifest_sha)
        original_properties = _sha(runtime / 'server.properties')
        password = secrets.token_urlsafe(32)
        properties = QUAL_PROPERTIES + f'rcon.password={password}\n'
        (runtime / 'server.properties').write_text(properties)
        os.chmod(runtime / 'server.properties', 0o600)
        config_hash = _sha(runtime / 'server.properties')
        secret_path = runtime / '.qualification-rcon-password'
        _write(secret_path, (password + '\n').encode())
        evidence = runtime / 'qualification-evidence.json'
        controller_source = prep._capture_file(Path(__file__), "qualification controller", 1024 * 1024)
        controller_hash = controller_source.sha256
        worker_source = Path(__file__).with_name('namespace_worker.py').resolve(strict=True)
        code = workspace / 'code'
        code.mkdir(mode=0o700)
        worker = code / 'namespace_worker.py'
        _write(worker, worker_source.read_bytes())
        worker_hash = _sha(worker)
        java = _validate_executable(Path('/usr/bin/java'), 'Java', expected_name='java', allowed_root=Path('/usr/lib/jvm')) if validate_executables else Path('/usr/bin/java')
        python_source = Path('/usr/bin/python3').resolve(strict=True)
        python = _validate_executable(python_source, 'Python', expected_name=python_source.name, allowed_root=Path('/usr')) if validate_executables else python_source
        command = [str(python), '/pilot-code/namespace_worker.py', str(evidence), movement_mode]
        argv = _build_sandbox_argv(runtime, bwrap_path=Path(bwrap_path), command=command)
        marker = argv.index('--proc')
        argv[marker:marker] = ['--ro-bind', str(tools), '/pilot-tools', '--ro-bind', str(code), '/pilot-code']
        try:
            result = runner(argv, cwd=runtime, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, timeout_seconds=180, stop_grace_seconds=15, log_limit_bytes=1024 * 1024)
        except Exception:
            error = 'qualification launch failed'
        worker_outcome, worker_digest, worker_valid = _worker_outcome(runtime / 'namespace-result.json', movement_mode)
        evidence_value, evidence_digest, evidence_valid = _evidence(evidence, movement_mode)
        expected_returncode = 0 if movement_mode == 'forward' else 1
        clean = result is not None and result.returncode == expected_returncode and (not result.timed_out) and (not result.cleanup_uncertain) and (not result.stdout_truncated) and (not result.stderr_truncated)
        completed = movement_mode == 'forward' and clean and worker_valid and evidence_valid
        negative_control = movement_mode == 'stationary' and clean and worker_valid and evidence_valid
        summary = {
            "schema_version": 1,
            "status": "completed" if completed else "failed",
            "movement_mode": movement_mode,
            "negative_control_observed": negative_control,
            "runtime_manifest_sha256": manifest_sha,
            "snapshot_sha256": manifest.get("snapshot_sha256"),
            "server_jar_sha256": manifest.get("server_jar_sha256"),
            "qualification_config": {
                "base_server_properties_sha256": original_properties,
                "qualification_server_properties_sha256": config_hash,
                "online_mode": False,
                "enforce_secure_profile": False,
                "game_port": 25585,
                "rcon_port": 25595,
                "retained_private_rcon_credential": True,
            },
            "controller_sha256": controller_hash,
            "worker_sha256": worker_hash,
            "tool_manifest_sha256": tool_manifest_sha256,
            "tool_client_sha256": _sha(tools / "qualification-client.mjs"),
            "evidence_sha256": evidence_digest,
            "namespace_result_sha256": worker_digest,
            "independent_observer_process": False,
            "claim_limit": (
                "Same-process Mineflayer and RCON qualification only; "
                "not an independent observer or benchmark result."
            ),
            "process": result.to_dict() if result else None,
            "namespace_lifecycle": worker_outcome,
            "error": error,
        }
        _write(workspace / 'qualification-summary.json', (json.dumps(summary, sort_keys=True, indent=2) + '\n').encode())
        return summary
    finally:
        if secret_path is not None:
            secret_path.unlink(missing_ok=True)
