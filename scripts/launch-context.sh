#!/usr/bin/env bash
# Capture immutable, non-secret source and study context for one child launch.
# Source this from the repository root immediately before starting the child.

capture_launch_context() {
  local state context git_commit dirty_hash trial_id world_snapshot_id untracked_runtime untracked_count untracked_hash

  if ! state=$(python3 - ops/state.json <<'PY'
import json, os, re, stat, sys

MAX_STATE_BYTES = 64 * 1024

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate key: {key}')
        result[key] = value
    return result

try:
    descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_STATE_BYTES:
        os.close(descriptor)
        raise ValueError('operations state must be a regular file no larger than 64 KiB')
    with os.fdopen(descriptor, 'rb') as handle:
        raw = handle.read(MAX_STATE_BYTES + 1)
    if len(raw) > MAX_STATE_BYTES:
        raise ValueError('operations state exceeds 64 KiB')
    value = json.loads(raw, object_pairs_hook=reject_duplicates,
                       parse_constant=lambda token: (_ for _ in ()).throw(ValueError(f'invalid number: {token}')))
    if not isinstance(value, dict) or value.get('mode') not in ('live', 'maintenance', 'evaluation'):
        raise ValueError('invalid operations state')
    trial = value.get('trial')
    if trial is not None and (not isinstance(trial, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', trial)):
        raise ValueError('trial must match [A-Za-z0-9][A-Za-z0-9._-]{0,127} or be null')
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
  if ! dirty_hash=$(python3 - <<'PY'
import hashlib, subprocess, sys
process = subprocess.Popen(['git', 'diff', '--no-ext-diff', '--binary', 'HEAD', '--', '.'], stdout=subprocess.PIPE)
digest = hashlib.sha256()
while True:
    chunk = process.stdout.read(1024 * 1024)
    if not chunk:
        break
    digest.update(chunk)
if process.wait() != 0:
    sys.exit(1)
print(digest.hexdigest())
PY
  ); then
    echo '[Supervisor] Cannot hash tracked launch changes; refusing to launch.' >&2
    return 1
  fi

  DATASET_OPERATION_MODE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["mode"])' "$state")
  trial_id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["trial"] or "")' "$state")
  # WORLD_SNAPSHOT_ID is operator input. DATASET_WORLD_SNAPSHOT_ID is always
  # replaced below so a stale collector value cannot leak across launches.
  world_snapshot_id=${WORLD_SNAPSHOT_ID:-}
  if ! untracked_runtime=$(python3 - <<'PY'
import hashlib, json, os, pathlib, stat, subprocess

MAX_FILES = 10_000
MAX_LIST_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024

def bounded_git_paths(args):
    process = subprocess.Popen(args, stdout=subprocess.PIPE)
    data = process.stdout.read(MAX_LIST_BYTES + 1)
    if len(data) > MAX_LIST_BYTES:
        process.kill()
        process.wait()
        raise ValueError('runtime source path list exceeds 4 MiB')
    if process.wait() != 0:
        raise subprocess.CalledProcessError(process.returncode, args)
    return {item for item in data.split(b'\0') if item}

tracked = bounded_git_paths(['git', 'ls-files', '-z', '--', 'src', 'scripts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json'])
paths = set()

def add_untracked_file(path):
    raw_path = os.fsencode(path.as_posix())
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('runtime source contains a non-regular file')
    if raw_path not in tracked:
        paths.add(raw_path)
        if len(paths) > MAX_FILES:
            raise ValueError('runtime source file count exceeds 10000')

def metadata_signature(metadata):
    return (metadata.st_mode, metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns)

for root_name in ('src', 'scripts', 'skills'):
    root = pathlib.Path(root_name)
    if not os.path.lexists(root):
        continue
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError('runtime source root must be a regular directory')
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        for name in directory_names:
            path = pathlib.Path(directory, name)
            if not stat.S_ISDIR(path.lstat().st_mode):
                raise ValueError('runtime source contains a non-directory traversal entry')
        for name in file_names:
            add_untracked_file(pathlib.Path(directory, name))
for root_name in ('package.json', 'package-lock.json', 'tsconfig.json'):
    path = pathlib.Path(root_name)
    if os.path.lexists(path):
        add_untracked_file(path)
digest = hashlib.sha256()
total_size = 0
for raw_path in sorted(paths):
    path = pathlib.Path(raw_path.decode('utf-8', 'surrogateescape'))
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('runtime source contains a non-regular file')
    if metadata.st_size > MAX_FILE_BYTES:
        raise ValueError('runtime source file exceeds 64 MiB')
    total_size += metadata.st_size
    if total_size > MAX_TOTAL_BYTES:
        raise ValueError('runtime source files exceed 256 MiB total')
    digest.update(len(raw_path).to_bytes(8, 'big'))
    digest.update(raw_path)
    digest.update(metadata.st_size.to_bytes(8, 'big'))
    bytes_read = 0
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    opened_metadata = os.fstat(descriptor)
    if metadata_signature(opened_metadata) != metadata_signature(metadata):
        os.close(descriptor)
        raise ValueError('runtime source changed before hashing')
    with os.fdopen(descriptor, 'rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            bytes_read += len(chunk)
            if bytes_read > MAX_FILE_BYTES:
                raise ValueError('runtime source file grew beyond 64 MiB while hashing')
            digest.update(chunk)
        final_metadata = os.fstat(handle.fileno())
        if metadata_signature(final_metadata) != metadata_signature(opened_metadata):
            raise ValueError('runtime source changed while hashing')
    if bytes_read != metadata.st_size:
        raise ValueError('runtime source changed while hashing')
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

  export DATASET_OPERATION_MODE DATASET_GIT_COMMIT="$git_commit" DATASET_DIRTY_DIFF_HASH="$dirty_hash"
  if [[ -n "$trial_id" ]]; then export DATASET_TRIAL_ID="$trial_id"; else unset DATASET_TRIAL_ID; fi
  if [[ -n "$world_snapshot_id" ]]; then export DATASET_WORLD_SNAPSHOT_ID="$world_snapshot_id"; else unset DATASET_WORLD_SNAPSHOT_ID; fi

  context=$(DATASET_OPERATION_MODE="$DATASET_OPERATION_MODE" DATASET_TRIAL_ID="${DATASET_TRIAL_ID:-}" \
    DATASET_GIT_COMMIT="$DATASET_GIT_COMMIT" DATASET_DIRTY_DIFF_HASH="$DATASET_DIRTY_DIFF_HASH" \
    DATASET_WORLD_SNAPSHOT_ID="${DATASET_WORLD_SNAPSHOT_ID:-}" UNTRACKED_COUNT="$untracked_count" UNTRACKED_HASH="$untracked_hash" \
    python3 - <<'PY'
import datetime, json, os
value = {
    'schema_version': 1,
    'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'operation_mode': os.environ['DATASET_OPERATION_MODE'],
    'trial_id': os.environ['DATASET_TRIAL_ID'] or None,
    'git_commit': os.environ['DATASET_GIT_COMMIT'],
    'tracked_dirty_diff_sha256': os.environ['DATASET_DIRTY_DIFF_HASH'],
    'world_snapshot_id': os.environ['DATASET_WORLD_SNAPSHOT_ID'] or None,
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
