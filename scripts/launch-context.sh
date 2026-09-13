#!/usr/bin/env bash
# Capture immutable, non-secret source and study context for one child launch.
# Source this from the repository root immediately before starting the child.

capture_launch_context() {
  local state context git_commit dirty_hash trial_id world_snapshot_id untracked_runtime untracked_count untracked_hash

  if ! state=$(python3 - ops/state.json <<'PY'
import json, sys

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate key: {key}')
        result[key] = value
    return result

try:
    with open(sys.argv[1], encoding='utf-8') as handle:
        value = json.load(handle, object_pairs_hook=reject_duplicates)
    if not isinstance(value, dict) or value.get('mode') not in ('live', 'maintenance', 'evaluation'):
        raise ValueError('invalid operations state')
    trial = value.get('trial')
    if trial is not None and (not isinstance(trial, str) or not trial.strip()):
        raise ValueError('trial must be a nonempty string or null')
    print(json.dumps({'mode': value['mode'], 'trial': trial}, separators=(',', ':')))
except (OSError, ValueError, json.JSONDecodeError) as error:
    print(f'[Supervisor] Invalid operations state: {error}', file=sys.stderr)
    sys.exit(1)
PY
  ); then
    return 1
  fi

  if ! git_commit=$(git rev-parse --verify HEAD 2>/dev/null); then
    echo '[Supervisor] Cannot resolve the launch checkout commit; refusing to launch.' >&2
    return 1
  fi
  if ! dirty_hash=$(git diff --binary HEAD -- . | sha256sum | awk '{print $1}'); then
    echo '[Supervisor] Cannot hash tracked launch changes; refusing to launch.' >&2
    return 1
  fi

  DATASET_OPERATION_MODE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["mode"])' "$state")
  trial_id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["trial"] or "")' "$state")
  world_snapshot_id=${WORLD_SNAPSHOT_ID:-}
  if ! untracked_runtime=$(python3 - <<'PY'
import hashlib, json, pathlib, subprocess, sys
paths = set()
for args in (
    ['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json'],
    ['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'src', 'scripts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json'],
):
    result = subprocess.run(args, check=True, capture_output=True)
    paths.update(item for item in result.stdout.split(b'\0') if item)
digest = hashlib.sha256()
for raw_path in sorted(paths):
    path = pathlib.Path(raw_path.decode('utf-8', 'surrogateescape'))
    data = path.read_bytes()
    digest.update(len(raw_path).to_bytes(8, 'big'))
    digest.update(raw_path)
    digest.update(len(data).to_bytes(8, 'big'))
    digest.update(data)
print(json.dumps({'count': len(paths), 'sha256': digest.hexdigest()}, separators=(',', ':')))
PY
  ); then
    echo '[Supervisor] Cannot identify untracked runtime source; refusing to launch.' >&2
    return 1
  fi
  untracked_count=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["count"])' "$untracked_runtime")
  untracked_hash=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha256"])' "$untracked_runtime")

  if [[ "$DATASET_OPERATION_MODE" == 'evaluation' ]]; then
    if [[ -z "$trial_id" ]]; then
      echo '[Supervisor] Evaluation requires a nonempty trial in ops/state.json; refusing to launch.' >&2
      return 1
    fi
    if [[ ! "$world_snapshot_id" =~ ^[0-9a-fA-F]{64}$ ]]; then
      echo '[Supervisor] Evaluation requires WORLD_SNAPSHOT_ID as a SHA-256 content identifier; refusing to launch.' >&2
      return 1
    fi
    if (( untracked_count > 0 )); then
      echo "[Supervisor] Evaluation has ${untracked_count} untracked or ignored runtime source file(s); refusing to launch." >&2
      return 1
    fi
  fi

  export DATASET_OPERATION_MODE GIT_COMMIT="$git_commit" DIRTY_DIFF_HASH="$dirty_hash"
  if [[ -n "$trial_id" ]]; then export TRIAL_ID="$trial_id"; else unset TRIAL_ID; fi
  if [[ -n "$world_snapshot_id" ]]; then export WORLD_SNAPSHOT_ID="$world_snapshot_id"; else unset WORLD_SNAPSHOT_ID; fi

  context=$(DATASET_OPERATION_MODE="$DATASET_OPERATION_MODE" TRIAL_ID="${TRIAL_ID:-}" \
    GIT_COMMIT="$GIT_COMMIT" DIRTY_DIFF_HASH="$DIRTY_DIFF_HASH" \
    WORLD_SNAPSHOT_ID="${WORLD_SNAPSHOT_ID:-}" UNTRACKED_COUNT="$untracked_count" UNTRACKED_HASH="$untracked_hash" \
    python3 - <<'PY'
import datetime, json, os
value = {
    'schema_version': 1,
    'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'operation_mode': os.environ['DATASET_OPERATION_MODE'],
    'trial_id': os.environ['TRIAL_ID'] or None,
    'git_commit': os.environ['GIT_COMMIT'],
    'tracked_dirty_diff_sha256': os.environ['DIRTY_DIFF_HASH'],
    'world_snapshot_id': os.environ['WORLD_SNAPSHOT_ID'] or None,
    'untracked_runtime_file_count': int(os.environ['UNTRACKED_COUNT']),
    'untracked_runtime_sha256': os.environ['UNTRACKED_HASH'],
    'runtime_command': ['npm', 'start'],
}
print(json.dumps(value, separators=(',', ':'), sort_keys=True))
PY
  ) || return 1
  export SWARM_LAUNCH_CONTEXT_JSON="$context"
  printf '[Supervisor] Launch context %s\n' "$context"
}
