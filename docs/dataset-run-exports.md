# Run-scoped telemetry exports

`tools/dataset/run_export.py` makes a private, immutable copy of one prospective
episode-event stream and the content-addressed payloads it references. It audits
the relationships needed to decide whether the copy is useful for later study.
It does not label an episode successful or complete.

Run the exporter only against an inactive copy of the source data. It does not
coordinate with a running recorder and it does not stop or inspect bot
processes. File age is not evidence that a run closed.

## Export an inactive run or captured prefix

Use `closed_run` only when an operator has independent evidence that the run
ended. Record that evidence in `--closure-reference` and identify who made the
assertion. An offline copy of a still-active stream is an `observed_prefix`; it
is explicitly censored even when all copied records have matching pairs.

```bash
python3 tools/dataset/run_export.py export \
  --event-file /private/snapshot/events/run-123.jsonl \
  --payload-root /private/snapshot/payloads \
  --output-root /private/exports/run-123 \
  --run-id run-123 \
  --scope observed_prefix \
  --closure-kind offline_snapshot \
  --closure-reference capture-provenance.json:sha256:EXACT_HASH \
  --asserted-by operator-name \
  --reserve-bytes 42949672960
```

The output path and its parents must be outside both source paths, and the final
output path must not already exist. The exporter checks free bytes and inodes
before creating it. `--reserve-bytes` and `--reserve-inodes` preserve an
operator-selected safety margin after the conservative preflight estimate.
Individual files are copied exclusively. `manifest.json` is written last and
then the entire export is verified. A failure removes only the new, incomplete
output directory; it never changes either source.

For an operator-confirmed stopped run, use `--scope closed_run` and either an
`offline_snapshot` or `operator_assertion` provenance record. The assertion is
an input to the export, not a conclusion made by the tool.

## What version 2 records

The small `manifest.json` root records the run ID, scope, closure provenance,
copy and episode status, storage preflight, audit totals, and a list of manifest
shards. Each JSONL shard contains bounded file records with the archived path,
source path, actual SHA-256, byte count, complete-line cutoff, status, and source
kind. The root hashes every shard and reconciles shard and file totals.

These fields have deliberately separate meanings:

- `copy_complete: true` means every selected byte was copied and verified.
- `run_closed` reflects the explicit requested scope and provenance.
- `censored: true` marks an observed prefix of an active or otherwise unclosed
  run.
- `episode_complete: false` and
  `episode_completion_basis: not_independently_verified` remain fixed in this
  version. Balanced action or model-request pairs are not an episode-end signal.

The audit reports duplicate event IDs, duplicate or unmatched action starts and
terminals, duplicate or unmatched model requests and responses, incomplete or
malformed event tails, episode IDs that do not match the event's run and bot,
missing or corrupt payloads, unavailable or invalid references, malformed
`evidenceRefs` shapes, evidence references outside the run, unexpected paths,
and unused payload blobs. Referenced corrupt blobs are retained with their
actual hash and the expected content-addressed hash so corruption is visible
rather than silently repaired. Unused blobs are reported but not copied.

The exporter copies the event stream, each referenced payload it found, and the
generated audit. It does not transform repeated prompt fields or compress
payloads because this export is byte-exact evidence. A future deduplicated or
compressed representation needs its own schema and transformation version and
must retain links to the verified source hashes.

## Verify and monitor storage

Verification streams both manifest shards and archived files. A temporary
SQLite table detects duplicate paths across shards without an unbounded Python
set.

```bash
python3 tools/dataset/run_export.py verify \
  --manifest /private/exports/run-123/manifest.json

python3 tools/dataset/run_export.py report \
  --manifest /private/exports/run-123/manifest.json \
  --previous-manifest /private/exports/prior-prefix/manifest.json \
  --warn-free-bytes 42949672960 \
  --warn-free-inodes 100000
```

`report` verifies each supplied export before comparing file, byte, event, and
payload totals. It only reads the archive and filesystem capacity. Warning
thresholds are explicit command inputs.

The existing index accepts both version-1 archive manifests and version-2 run
exports. For version 2 it verifies and catalogs the event and payload files but
indexes zero prospective event rows. Its summary reports
`index_scope: legacy_trajectory_rows_only` and
`prospective_event_rows_indexed: 0`; future event indexing needs a separate,
versioned interpretation pipeline.

## Stress sharding before large captures

The stress command creates disposable synthetic source data, performs a normal
export, and verifies it. Choose an output path on the intended filesystem and a
reserve that keeps operational headroom. This example is large enough to exceed
the old single-manifest design; estimate its impact before running it.

```bash
python3 tools/dataset/run_export.py stress \
  --output-root /private/stress/run-export-100k \
  --payload-count 100000 \
  --max-shard-bytes 8388608 \
  --reserve-bytes 42949672960
```

## Limits and retention

The export is a collection of per-file stable copies, not an atomic filesystem
snapshot. Each event file and selected payload is checked for mutation while it
is read and again before finalization. New files added to the source payload
directory after its scan can be absent from the unused-blob audit. Therefore the
source paths must be an offline snapshot or otherwise inactive; concurrent
writers invalidate the evidentiary meaning even if every selected file remains
stable.

Exports are append-only operational artifacts: this tool has no delete,
overwrite, or source-retention operation. It does not solve the recorder's CAS
small-file count, inode growth, or retention policy. A later retention stage can
pack or compress a verified, closed-run export into a container, then verify the
container and preserve the source-to-container hash map before any separately
authorized deletion. An observed prefix must remain labeled as censored through
such a transformation.

Telemetry and world data can contain private server details, player identifiers,
or conversation content. Keep raw exports private and publish only reviewed,
redacted derivatives.
