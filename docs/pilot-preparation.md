# Offline pilot input preparation

`tools/pilot/prepare.py` creates a new, private directory of verified frozen
inputs. It does not extract a world, reset or start a server, connect to RCON,
call a model provider, run a trial, or report an outcome.

The source experiment must pass the benchmark manifest validator and use the
`replay` adapter. Synthetic `mock` experiments are refused. The runtime identity
is a separate operator-supplied JSON object so the model and each condition's
configuration cannot be inferred from the preparer's checkout:

```json
{
  "schema_version": 1,
  "provider": "pinned-provider",
  "model": "pinned-model",
  "version": "pinned-version",
  "conditions": {
    "baseline": "CONFIG_SHA256",
    "coordination": "CONFIG_SHA256",
    "coaching": "CONFIG_SHA256"
  }
}
```

Run preparation against reviewed, inactive sources and a destination whose
parent already exists:

```bash
python3 -m tools.pilot.prepare prepare \
  --experiment /private/frozen-pilot/experiment.json \
  --world-archive /private/backups/world-YYYYMMDDTHHMMSSZ.tar.zst \
  --runtime-identity /private/frozen-pilot/runtime-identity.json \
  --output /private/prepared/pilot-001
```

The destination must not exist or overlap the inputs, and input paths may not
contain symlinks. The preparer checks the snapshot hash against `reset.json`,
checks the runtime identity against the model and condition manifests, and
scans tar metadata without extracting it. Absolute or traversing member names,
links, devices, FIFOs, unsupported archive types, excessive source size,
excessive expanded size, and excessive member counts are refused. Limits can be
lowered with `--max-archive-bytes`, `--max-expanded-bytes`, and `--max-members`.

`manifest.json` is written last. Its status is always `prepared_not_run`, and
its claim limit states that no reset, server, provider, trial, or outcome was
run or established. It retains the source adapter and case-study evidence class.
Preparation does not make replay evidence live evidence or make an archive safe
to restore; a separately reviewed reset stage remains required.
