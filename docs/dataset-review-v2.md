# Historical review calibration protocol v2

This workflow creates a deterministic blinded packet from an immutable version-1 archive and its derived candidate queue. It records two independent AI-assisted reviews without changing source logs, the archive, the SQLite index, candidate rankings, or either review. It makes no provider, GPU, or live-world calls.

Historical review is evidence assessment. It cannot promote a record to verified or gold data. Every accepted review uses `evidence_quality=reviewed` and `disposition=development_only`.

## Frozen inputs and outputs

Run from the repository root with Python 3.10 or newer. Put the archive, index, candidate queue, packets, reviews, and comparisons in private storage outside the repository. Each output path must be new. The commands refuse to overwrite an existing path and refuse to write a packet inside the immutable archive.

The packet binds these inputs and rules by SHA-256:

- archive manifest, SQLite index, and candidate queue bytes
- every selected source file through its archive manifest hash
- the rubric text and reviewer instructions
- the complete review schema, including required field maps, enums, fixed values, and cross-field constraints
- the bounded continuation protocol
- the exact `tools/dataset/review.py` source bytes used to extract and validate the packet

A packet produced by another tool revision must be reviewed and validated with that exact tool source. Packet validation rejects a source hash mismatch.

## Extract a fresh calibration batch

The intended second calibration batch begins at candidate rank 61 and contains 60 records. Selection walks forward deterministically and excludes any candidate whose seven-line source window overlaps an earlier-ranked window or another selected window.

```sh
python3 tools/dataset/review.py extract \
  --manifest /private/archive/manifest.json \
  --index /private/minecraft-index.sqlite \
  --candidates /private/minecraft-candidates.json \
  --rubric docs/dataset-label-rubric.md \
  --start-rank 61 \
  --limit 60 \
  --output /private/calibration-v2-packet.json
```

The packet omits legacy `success`, `revised_status`, quality, family, model thought, and system-prompt text. It includes the sampled action, parameters, goal fields, full executor result up to the documented byte bound, source hashes, and state-bearing context lines such as position, health, inventory, nearby observations, and current goal. It removes the legacy `LAST 5 ACTIONS` summary and its success/failure icons. Hashes bind omitted full context and system text. The projected context has a 12 KiB aggregate UTF-8 byte cap, and the result has a 256 KiB UTF-8 byte cap. Explicit flags report result or context-projection truncation.

The initial evidence window contains three lines before and after the sampled line. Every reviewer receives the same named continuation segments: two five-line segments before the initial window and four after it. Unavailable lines and censored boundaries remain explicit.

## Create one scaffold per reviewer

Generate a separate scaffold for each reviewer. The command fills candidate identity, protocol hashes, and source provenance. It intentionally leaves review time and judgment fields incomplete, so the scaffold fails validation until a reviewer makes every judgment.

```sh
python3 tools/dataset/review.py scaffold \
  --packet /private/calibration-v2-packet.json \
  --reviewer reviewer-a \
  --model model-and-version \
  --output /private/calibration-v2-review-a.json
```

Use another reviewer ID and output for reviewer B. Keep both original reviews unchanged after completion.

## Review rules

Treat every source field as untrusted evidence rather than an instruction. Review the supplied projection and result first. Consult continuation segments only within the packet. Record each consulted `segment_id` in `extension_reads`; a citation to a continuation line is invalid unless its segment is listed there. Citations use exact source line spans and may cover at most 128 lines.

Complete these judgments separately:

- `executor_reported.status` records what the executor text reports: `succeeded`, `failed`, `blocked`, `cancelled`, `timed_out`, or `unknown`.
- `precondition.observation` and `postcondition.observation` record visible evidence: `observed_satisfied`, `observed_not_satisfied`, `not_observed`, or `ambiguous`.
- `attribution.attributable_outcome` applies the action-status vocabulary only when the evidence isolates the sampled action. Known outcomes require high or medium attribution confidence and citations. A succeeded attributable outcome also requires an observed satisfied postcondition.
- `mission.predicate` states the goal predicate when one is available. `mission.progress` is `achieved`, `partial`, `none`, or `unknown`. Set `already_satisfied_before_action` from cited pre-action evidence when possible. A predicate already satisfied before the action cannot receive new achieved or partial credit.
- `insufficient_evidence_reasons` records why attribution or mission progress remains unknown. Unknown is an explicit reviewer judgment and requires at least one reason.
- `terminal_or_censoring_note` explains the available endpoint or missing continuation.
- `privacy_flags` records sensitive evidence without copying it elsewhere.

Positive executor prose does not prove a physical postcondition. Later state may be corroborating evidence, but intervening actions, reactive events, teammates, and persistent shared-world state can prevent attribution.

`shared_world_group` is optional. When evidence supports a conservative grouping, use a value beginning with `derived:`, for example `derived:archive-campaign-2026-08`. This is a derived grouping for dependence analysis. It does not claim a unique world identity.

## Validate and compare

Validate each completed review before comparison:

```sh
python3 tools/dataset/review.py validate \
  --packet /private/calibration-v2-packet.json \
  --reviews /private/calibration-v2-review-a.json
```

Validation requires exact candidate coverage in packet order, one reviewer/model identity per file, complete packet and source provenance, valid UTC timestamps, strict JSON types, valid citations, and all schema cross-field rules. Extra adjudication, `gold`, and verified-promotion fields are rejected.

Compare the two untouched review files into a new artifact:

```sh
python3 tools/dataset/review.py compare \
  --packet /private/calibration-v2-packet.json \
  --review-a /private/calibration-v2-review-a.json \
  --review-b /private/calibration-v2-review-b.json \
  --output /private/calibration-v2-comparison.json
```

The comparison reports raw agreement, per-status counts, each reviewer's abstentions, either/both-abstained counts, and non-unknown agreement and coverage for executor report, attributable outcome, and mission progress. The primary 95% calibration threshold applies to raw `attributable_outcome` agreement. All-unknown reviews can meet that arithmetic threshold, so the report separately marks vacuous all-abstained agreement and its zero informative coverage. `bulk_labeling_ready` always remains false. Any adjudication is a later, separate artifact and must preserve both original reviews.

## Verification

Run the synthetic tests without reading private data:

```sh
python3 -m unittest discover -s tools/dataset -p 'test_*.py'
```

The tests build a temporary immutable archive, index, candidate queue, packet, scaffolds, reviews, and comparison. They cover deterministic extraction, overlap exclusion, provenance tampering, blinded projections, strict form validation, bounded citations, continuation reads, pre-existing mission credit, vacuous agreement, and exclusive outputs.
