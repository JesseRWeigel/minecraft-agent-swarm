"""Prepare pinned prospective pilot inputs without extracting or executing them."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import errno
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
from typing import Any, BinaryIO


SCHEMA_VERSION = 1
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_IDENTITY_BYTES = 1024 * 1024
DEFAULT_MAX_ARCHIVE_BYTES = 8 * 1024**3
DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024**3
DEFAULT_MAX_MEMBERS = 100_000
DEFAULT_RESERVE_BYTES = 40 * 1024**3
MAX_TAR_ZERO_PADDING = 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_COMMIT = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_BUDGET_FIELDS = {
    "max_steps", "timeout_seconds", "max_provider_requests",
    "max_input_tokens", "max_output_tokens",
}
_CONDITION_KINDS = {"baseline", "coordination", "coaching"}


class PreparationError(ValueError):
    """Prospective pilot inputs are incomplete, inconsistent, or unsafe."""


@dataclass(frozen=True)
class CapturedFile:
    path: Path
    raw: bytes
    sha256: str


@dataclass(frozen=True)
class LoadedPlan:
    plan: dict[str, Any]
    plan_file: CapturedFile
    refs: dict[str, CapturedFile]
    snapshot: dict[str, Any]
    reset: dict[str, Any]
    model: dict[str, Any]
    scenarios: dict[str, Any]
    configs: dict[str, dict[str, Any]]


def _reject_symlink_components(path: Path, label: str, include_leaf: bool = True) -> None:
    candidate = path.absolute()
    parts = candidate.parts if include_leaf else candidate.parts[:-1]
    current = Path(parts[0])
    for part in parts[1:]:
        current /= part
        if current.is_symlink():
            raise PreparationError(f"{label} path may not contain a symlink: {current}")


def _open_regular(path: Path, label: str, max_bytes: int) -> tuple[int, os.stat_result]:
    _reject_symlink_components(path, label, include_leaf=False)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise PreparationError(f"{label} may not be a symlink: {path}") from exc
        raise PreparationError(f"cannot open {label}: {path}: {exc}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise PreparationError(f"{label} must be a regular non-symlink file: {path}")
        if info.st_size > max_bytes:
            raise PreparationError(f"{label} exceeds the {max_bytes}-byte safety limit")
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def _capture_file(path: Path, label: str, max_bytes: int) -> CapturedFile:
    fd, _ = _open_regular(path, label, max_bytes)
    try:
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > max_bytes or os.read(fd, 1):
            raise PreparationError(f"{label} exceeds the {max_bytes}-byte safety limit")
    finally:
        os.close(fd)
    return CapturedFile(path, raw, hashlib.sha256(raw).hexdigest())


def _unique_object(items: list[tuple[str, Any]], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise PreparationError(f"{label} contains duplicate JSON key: {key}")
        result[key] = value
    return result


def _finite_float(value: str, label: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise PreparationError(f"{label} contains non-finite number: {value}")
    return parsed


def _parse_json(captured: CapturedFile, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            captured.raw,
            parse_constant=lambda value: (_ for _ in ()).throw(
                PreparationError(f"{label} contains non-finite constant: {value}")
            ),
            parse_float=lambda value: _finite_float(value, label),
            object_pairs_hook=lambda items: _unique_object(items, label),
        )
    except PreparationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise PreparationError(f"{label} must be valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise PreparationError(f"{label} must be a JSON object")
    return value


def _require_schema(value: dict[str, Any], label: str) -> None:
    if type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise PreparationError(f"{label}.schema_version must be integer 1")


def _require_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise PreparationError(f"{label} must be a stable lowercase identifier")
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PreparationError(f"{label} must be a non-empty string")
    return value


def _safe_relative(value: Any, label: str) -> str:
    value = _require_text(value, label)
    pure = PurePosixPath(value)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise PreparationError(f"{label} must be a safe relative path")
    return value


def _load_ref(base: Path, ref: Any, label: str) -> CapturedFile:
    if not isinstance(ref, dict) or set(ref) != {"path", "sha256"}:
        raise PreparationError(f"{label} must contain exactly path and sha256")
    relative = _safe_relative(ref["path"], f"{label}.path")
    expected = ref["sha256"]
    if not isinstance(expected, str) or not _SHA256.fullmatch(expected):
        raise PreparationError(f"{label}.sha256 must be lowercase SHA-256")
    captured = _capture_file(base.joinpath(*PurePosixPath(relative).parts), label, MAX_JSON_BYTES)
    if captured.sha256 != expected:
        raise PreparationError(
            f"{label} hash mismatch: expected {expected}, observed {captured.sha256}"
        )
    return captured


def _load_plan(path: Path) -> LoadedPlan:
    plan_file = _capture_file(path, "prospective plan", MAX_JSON_BYTES)
    plan = _parse_json(plan_file, "prospective plan")
    required = {
        "schema_version", "kind", "plan_id", "seeds", "budgets", "snapshot_manifest",
        "reset_manifest", "model_manifest", "scenario_manifest", "conditions", "code",
    }
    if set(plan) != required:
        raise PreparationError(f"prospective plan must contain exactly {sorted(required)}")
    _require_schema(plan, "prospective plan")
    if plan["kind"] != "prospective_pilot_plan":
        raise PreparationError("prospective plan.kind must be prospective_pilot_plan")
    _require_id(plan["plan_id"], "prospective plan.plan_id")
    seeds = plan["seeds"]
    if not isinstance(seeds, list) or len(seeds) < 2 or any(
        type(seed) is not int or seed < 0 for seed in seeds
    ) or len(set(seeds)) != len(seeds):
        raise PreparationError("prospective plan.seeds must have two unique non-negative integers")
    budgets = plan["budgets"]
    if not isinstance(budgets, dict) or set(budgets) != _BUDGET_FIELDS:
        raise PreparationError(f"prospective plan.budgets must contain exactly {sorted(_BUDGET_FIELDS)}")
    for field, value in budgets.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise PreparationError(f"prospective plan.budgets.{field} must be positive")
        if field != "timeout_seconds" and type(value) is not int:
            raise PreparationError(f"prospective plan.budgets.{field} must be an integer")
    code = plan["code"]
    if not isinstance(code, dict) or set(code) != {"source_identity"}:
        raise PreparationError("prospective plan.code must contain exactly source_identity")
    source = code["source_identity"]
    if not isinstance(source, dict) or set(source) != {"kind", "identity"} or source.get("kind") != "git_commit" or not isinstance(source.get("identity"), str) or not _GIT_COMMIT.fullmatch(source["identity"]):
        raise PreparationError("prospective plan code source identity must be a full Git commit")

    base = path.parent
    ref_keys = ("snapshot_manifest", "reset_manifest", "model_manifest", "scenario_manifest")
    refs = {key: _load_ref(base, plan[key], key) for key in ref_keys}
    parsed = {key: _parse_json(refs[key], key) for key in ref_keys}
    snapshot, reset, model, scenarios = (parsed[key] for key in ref_keys)
    if set(snapshot) != {"schema_version", "archive_format", "archive_sha256", "synthetic"}:
        raise PreparationError("snapshot_manifest has unsupported fields")
    _require_schema(snapshot, "snapshot_manifest")
    if snapshot["archive_format"] not in {"tar", "tar.zst"} or type(snapshot["synthetic"]) is not bool or not isinstance(snapshot["archive_sha256"], str) or not _SHA256.fullmatch(snapshot["archive_sha256"]):
        raise PreparationError("snapshot_manifest has invalid archive identity")
    if set(reset) != {"schema_version", "world_id", "server_version", "snapshot_sha256", "reset_procedure"}:
        raise PreparationError("reset_manifest has unsupported fields")
    _require_schema(reset, "reset_manifest")
    _require_id(reset["world_id"], "reset_manifest.world_id")
    _require_text(reset["server_version"], "reset_manifest.server_version")
    _require_text(reset["reset_procedure"], "reset_manifest.reset_procedure")
    if reset["snapshot_sha256"] != snapshot["archive_sha256"]:
        raise PreparationError("reset_manifest snapshot hash must match snapshot_manifest")
    if snapshot["synthetic"] and reset["reset_procedure"] != "synthetic_fixture":
        raise PreparationError("synthetic snapshot requires reset_procedure synthetic_fixture")
    if not snapshot["synthetic"] and reset["reset_procedure"] == "synthetic_fixture":
        raise PreparationError("non-synthetic snapshot cannot use synthetic reset_procedure")
    if set(model) != {"schema_version", "provider", "model", "version"}:
        raise PreparationError("model_manifest has unsupported fields")
    _require_schema(model, "model_manifest")
    for field in ("provider", "model", "version"):
        _require_text(model[field], f"model_manifest.{field}")
    if set(scenarios) != {"schema_version", "scenarios"}:
        raise PreparationError("scenario_manifest has unsupported fields")
    _require_schema(scenarios, "scenario_manifest")
    if not isinstance(scenarios["scenarios"], list) or not scenarios["scenarios"]:
        raise PreparationError("scenario_manifest.scenarios must be a non-empty list")
    scenario_ids = [_require_id(item.get("id") if isinstance(item, dict) else None, "scenario id") for item in scenarios["scenarios"]]
    if len(set(scenario_ids)) != len(scenario_ids):
        raise PreparationError("scenario IDs must be unique")
    for index, scenario in enumerate(scenarios["scenarios"]):
        if scenario.get("task") not in {
            "navigate_to_region", "acquire_item", "shared_resource_handoff",
            "recover_after_injected_failure",
        } or not isinstance(scenario.get("goal"), dict):
            raise PreparationError(f"scenario[{index}] has an unsupported task or goal")

    conditions = plan["conditions"]
    if not isinstance(conditions, list) or not conditions:
        raise PreparationError("prospective plan.conditions must be non-empty")
    configs: dict[str, dict[str, Any]] = {}
    ids: set[str] = set()
    baseline_count = 0
    for index, condition in enumerate(conditions):
        if not isinstance(condition, dict) or set(condition) != {"id", "kind", "config"}:
            raise PreparationError(f"condition[{index}] has unsupported fields")
        condition_id = _require_id(condition["id"], f"condition[{index}].id")
        if condition_id in ids:
            raise PreparationError(f"duplicate condition ID: {condition_id}")
        ids.add(condition_id)
        if condition["kind"] not in _CONDITION_KINDS:
            raise PreparationError(f"condition[{index}].kind is unsupported")
        baseline_count += condition["kind"] == "baseline"
        captured = _load_ref(base, condition["config"], f"condition[{index}].config")
        config = _parse_json(captured, f"condition[{index}].config")
        _require_schema(config, f"condition[{index}].config")
        if config.get("condition_id") != condition_id or config.get("kind") != condition["kind"]:
            raise PreparationError(f"condition[{index}] config identity does not match")
        refs[f"condition:{condition_id}"] = captured
        configs[condition_id] = config
    if baseline_count != 1:
        raise PreparationError("prospective plan requires exactly one baseline")
    return LoadedPlan(plan, plan_file, refs, snapshot, reset, model, scenarios, configs)


def _load_identity(path: Path, loaded: LoadedPlan) -> CapturedFile:
    captured = _capture_file(path, "runtime identity", MAX_IDENTITY_BYTES)
    identity = _parse_json(captured, "runtime identity")
    required = {"schema_version", "provider", "model", "version", "conditions"}
    if set(identity) != required:
        raise PreparationError("runtime identity has unsupported fields")
    _require_schema(identity, "runtime identity")
    actual = tuple(identity.get(field) for field in ("provider", "model", "version"))
    expected = tuple(loaded.model[field] for field in ("provider", "model", "version"))
    if actual != expected or any(not isinstance(value, str) or not value for value in actual):
        raise PreparationError("runtime model identity does not match the frozen model manifest")
    expected_conditions = {
        item["id"]: item["config"]["sha256"] for item in loaded.plan["conditions"]
    }
    if identity.get("conditions") != expected_conditions:
        raise PreparationError("runtime condition config identity does not match the frozen plan")
    return captured


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_destination(output: Path, sources: list[Path]) -> Path:
    if output.exists() or output.is_symlink():
        raise PreparationError(f"destination already exists: {output}")
    _reject_symlink_components(output, "destination", include_leaf=False)
    parent = output.parent.resolve(strict=True)
    if not parent.is_dir():
        raise PreparationError("destination parent must be an existing directory")
    resolved_output = output.resolve(strict=False)
    for source in sources:
        resolved_source = source.resolve(strict=True)
        overlap = _contains(resolved_output, resolved_source)
        if resolved_source.is_dir():
            overlap = overlap or _contains(resolved_source, resolved_output)
        if overlap:
            raise PreparationError(f"destination and source paths must not overlap: {output} and {source}")
    return parent


def _archive_signature(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _hash_fd(fd: int) -> str:
    os.lseek(fd, 0, os.SEEK_SET)
    hasher = hashlib.sha256()
    while chunk := os.read(fd, 1024 * 1024):
        hasher.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return hasher.hexdigest()


def _validate_member(member: tarfile.TarInfo) -> None:
    pure = PurePosixPath(member.name)
    if not member.name or "\\" in member.name or pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise PreparationError(f"unsafe archive member path: {member.name!r}")
    if not (member.isfile() or member.isdir()) or member.size < 0:
        raise PreparationError(f"unsafe archive member type: {member.name!r}")


def _scan_tar_stream(stream: BinaryIO, max_members: int, max_expanded_bytes: int) -> dict[str, int]:
    members = regular_files = expanded_bytes = 0
    member_names: set[str] = set()
    try:
        with tarfile.open(fileobj=stream, mode="r|", bufsize=512) as archive:
            while True:
                member = archive.next()
                if member is None:
                    break
                members += 1
                if members > max_members:
                    raise PreparationError("archive exceeds the member-count safety limit")
                _validate_member(member)
                normalized_name = str(PurePosixPath(member.name))
                if normalized_name in member_names:
                    raise PreparationError(f"duplicate archive member path: {member.name!r}")
                member_names.add(normalized_name)
                if member.isfile():
                    regular_files += 1
                    expanded_bytes += member.size
                    if expanded_bytes > max_expanded_bytes:
                        raise PreparationError("archive exceeds the expanded-byte safety limit")
                    source = archive.extractfile(member)
                    if source is None:
                        raise PreparationError("world archive is not a valid tar stream")
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise PreparationError("world archive is not a valid tar stream")
                        remaining -= len(chunk)
                    if source.read(1):
                        raise PreparationError("archive member exceeds its declared size")
                archive.members.clear()
        trailing = stream.read(MAX_TAR_ZERO_PADDING + 1)
        if len(trailing) > MAX_TAR_ZERO_PADDING or any(trailing):
            raise PreparationError("archive contains nonzero or excessive trailing data")
    except PreparationError:
        raise
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise PreparationError("world archive is not a valid tar stream") from exc
    return {"member_count": members, "regular_file_count": regular_files, "expanded_bytes": expanded_bytes}


def _scan_archive(fd: int, name: str, max_members: int, max_expanded_bytes: int) -> dict[str, int]:
    os.lseek(fd, 0, os.SEEK_SET)
    if name.endswith(".tar"):
        with os.fdopen(os.dup(fd), "rb", closefd=True) as stream:
            return _scan_tar_stream(stream, max_members, max_expanded_bytes)
    if not name.endswith(".tar.zst"):
        raise PreparationError("world archive must end in .tar or .tar.zst")
    zstd = shutil.which("zstd")
    if zstd is None:
        raise PreparationError("zstd is required to inspect a .tar.zst archive")
    compressed = os.fdopen(os.dup(fd), "rb", closefd=True)
    process = subprocess.Popen([zstd, "-dc"], stdin=compressed, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    compressed.close()
    assert process.stdout is not None
    try:
        scan = _scan_tar_stream(process.stdout, max_members, max_expanded_bytes)
        process.stdout.close()
        return_code = process.wait(timeout=10)
        assert process.stderr is not None
        stderr = process.stderr.read(64 * 1024 + 1)
        if len(stderr) > 64 * 1024 or return_code != 0:
            raise PreparationError(f"zstd could not decode world archive: {stderr[:65536].decode(errors='replace').strip()}")
        return scan
    except BaseException:
        process.kill()
        process.wait()
        raise


def _mkdir_private(path: Path) -> None:
    path.mkdir(mode=0o700)
    path.chmod(0o700)


def _ensure_private_directory(path: Path, root: Path) -> None:
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current /= part
        current.mkdir(exist_ok=True, mode=0o700)
        current.chmod(0o700)


def _write_private(path: Path, raw: bytes, root: Path) -> None:
    _ensure_private_directory(path.parent, root)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as destination:
            destination.write(raw)
            destination.flush()
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def _copy_archive_fd(fd: int, destination: Path, expected_hash: str, root: Path) -> tuple[str, int]:
    _ensure_private_directory(destination.parent, root)
    out_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    hasher = hashlib.sha256(); total = 0
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        while chunk := os.read(fd, 1024 * 1024):
            view = memoryview(chunk)
            while view:
                written = os.write(out_fd, view)
                view = view[written:]
            hasher.update(chunk); total += len(chunk)
        os.fchmod(out_fd, 0o600)
    finally:
        os.close(out_fd)
    observed = hasher.hexdigest()
    if observed != expected_hash:
        raise PreparationError("world archive changed while being copied")
    return observed, total


def prepare(plan_path: Path, archive_path: Path, identity_path: Path, output_path: Path, *, max_archive_bytes: int = DEFAULT_MAX_ARCHIVE_BYTES, max_expanded_bytes: int = DEFAULT_MAX_EXPANDED_BYTES, max_members: int = DEFAULT_MAX_MEMBERS, reserve_bytes: int = DEFAULT_RESERVE_BYTES) -> dict[str, Any]:
    plan_path, archive_path, identity_path, output_path = map(Path, (plan_path, archive_path, identity_path, output_path))
    for value, label, allow_zero in ((max_archive_bytes, "max_archive_bytes", False), (max_expanded_bytes, "max_expanded_bytes", False), (max_members, "max_members", False), (reserve_bytes, "reserve_bytes", True)):
        if isinstance(value, bool) or not isinstance(value, int) or value < (0 if allow_zero else 1):
            raise PreparationError(f"{label} must be {'non-negative' if allow_zero else 'positive'} integer")
    loaded = _load_plan(plan_path)
    identity_file = _load_identity(identity_path, loaded)
    output_parent = _validate_destination(output_path, [plan_path.parent, archive_path, identity_path])
    archive_fd, initial_info = _open_regular(archive_path, "world archive", max_archive_bytes)
    created = False
    try:
        expected_archive_hash = loaded.snapshot["archive_sha256"]
        archive_hash = _hash_fd(archive_fd)
        if archive_hash != expected_archive_hash:
            raise PreparationError(f"snapshot SHA-256 mismatch: expected {expected_archive_hash}, observed {archive_hash}")
        expected_suffix = ".tar.zst" if loaded.snapshot["archive_format"] == "tar.zst" else ".tar"
        if not archive_path.name.endswith(expected_suffix):
            raise PreparationError("world archive filename does not match snapshot archive_format")
        archive_scan = _scan_archive(archive_fd, archive_path.name, max_members, max_expanded_bytes)
        input_bytes = initial_info.st_size + len(loaded.plan_file.raw) + len(identity_file.raw) + sum(len(item.raw) for item in loaded.refs.values())
        free_bytes = shutil.disk_usage(output_parent).free
        if free_bytes - input_bytes < reserve_bytes:
            raise PreparationError(f"copy would cross the {reserve_bytes}-byte free-space reserve")
        _mkdir_private(output_path); created = True
        copied: list[dict[str, Any]] = []
        _write_private(output_path / "plan" / "plan.json", loaded.plan_file.raw, output_path)
        copied.append({"path": "plan/plan.json", "sha256": loaded.plan_file.sha256, "bytes": len(loaded.plan_file.raw)})
        for key, captured in sorted(loaded.refs.items()):
            relative = loaded.plan[key]["path"] if key in loaded.plan else next(item["config"]["path"] for item in loaded.plan["conditions"] if f"condition:{item['id']}" == key)
            destination = output_path / "plan" / relative
            _write_private(destination, captured.raw, output_path)
            copied.append({"path": f"plan/{relative}", "sha256": captured.sha256, "bytes": len(captured.raw)})
        _write_private(output_path / "runtime-identity.json", identity_file.raw, output_path)
        copied.append({"path": "runtime-identity.json", "sha256": identity_file.sha256, "bytes": len(identity_file.raw)})
        archive_destination = output_path / "inputs" / archive_path.name
        copied_hash, copied_bytes = _copy_archive_fd(archive_fd, archive_destination, expected_archive_hash, output_path)
        if _archive_signature(os.fstat(archive_fd)) != _archive_signature(initial_info):
            raise PreparationError("world archive changed during preparation")
        copied.append({"path": f"inputs/{archive_path.name}", "sha256": copied_hash, "bytes": copied_bytes})
        manifest = {
            "schema_version": 1, "status": "prepared_not_run", "live_ready": False, "reset_performed": False,
            "claim_limit": "Frozen prospective inputs only; no reset, server, provider, trial, or outcome was run or established.",
            "source": {"kind": loaded.plan["kind"], "plan_id": loaded.plan["plan_id"], "plan_sha256": loaded.plan_file.sha256, "code_source_identity": loaded.plan["code"]["source_identity"]},
            "snapshot": {"path": f"inputs/{archive_path.name}", "sha256": copied_hash, "bytes": copied_bytes, "synthetic": loaded.snapshot["synthetic"], "world_id": loaded.reset["world_id"], "server_version": loaded.reset["server_version"]},
            "archive_scan": archive_scan,
            "storage_preflight": {"free_bytes_before": free_bytes, "input_bytes": input_bytes, "reserve_bytes": reserve_bytes},
            "runtime_identity_sha256": identity_file.sha256, "copied_files": copied,
        }
        raw_manifest = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        _write_private(output_path / "manifest.json", raw_manifest, output_path)
        return manifest
    except BaseException:
        if created:
            shutil.rmtree(output_path)
        raise
    finally:
        os.close(archive_fd)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0: raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0: raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare prospective pilot inputs; never runs a trial.")
    sub = parser.add_subparsers(dest="command", required=True).add_parser("prepare")
    sub.add_argument("--plan", required=True, type=Path); sub.add_argument("--world-archive", required=True, type=Path)
    sub.add_argument("--runtime-identity", required=True, type=Path); sub.add_argument("--output", required=True, type=Path)
    sub.add_argument("--max-archive-bytes", type=_positive_int, default=DEFAULT_MAX_ARCHIVE_BYTES)
    sub.add_argument("--max-expanded-bytes", type=_positive_int, default=DEFAULT_MAX_EXPANDED_BYTES)
    sub.add_argument("--max-members", type=_positive_int, default=DEFAULT_MAX_MEMBERS)
    sub.add_argument("--reserve-bytes", type=_nonnegative_int, default=DEFAULT_RESERVE_BYTES)
    args = parser.parse_args(argv)
    try:
        manifest = prepare(args.plan, args.world_archive, args.runtime_identity, args.output, max_archive_bytes=args.max_archive_bytes, max_expanded_bytes=args.max_expanded_bytes, max_members=args.max_members, reserve_bytes=args.reserve_bytes)
    except (PreparationError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2
    manifest_path = args.output / "manifest.json"
    summary = {"status": manifest["status"], "manifest": str(manifest_path), "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()}
    print(json.dumps(summary, sort_keys=True)); return 0


if __name__ == "__main__":
    raise SystemExit(main())
