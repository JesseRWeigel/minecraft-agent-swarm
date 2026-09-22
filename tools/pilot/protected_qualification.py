"""Explicit isolated fixed-client qualification with a protected observer.

No host game endpoint is used. Every launch restores a new private world,
records source hashes, and preserves failed attempts. This is not a model runner.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets

from tools.pilot import prepare, restore
from tools.pilot.bounded_storage import BoundedStorage
from tools.pilot.client_tools import verify_tools
from tools.pilot.qualification import _private_new, _write, _sha, _capture_json, QUAL_PROPERTIES
from tools.pilot.protected_worker import score, fixture_valid, FAILURE_CASES
from tools.pilot.server import _build_sandbox_argv, _validate_executable, run_owned
from tools.pilot.scoped_trial import run_scoped, PROFILES

PARTICIPANT_FILES = ("protected-participant-cli.mjs", "protected-participant.mjs", "participant-pipes.mjs", "game_bridge.py", "game_bridge_client.py")
OBSERVER_FILES = ("protected-observer-cli.mjs", "protected-observer.mjs", "movement-fixture.mjs")
PYTHON_FILES = ("protected_worker.py", "participant_protocol.py", "participant_transport.py", "game_bridge.py")


def capture_sources(workspace):
    source = Path(__file__).parent
    inventory = {}
    for name, files in (("participant-code", PARTICIPANT_FILES), ("observer-code", OBSERVER_FILES)):
        directory = workspace / name
        directory.mkdir(mode=0o700)
        for filename in files:
            item = prepare._capture_file(source / filename, "protected source", 1024 * 1024)
            _write(directory / filename, item.raw)
            inventory[name + "/" + filename] = item.sha256
        _write(directory / "package.json", b'{"type":"module"}\n')
        # Explicit immutable in-namespace dependency link, never a host lookup.
        (directory / "node_modules").symlink_to("/pilot-tools/node_modules", target_is_directory=True)
    outer = workspace / "observer-code"
    package = outer / "tools" / "pilot"
    package.mkdir(mode=0o700, parents=True)
    for directory in (outer / "tools", package):
        _write(directory / "__init__.py", b"")
    for filename in PYTHON_FILES:
        item = prepare._capture_file(source / filename, "protected worker source", 1024 * 1024)
        _write(package / filename, item.raw)
        inventory["observer-code/tools/pilot/" + filename] = item.sha256
    namespace = os.readlink("/proc/self/ns/net")
    _write(outer / "host-network-namespace", namespace.encode())
    canonical = json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    _write(workspace / "source-manifest.json", json.dumps({"files": inventory, "sha256": digest}, indent=2).encode())
    return digest


def validate_result(value, mode):
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        return False
    if value.get("failure_case", "none") != "none":
        return False
    if value.get("movement_mode") != mode or value.get("trial_id") != "movement-fixture-v1" or value.get("action_id") != "walk-01":
        return False
    if value.get("independent_observer_process") is not True or value.get("status") != "qualified" or value.get("error") is not None:
        return False
    if any(type(value.get(k)) is not int or value[k] != 0 for k in ("participant_returncode", "java_returncode")):
        return False
    if value.get("stop_sent") is not True or any(value.get(k) is not False for k in ("term_sent", "kill_sent", "participant_forced_cleanup")):
        return False
    bridge = value.get("game_bridge")
    if (value.get("network_policy") != "game_only_unix_v1" or not isinstance(bridge, dict)
            or type(bridge.get("connections")) is not int or bridge["connections"] != 1
            or bridge.get("status") != "completed"):
        return False
    if not fixture_valid(value.get("fixture")):
        return False
    # Never trust the serialized score: recompute from authoritative observations.
    verdict = score(value.get("before"), value.get("terminal"), mode)
    return verdict["movement_succeeded"] if mode == "forward" else verdict["negative_control_observed"]


def run_protected_qualification(*, launch=False, workspace, restore_kwargs, tool_snapshot,
                                 tool_manifest_sha256, movement_mode="forward", failure_case="none", resource_profile="game",
                                 storage_tool_root=None, storage_capacity_bytes=2 * 1024**3,
                                 bwrap_path=Path("/usr/bin/bwrap"), runner=run_owned):
    if launch is not True:
        raise ValueError("explicit launch=True required")
    if resource_profile not in PROFILES:
        raise ValueError("invalid resource profile")
    if failure_case not in FAILURE_CASES:
        raise ValueError("invalid fixed failure case")
    if movement_mode not in {"forward", "stationary"}:
        raise ValueError("invalid fixed movement mode")
    if storage_tool_root is None:
        raise ValueError("explicit pinned storage tool root required")
    bwrap = _validate_executable(Path(bwrap_path), "bwrap", expected_name="bwrap")
    _validate_executable(Path("/usr/bin/java"), "Java", expected_name="java", allowed_root=Path("/usr/lib/jvm"))
    python = Path("/usr/bin/python3").resolve(strict=True)
    _validate_executable(python, "Python", expected_name=python.name, allowed_root=Path("/usr"))
    verify_tools(Path(tool_snapshot), tool_manifest_sha256)
    tools = Path(tool_snapshot).resolve(strict=True)
    storage = BoundedStorage(Path(workspace) / "storage", Path(storage_tool_root), capacity_bytes=storage_capacity_bytes)
    workspace = _private_new(workspace)
    summary = {"schema_version": 1, "status": "failed", "movement_mode": movement_mode, "failure_case": failure_case,
               "tool_manifest_sha256": tool_manifest_sha256, "error": None, "resource_profile": resource_profile,
               "independent_observer_process": False,
               "claim_limit": "Fixed deterministic client in nested namespace; no model performance or arbitrary-code resource-containment claim."}
    secret_path = None
    try:
        summary["stage"] = "capture_sources"
        summary["controller_sha256"] = prepare._capture_file(Path(__file__), "protected host controller", 1024*1024).sha256
        source_hash = capture_sources(workspace)
        summary["source_manifest_sha256"] = source_hash
        summary["stage"] = "mount_storage"
        runtime = storage.start() / "runtime"
        secret_path = runtime / ".qualification-rcon-password"
        summary["stage"] = "restore"
        bounded_restore = dict(restore_kwargs)
        # Reserve applies inside the fixed image; host free space is checked by storage.
        bounded_restore["reserve_bytes"] = 64 * 1024**2
        manifest = restore.restore(output=runtime, **bounded_restore)
        runtime_hash = _sha(runtime / "runtime-manifest.json")
        restore.verify_runtime(runtime, runtime_hash)
        summary.update(runtime_manifest_sha256=runtime_hash, snapshot_sha256=manifest["snapshot_sha256"], server_jar_sha256=manifest["server_jar_sha256"])
        secret = secrets.token_urlsafe(32)
        (runtime / "server.properties").write_text(QUAL_PROPERTIES.replace("max-players=5", "max-players=1") + "rcon.password=" + secret + "\n")
        os.chmod(runtime / "server.properties", 0o600)
        summary["profile_sha256"] = _sha(runtime / "server.properties")
        _write(secret_path, (secret + "\n").encode())
        command = [str(python), "-m", "tools.pilot.protected_worker", movement_mode, failure_case]
        args = _build_sandbox_argv(runtime, bwrap_path=bwrap, command=command)
        tmp_index = args.index("--tmpfs")
        args[tmp_index:tmp_index] = ["--size", str(64 * 1024**2)]
        index = args.index("--proc")
        args[index:index] = ["--ro-bind", str(tools), "/pilot-tools",
                             "--ro-bind", str(workspace / "observer-code"), "/observer-code",
                             "--ro-bind", str(workspace / "participant-code"), "/participant-code",
                             "--ro-bind", str(bwrap), "/pilot-bwrap",
                             "--setenv", "PYTHONPATH", "/observer-code"]
        summary["stage"] = "launch"
        process, resources = run_scoped(args, workspace=workspace, cwd=runtime,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, profile=resource_profile, runner=runner)
        summary["resource_scope"] = resources
        summary["stage"] = "validate"
        summary["process"] = process.to_dict()
        result, digest = _capture_json(runtime / "protected-result.json", 1024 * 1024)
        summary["evidence_sha256"] = digest
        level = prepare._capture_file(runtime / "ai-world" / "level.dat", "preserved world metadata", 16 * 1024**2)
        summary["world_level_sha256"] = level.sha256
        summary["result"] = result
        summary["evidence_valid"] = validate_result(result, movement_mode)
        summary["independent_observer_process"] = bool(isinstance(result, dict) and result.get("independent_observer_process") is True)
        clean = process.returncode == 0 and not any((process.timed_out, process.cleanup_uncertain, process.stdout_truncated, process.stderr_truncated))
        summary["status"] = "qualified" if clean and summary["evidence_valid"] and resources["valid"] and resource_profile == "game" else "failed"
    except Exception:
        summary["error"] = "protected_preparation_or_launch_failed"
    finally:
        try:
            if secret_path is not None:
                secret_path.unlink(missing_ok=True)
        except OSError:
            summary["status"] = "failed"
            summary["error"] = "secret_cleanup_failed"
        try:
            summary["storage"] = storage.close()
            if summary["storage"].get("valid") is not True:
                summary["status"] = "failed"
        except Exception:
            summary["status"] = "failed"
            summary["storage"] = {"valid": False, "cleanup_uncertain": True}
        _write(workspace / "protected-summary.json", (json.dumps(summary, indent=2, sort_keys=True) + "\n").encode())
    return summary
