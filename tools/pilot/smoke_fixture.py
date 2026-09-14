"""Create tiny synthetic inputs for the offline pilot qualification command."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

from tools.pilot.prepare import _mkdir_private, _write_private, prepare

FAKE_IDENTITY = {"schema_version": 1, "provider": "builtin-fake", "model": "grid-fixture", "version": "1"}
DEFAULT_BUDGETS = {"max_steps": 8, "timeout_seconds": 30, "max_provider_requests": 8, "max_input_tokens": 8, "max_output_tokens": 8}


def create_fixture(root: Path, *, behavior="move_to_goal", budgets=None) -> Path:
    root = Path(root)
    if root.exists() or root.is_symlink():
        raise ValueError("fixture destination already exists")
    from tools.pilot.prepare import _reject_symlink_components
    _reject_symlink_components(root, "fixture destination", include_leaf=False)
    _mkdir_private(root)
    source = root / "source"; _mkdir_private(source)
    def write(name, data):
        raw = (json.dumps(data, sort_keys=True) + "\n").encode()
        _write_private(source / name, raw, source)
        return {"path": name, "sha256": hashlib.sha256(raw).hexdigest()}
    state = {"schema_version": 1, "synthetic": True, "actors": {"atlas": {"position": {"x": 0, "y": 0, "z": 0}, "dimension": "minecraft:overworld"}}}
    raw = json.dumps(state, sort_keys=True).encode()
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        member = tarfile.TarInfo("world/state.json"); member.size = len(raw); tar.addfile(member, io.BytesIO(raw))
    archive_raw = archive.getvalue(); archive_hash = hashlib.sha256(archive_raw).hexdigest()
    _write_private(root / "world.tar", archive_raw, root)
    snapshot = write("snapshot.json", {"schema_version": 1, "archive_format": "tar", "archive_sha256": archive_hash, "synthetic": True})
    reset = write("reset.json", {"schema_version": 1, "world_id": "synthetic-grid", "server_version": "no-minecraft-server", "snapshot_sha256": archive_hash, "reset_procedure": "synthetic_fixture"})
    model = write("model.json", FAKE_IDENTITY)
    scenarios = write("scenarios.json", {"schema_version": 1, "scenarios": [{"id": "navigate", "task": "navigate_to_region", "goal": {"actor": "atlas", "dimension": "minecraft:overworld", "min": [2, 1, 0], "max": [2, 1, 0]}}]})
    conditions = []
    for name, kind in [("baseline", "baseline"), ("coordination", "coordination")]:
        ref = write(name + ".json", {"schema_version": 1, "condition_id": name, "kind": kind, "fake_behavior": behavior})
        conditions.append({"id": name, "kind": kind, "config": ref})
    write("plan.json", {"schema_version": 1, "kind": "prospective_pilot_plan", "plan_id": "synthetic-lifecycle", "seeds": [11, 22], "budgets": DEFAULT_BUDGETS if budgets is None else budgets, "snapshot_manifest": snapshot, "reset_manifest": reset, "model_manifest": model, "scenario_manifest": scenarios, "conditions": conditions, "code": {"source_identity": {"kind": "git_commit", "identity": "0" * 40}}})
    write("runtime.json", {**FAKE_IDENTITY, "conditions": {c["id"]: c["config"]["sha256"] for c in conditions}})
    output = root / "prepared"
    prepare(source / "plan.json", root / "world.tar", source / "runtime.json", output, reserve_bytes=0)
    return output
