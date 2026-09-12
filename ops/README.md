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
