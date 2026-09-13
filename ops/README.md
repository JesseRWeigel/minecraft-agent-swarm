# Operations protocol for the study period

The swarm's history is being turned into an auditable dataset and a controlled
study. This directory holds the operating state and the intervention ledger.
Jesse owns the study; Claude runs live operation and public communication;
Codex prepares archival, instrumentation and evaluation changes in separate
checkouts.

## Files

- `state.json` — current mode: `live`, `maintenance` or `evaluation`, with
  `since`, `reason`, `by` and `trial`. Change it only through
  `scripts/ops-state.sh`, which also writes the ledger line.
- `interventions.jsonl` — append-only ledger. One JSON object per line:
  `ts_utc`, `kind` (`code` | `state` | `restart` | `backup` | `safety` |
  `infra`), `reason`, `changes` (files), `commit`, `run` (supervisor run
  number), `restart_utc`, `restart_source`, `deploy_point`, `by`,
  `study_mode`, `trial`, `trial_validity` (a note whenever the intervention
  could affect a running trial, else null).

## Modes

- **live** — the observational campaign. Ordinary operator fixes are allowed;
  each one is a ledger line with its reason, changed files, deployed commit
  and restart time. They are part of the data.
- **maintenance** — a planned window (for example a GPU research window).
  `scripts/ops-state.sh enter-maintenance "<reason>"` first, then stop the
  swarm. The supervisor refuses to start or restart while this mode is set
  (`FORCE_START=1` overrides for a deliberate launch), so no automatic bot
  restarts and no automatic model loads happen. Public updates call this
  maintenance, never an outage. Take a world backup on entry.
- **evaluation** — a controlled trial. `scripts/ops-state.sh enter-evaluation
  <trial> "<note>"`. Tested code, prompts and policies are frozen: no code
  deploys, no prompt or role edits, no restarts on new commits. Safety or
  infrastructure interventions that cannot wait are still done, and logged
  with `kind: safety` or `infra` and a `trial_validity` note describing their
  effect on the trial.

## Deployment points

Other workers' in-progress checkouts are never integrated. Reviewed commits on
`main` are deployed at an agreed deployment point (by default the hourly cycle
restart), and the ledger names the deployed commit and the supervisor restart
time (`[Supervisor] Starting swarm (restart #0) at HH:MM:SSZ` in the run log).

## Preservation (never clean up)

- Supervisor run logs `/tmp/bot-run-N.log` are copied by
  `scripts/preserve-logs.sh` into `logs/bot-runs/` (git-ignored) every cycle.
- `logs/` (advancement CSV, stash ledger, sessions, swarm logs), the skill
  variants under `skills/**` including `*.bak.*`, the memory files under the
  Claude project memory directory, and this ledger are kept as they are.
- World backups: `scripts/backup-world.sh [label]` pauses autosave, flushes,
  archives all three dimensions plus the server identity files into
  `backups/world-<UTC>.tar.zst` with a sha256 and a `backups/MANIFEST.tsv`
  line, then resumes autosave. Run it daily in the live campaign, on entering
  maintenance, and before any evaluation.

## Communication

Public progress updates carry source timestamps (UTC, from the server log or
the run log), advancement counts verified by `scripts/advancement-report.ts`
(per-player server lines are not team advancements), and name the supervisor's
own contributions separately from what the bots earned.

### Research-window safeguards

Mode writes are staged, validated and atomically renamed. An unreadable,
missing or unrecognized mode blocks the supervisor and produces
`OPS_MODE=invalid` / `ALERTS=ops_state_invalid` in the health check.
The supervisor checks mode again immediately before each launch, including
after a restart delay. `FORCE_START=1` permits the deliberate initial launch
in maintenance, but does not authorize subsequent automatic restarts.
Entering maintenance does not itself stop an already running process; the
operator must stop it and verify that the GPU workload is gone before the
research window begins. This is not an inter-process launch lock: do not
assume an already-passed check can revoke an in-flight launch.

The backup cleanup trap is installed before disabling autosave so a failed
flush still attempts `save-on`. Failure to restore autosave emits an explicit
operator error. These script paths are tested with fake npm/RCON commands:
`python3 -m unittest discover -s tools/ops`.

### Launch provenance

Immediately before each `npm start`, the supervisor captures the checkout's
`HEAD`, the SHA-256 of `git diff --binary HEAD -- .`, and the current operations
mode and trial. A clean tracked tree therefore has the standard SHA-256 of empty
input (`e3b0c442...b855`). Unknown trial and world identities remain unset; the
supervisor does not invent identifiers. The same values and a compact JSON
manifest are bound to the child process through its environment. The manifest
contains only identifiers, hashes, counts, capture time, and the runtime command;
it contains no diff contents or credentials.

The tracked-diff hash does not cover untracked files. To make that limitation
visible, the manifest separately records a deterministic content hash and count
for untracked and ignored files under runtime source paths (`src`, `scripts`,
`skills`, and root runtime manifests). Evaluation refuses to launch if that
count is nonzero. Scanning is fail-closed in every mode: state is limited to
64 KiB, and runtime evidence is limited to 10,000 files, 64 MiB per file,
256 MiB total, and a 4 MiB tracked-path listing. Files are hashed as streams;
symlinks, FIFOs, other non-regular files, and inputs that change while hashing
abort the launch. Trial IDs must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. A controlled evaluation also requires a nonempty trial and a
operator-provided `WORLD_SNAPSHOT_ID` formatted as a SHA-256 content identifier.
The helper passes it to the collector as `DATASET_WORLD_SNAPSHOT_ID`. Its presence is
an operator assertion of snapshot identity, not proof that a restore was tested.

Launch context describes one process launch. Changing tracked source, operations
state, or the world during the process does not rewrite its captured context and
invalidates a controlled evaluation. Any evaluation process exit ends the trial
run; the supervisor will not silently restart it under the same trial ID. Live
mode retains the normal crash-restart behavior, and maintenance plus
`FORCE_START=1` keeps its existing deliberate-initial-launch semantics.

The dataset recorder freezes the five canonical environment fields on first
access and writes a `run_context` event when the default recorder initializes;
it does not infer that a controlled trial is valid from those fields. Default
run IDs separate restarted processes. If an operator explicitly reuses
`DATASET_RUN_ID`, consumers must treat each `run_context` as sequence-scoped and
associate recovered synthetic terminal events with the context of their original
`action_started`, rather than a later process launch. Running `npm start`
directly bypasses this helper, so the recorder leaves unavailable provenance
explicit instead of guessing it.
