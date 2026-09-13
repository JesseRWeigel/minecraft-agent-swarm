"""Prepare verified offline pilot inputs without extracting or executing them."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
from typing import Any, BinaryIO

from tools.benchmark.manifest import ManifestError, load_experiment


SCHEMA_VERSION = 1
MAX_IDENTITY_BYTES = 1024 * 1024
DEFAULT_MAX_ARCHIVE_BYTES = 8 * 1024**3
DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024**3
DEFAULT_MAX_MEMBERS = 2_000_000


class PreparationError(ValueError):
    """Frozen pilot inputs are incomplete, inconsistent, or unsafe."""


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _require_regular(path: Path, label: str, max_bytes: int | None = None) -> int:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise PreparationError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise PreparationError(f"{label} may not be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise PreparationError(f"{label} must be a regular file: {path}")
    if max_bytes is not None and info.st_size > max_bytes:
        raise PreparationError(f"{label} exceeds the {max_bytes}-byte safety limit")
    return info.st_size


def _reject_symlink_components(path: Path, label: str, include_leaf: bool = True) -> None:
    candidate = path.absolute()
    parts = candidate.parts if include_leaf else candidate.parts[:-1]
    current = Path(parts[0])
    for part in parts[1:]:
        current /= part
        if current.exists() or current.is_symlink():
            if current.is_symlink():
                raise PreparationError(f"{label} path may not contain a symlink: {current}")


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_destination(output: Path, sources: list[Path]) -> None:
    if output.exists() or output.is_symlink():
        raise PreparationError(f"destination already exists: {output}")
    _reject_symlink_components(output, "destination", include_leaf=False)
    resolved_output = output.resolve(strict=False)
    for source in sources:
        resolved_source = source.resolve(strict=True)
        overlaps = _contains(resolved_output, resolved_source)
        if resolved_source.is_dir():
            overlaps = overlaps or _contains(resolved_source, resolved_output)
        if overlaps:
            raise PreparationError(
                f"destination and source paths must not overlap: {output} and {source}"
            )


def _unique_object(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise PreparationError(f"runtime identity contains duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_identity(path: Path) -> dict[str, Any]:
    _reject_symlink_components(path, "runtime identity")
    _require_regular(path, "runtime identity", MAX_IDENTITY_BYTES)
    try:
        value = json.loads(
            path.read_bytes(),
            parse_constant=lambda value: (_ for _ in ()).throw(
                PreparationError(f"runtime identity contains non-finite constant: {value}")
            ),
            parse_float=lambda value: _finite_float(value),
            object_pairs_hook=_unique_object,
        )
    except PreparationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise PreparationError("runtime identity must be valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise PreparationError("runtime identity must be a JSON object")
    return value


def _finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise PreparationError(f"runtime identity contains non-finite number: {value}")
    return parsed


def _validate_identity(identity: dict[str, Any], loaded: Any) -> None:
    required = {"schema_version", "provider", "model", "version", "conditions"}
    if set(identity) != required or identity.get("schema_version") != SCHEMA_VERSION:
        raise PreparationError(
            "runtime identity must contain schema_version 1, provider, model, version, and conditions"
        )
    observed_model = tuple(identity.get(field) for field in ("provider", "model", "version"))
    expected_model = tuple(loaded.model.get(field) for field in ("provider", "model", "version"))
    if observed_model != expected_model or any(
        not isinstance(value, str) or not value for value in observed_model
    ):
        raise PreparationError("runtime model identity does not match the frozen model manifest")
    expected_conditions = {
        condition["id"]: condition["config_sha256"] for condition in loaded.conditions
    }
    if identity.get("conditions") != expected_conditions:
        raise PreparationError("runtime condition config identity does not match the frozen bundle")


def _validate_member(member: tarfile.TarInfo) -> None:
    name = member.name
    pure = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
    ):
        raise PreparationError(f"unsafe archive member path: {name!r}")
    if not (member.isfile() or member.isdir()):
        raise PreparationError(f"unsafe archive member type: {name!r}")


def _scan_tar_stream(
    stream: BinaryIO,
    max_members: int,
    max_expanded_bytes: int,
) -> dict[str, int]:
    members = regular_files = expanded_bytes = 0
    try:
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for member in archive:
                members += 1
                if members > max_members:
                    raise PreparationError("archive exceeds the member-count safety limit")
                _validate_member(member)
                if member.isfile():
                    regular_files += 1
                    expanded_bytes += member.size
                    if expanded_bytes > max_expanded_bytes:
                        raise PreparationError("archive exceeds the expanded-byte safety limit")
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise PreparationError("world archive is not a valid tar stream") from exc
    return {
        "member_count": members,
        "regular_file_count": regular_files,
        "expanded_bytes": expanded_bytes,
    }


def _scan_archive(path: Path, max_members: int, max_expanded_bytes: int) -> dict[str, int]:
    if path.name.endswith(".tar"):
        with path.open("rb") as stream:
            return _scan_tar_stream(stream, max_members, max_expanded_bytes)
    if not path.name.endswith(".tar.zst"):
        raise PreparationError("world archive must end in .tar or .tar.zst")
    zstd = shutil.which("zstd")
    if zstd is None:
        raise PreparationError("zstd is required to inspect a .tar.zst archive")
    process = subprocess.Popen(
        [zstd, "-dc", "--", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    try:
        scan = _scan_tar_stream(process.stdout, max_members, max_expanded_bytes)
    except BaseException:
        process.kill()
        process.communicate()
        raise
    _, stderr = process.communicate()
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise PreparationError(f"zstd could not decode world archive: {detail}")
    return scan


def _copy_exclusive(source: Path, destination: Path, expected_hash: str) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as reader, destination.open("xb") as writer:
        shutil.copyfileobj(reader, writer, length=1024 * 1024)
    copied_hash = _sha256(destination)
    if copied_hash != expected_hash or _sha256(source) != expected_hash:
        raise PreparationError(f"source changed while being copied: {source}")
    return {
        "path": destination.as_posix(),
        "sha256": copied_hash,
        "bytes": destination.stat().st_size,
    }


def prepare(
    experiment_path: Path,
    archive_path: Path,
    identity_path: Path,
    output_path: Path,
    *,
    max_archive_bytes: int = DEFAULT_MAX_ARCHIVE_BYTES,
    max_expanded_bytes: int = DEFAULT_MAX_EXPANDED_BYTES,
    max_members: int = DEFAULT_MAX_MEMBERS,
) -> dict[str, Any]:
    """Create a new verified input directory and return its manifest."""
    experiment_path = Path(experiment_path)
    archive_path = Path(archive_path)
    identity_path = Path(identity_path)
    output_path = Path(output_path)
    for value, label in (
        (max_archive_bytes, "max_archive_bytes"),
        (max_expanded_bytes, "max_expanded_bytes"),
        (max_members, "max_members"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise PreparationError(f"{label} must be a positive integer")

    _reject_symlink_components(experiment_path, "experiment")
    _require_regular(experiment_path, "experiment")
    _reject_symlink_components(archive_path, "world archive")
    archive_bytes = _require_regular(archive_path, "world archive", max_archive_bytes)
    identity = _read_identity(identity_path)
    _validate_destination(
        output_path,
        [experiment_path.parent, archive_path, identity_path],
    )
    try:
        loaded = load_experiment(experiment_path)
    except ManifestError as exc:
        raise PreparationError(str(exc)) from exc
    if loaded.manifest["adapter"] == "mock":
        raise PreparationError("synthetic/mock experiments cannot be prepared as pilot inputs")
    _validate_identity(identity, loaded)
    archive_hash = _sha256(archive_path)
    expected_archive_hash = loaded.reset["world_archive_sha256"]
    if archive_hash != expected_archive_hash:
        raise PreparationError(
            "snapshot SHA-256 mismatch: "
            f"expected {expected_archive_hash}, observed {archive_hash}"
        )
    archive_scan = _scan_archive(archive_path, max_members, max_expanded_bytes)

    bundle_ref_entries = [
        loaded.manifest[key]
        for key in (
            "scenario_manifest",
            "reset_manifest",
            "model_manifest",
            "observation_manifest",
            "case_study_manifest",
        )
    ] + [condition["config"] for condition in loaded.manifest["conditions"]]
    created = False
    try:
        output_path.mkdir(parents=False)
        created = True
        copied: list[dict[str, Any]] = []
        experiment_hash = _sha256(experiment_path)
        record = _copy_exclusive(
            experiment_path,
            output_path / "experiment" / "experiment.json",
            experiment_hash,
        )
        record["path"] = "experiment/experiment.json"
        copied.append(record)
        expected_bundle_hashes = {
            entry["path"]: entry["sha256"] for entry in bundle_ref_entries
        }
        for relative, expected_hash in sorted(expected_bundle_hashes.items()):
            source = experiment_path.parent / relative
            record = _copy_exclusive(
                source,
                output_path / "experiment" / relative,
                expected_hash,
            )
            record["path"] = f"experiment/{relative}"
            copied.append(record)
        archive_destination = output_path / "inputs" / archive_path.name
        record = _copy_exclusive(archive_path, archive_destination, archive_hash)
        record["path"] = f"inputs/{archive_path.name}"
        copied.append(record)
        identity_hash = _sha256(identity_path)
        record = _copy_exclusive(
            identity_path,
            output_path / "runtime-identity.json",
            identity_hash,
        )
        record["path"] = "runtime-identity.json"
        copied.append(record)
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "status": "prepared_not_run",
            "claim_limit": (
                "Verified frozen replay inputs only; no reset, server, provider, trial, "
                "or outcome was run or established."
            ),
            "source": {
                "adapter": loaded.manifest["adapter"],
                "benchmark_id": loaded.manifest["benchmark_id"],
                "experiment_sha256": loaded.manifest_sha256,
                "case_study_evidence_class": loaded.case_study["evidence_class"],
            },
            "snapshot": {
                "path": f"inputs/{archive_path.name}",
                "sha256": archive_hash,
                "bytes": archive_bytes,
                "world_id": loaded.reset["world_id"],
                "server_version": loaded.reset["server_version"],
            },
            "archive_scan": archive_scan,
            "runtime_identity": identity,
            "copied_files": copied,
        }
        manifest_path = output_path / "manifest.json"
        with manifest_path.open("x", encoding="utf-8") as destination:
            json.dump(manifest, destination, indent=2, sort_keys=True)
            destination.write("\n")
        return manifest
    except BaseException:
        if created:
            shutil.rmtree(output_path)
        raise


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare verified replay inputs; never runs a pilot trial."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    command = subparsers.add_parser("prepare")
    command.add_argument("--experiment", required=True, type=Path)
    command.add_argument("--world-archive", required=True, type=Path)
    command.add_argument("--runtime-identity", required=True, type=Path)
    command.add_argument("--output", required=True, type=Path)
    command.add_argument("--max-archive-bytes", type=_positive_int, default=DEFAULT_MAX_ARCHIVE_BYTES)
    command.add_argument(
        "--max-expanded-bytes", type=_positive_int, default=DEFAULT_MAX_EXPANDED_BYTES
    )
    command.add_argument("--max-members", type=_positive_int, default=DEFAULT_MAX_MEMBERS)
    args = parser.parse_args(argv)
    try:
        manifest = prepare(
            args.experiment,
            args.world_archive,
            args.runtime_identity,
            args.output,
            max_archive_bytes=args.max_archive_bytes,
            max_expanded_bytes=args.max_expanded_bytes,
            max_members=args.max_members,
        )
    except (PreparationError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
