# Dataset archive

`tools/dataset/archive.py` makes a private, hash-verified snapshot of the Minecraft bot records without pausing the bots or changing source files. It copies an allowlisted inventory, writes the manifest last, and refuses to replace an existing inventory or archive.

## Private-data boundary

Keep the archive private. Trajectories, prompts, chats, operator records, and world backups can contain player names, server addresses, operational details, and credentials. In particular, a world backup can contain `server.properties` and RCON credentials. Do not publish raw archive files. Create a separate redacted export and review its provenance, consent, licenses, secrets, and personal data before sharing it.

The archive command copies existing world-backup artifacts; it does not create a backup or prove that a server backup is application-consistent. It does not include model weights. The allowlist includes selected training code, logs, datasets, tokenizer/config metadata, and trainer metadata.

## Allowlist

The source repository inventory includes:

- `logs/trajectories/**/*.jsonl` and `logs/sessions/**/*.json`
- direct `logs/trajectories-v2/*.jsonl` summaries
- direct `logs/episode-events-v1/events/*.jsonl` event streams and content-addressed JSON payloads at `payloads/<two lowercase hex>/<64 lowercase hex>.json`
- direct `logs/*.json`, `logs/*.csv`, and `logs/*.log`
- `logs/bot-runs/bot-run-*.log`
- `.log`, `.txt`, and `.gz` files below `server/logs/`
- regular files below `skills/generated/` and `skills/voyager/`
- root `memory*.json` files
- the selected training files and metadata named in the tool
- `ops/README.md`, `ops/state.json`, and `ops/interventions.jsonl`
- `backups/*.tar.zst`, `backups/*.sha256`, and `backups/MANIFEST.tsv`

An optional extra root accepts only direct children named `bot-run-*.log`. It does not scan arbitrary temporary files. Symlinks anywhere in an allowlisted tree are rejected.

## Capture a live prefix

Line-oriented files can grow while capture runs. The tool records only the initial prefix through the last complete newline and verifies that prefix against the source twice. It labels an omitted partial tail or concurrent append as `complete_prefix`. The manifest records both `source_size_at_open` and `captured_bytes`, so omitted bytes remain visible.

Capture is bounded per file; it is not one atomic snapshot across every log and metadata file. `captured_at_utc` is the time the manifest was finalized, not a shared observation time for all records. Record the archive-tool commit and source repository commit separately during an archival run. Do not infer an exact historical code version from the manifest alone.

Atomic JSON, metadata, and backup files must remain unchanged while they are copied and verified. If one changes, is replaced, is truncated, is malformed JSON where JSON validation applies, or cannot be read, the entire capture fails and the incomplete output directory is removed. Retry after the producer has atomically published a stable file.

Episode payload filenames must equal the SHA-256 of their exact JSON bytes, including the producer's trailing newline. Files with the wrong hash fail capture. Files outside the producer's flat event/trajectory layout or exact content-addressed payload layout are not selected.

Each manifest file entry contains:

```json
{
  "source_relpath": "logs/trajectories/example.jsonl",
  "archive_relpath": "files/source/logs/trajectories/example.jsonl",
  "sha256": "<sha256 of archived bytes>",
  "source_size_at_open": 123,
  "captured_bytes": 120,
  "complete_line_cutoff": 120,
  "status": "complete_prefix",
  "source_kind": "trajectory_jsonl"
}
```

The top-level manifest has `schema_version`, `captured_at_utc`, absolute private `source_root`, `complete`, and `files`. A valid finalized archive has `complete: true`; the tool never writes a success manifest for a partial operation.

## Operator commands

Create the private parent directory once, then write the inventory outside the source and extra roots:

```bash
install -d -m 700 /home/jesse/Projects/.audit-data
python3 tools/dataset/archive.py inventory \
  --source-root /home/jesse/Projects/mineflayer-chatgpt \
  --extra-root /tmp \
  --output /home/jesse/Projects/.audit-data/minecraft-20260912-inventory.json
```

Review the selected paths and the reported required and available bytes. Capture to a path that does not already exist:

```bash
python3 tools/dataset/archive.py capture \
  --source-root /home/jesse/Projects/mineflayer-chatgpt \
  --extra-root /tmp \
  --output-root /home/jesse/Projects/.audit-data/minecraft-20260912-first
```

Verify the finalized archive before indexing it and again after copying it to another disk:

```bash
python3 tools/dataset/archive.py verify \
  --manifest /home/jesse/Projects/.audit-data/minecraft-20260912-first/manifest.json
```

Verification rejects unsupported or ambiguous schema values, duplicate JSON keys, duplicate or nonportable paths, traversal, symlinks, missing files, size mismatches, and hash mismatches. A second copy on the same disk is useful for workflow recovery but is not a disaster backup.

## Prospective scale limit

Version-1 manifests are capped at 16 MiB (the legacy index reader caps its
manifest input at 32 MiB). Content-addressed prospective payloads can create
many small files, so the current whole-repository capture is not a long-term
retention system. Run-scoped exports, manifest sharding, early capacity
checks and file-growth reporting are tracked in
[issue #33](https://github.com/JesseRWeigel/minecraft-agent-swarm/issues/33).
Complete that work before scaling the controlled pilot; do not remove raw
data to make a manifest fit.
