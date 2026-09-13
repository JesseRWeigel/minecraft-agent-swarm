# Offline prospective pilot preparation

`tools/pilot/prepare.py` creates a new private directory of verified,
prespecified pilot inputs. It does not extract or restore a world, start a
server, connect to RCON, call a model provider, run a trial, or report an
outcome. Every output says `prepared_not_run`, `live_ready: false`, and
`reset_performed: false`.

## Prospective plan

The input is a `prospective_pilot_plan`, not a completed benchmark experiment.
It pins the snapshot, reset procedure, model, scenario set, each condition
config, controller source commit, seeds, and budgets before collection. It has
no observation or case-study input. The top-level fields are:

```json
{
  "schema_version": 1,
  "kind": "prospective_pilot_plan",
  "plan_id": "pilot-001",
  "seeds": [11, 22],
  "budgets": {
    "max_steps": 20,
    "timeout_seconds": 30,
    "max_provider_requests": 4,
    "max_input_tokens": 1000,
    "max_output_tokens": 500
  },
  "snapshot_manifest": {"path": "snapshot.json", "sha256": "SHA256"},
  "reset_manifest": {"path": "reset.json", "sha256": "SHA256"},
  "model_manifest": {"path": "model.json", "sha256": "SHA256"},
  "scenario_manifest": {"path": "scenarios.json", "sha256": "SHA256"},
  "conditions": [
    {"id": "baseline", "kind": "baseline", "config": {"path": "baseline.json", "sha256": "SHA256"}}
  ],
  "code": {"source_identity": {"kind": "git_commit", "identity": "FULL_COMMIT"}}
}
```

`snapshot.json` contains exactly `schema_version`, `archive_format`
(`tar` or `tar.zst`), `archive_sha256`, and boolean `synthetic`. `reset.json`
contains exactly `schema_version`, `world_id`, `server_version`,
`snapshot_sha256`, and `reset_procedure`. A synthetic snapshot must use
`synthetic_fixture`; a real snapshot cannot use that procedure. Preparation
still never claims that either procedure ran.

The runtime identity is an independent operator-supplied JSON object. Its
provider, model, and version must match `model.json`; its `conditions` object
maps every condition ID to the exact pinned config SHA-256.

## Prepare

Run against reviewed, inactive sources and a new destination whose parent
already exists:

```bash
python3 -m tools.pilot.prepare prepare \
  --plan /private/frozen-pilot/plan.json \
  --world-archive /private/backups/world-YYYYMMDDTHHMMSSZ.tar.zst \
  --runtime-identity /private/frozen-pilot/runtime-identity.json \
  --output /private/prepared/pilot-001
```

The default storage preflight preserves 40 GiB after the conservative input
copy estimate. `--reserve-bytes` may be set explicitly for another reviewed
filesystem policy. Source-size, expanded-size, and member-count limits are also
configurable.

The preparer opens regular inputs without following symlinks, captures bounded
JSON bytes before validation, verifies the archive from one stable descriptor,
and copies those validated bytes with exclusive creation. Archive inspection
reads every regular member's declared bytes without extraction and rejects
truncation, nonzero or excessive trailing data, duplicate paths, traversal,
links, devices, FIFOs, and excessive size or member count. The output root and
subdirectories are mode `0700`; files are `0600`, independent of a permissive
umask. `manifest.json` is written last.

The CLI prints only the prepared status, manifest path, and manifest SHA-256.
The private manifest retains input hashes and source identity for the later
runner. A separate reviewed reset and execution stage is still required.
