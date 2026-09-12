# Historical dataset index and review rubric

This tool creates a derived, private SQLite index of an immutable version-1 archive. It never changes source logs and never treats a legacy success flag as verified mission completion. Use Python 3.10 or newer; no third-party dependencies are required.

Run from the repository root:

```sh
python3 -m unittest discover -s tools/dataset -p 'test_*.py'
python3 tools/dataset/index.py build --manifest /path/to/archive/manifest.json --output /path/outside/archive/index.sqlite
python3 tools/dataset/index.py sample --index /path/outside/archive/index.sqlite --output /path/to/new-candidates.json --limit 300 --seed dataset-v1
```

Output destinations must be new. Index creation verifies every archived file's size/hash, refuses symlinks and path traversal, rejects an incomplete manifest, and finalizes with an exclusive link. The archive must remain immutable throughout the read. This local research tool does not defend against a malicious local account concurrently replacing ancestor directories. Build the index outside the archive. No provider or GPU is used.

## Records and exclusions

The index contains `sources`, `records`, `exclusions`, and `metadata` tables. The summary records the archive-manifest hash, label-rule version, source-line/record/exclusion counts, status cross-tabulation, and exclusion counts. A record ID combines the source content hash and one-based line number; identical captured content copied under another name is excluded as `duplicate_content`, with the alias location retained in exclusions/sources. No chat or complete prompt is duplicated into the database. Source hashes and line locations preserve access for authorized review.

Only `trajectory_jsonl` files are indexed as decisions, but every file listed in the archive manifest is hash-verified. Blank lines, malformed/ambiguous JSON, missing or invalid required fields, lines exceeding 4 MiB, and incomplete trailing lines receive explicit exclusion entries. Oversized physical lines are consumed in bounded chunks and counted once. Source lines must equal records plus exclusions.

`original_success` preserves the old boolean. `revised_status` is a separate `legacy-text-v1` interpretation:

| Evidence | Revised status | What it supports |
|---|---|---|
| Result starts with the known recently-failed gate format | blocked | The action was rejected by that gate |
| Result starts with the known role-denial format | blocked | Policy rejected that requested action |
| Known explicit timeout result | timed_out | Execution reported a timeout |
| Result starts `Action failed: ` | failed | Execution reported failure; partial effects remain possible |
| Other text, including apparently positive results | unknown | Requires more evidence |

These are textual classifications, not new ground truth. Every record remains `quality=observed` and `review_required=1`. Strings merely containing words such as “blocked” do not satisfy a gate rule. The labeler does not infer physical success, goal completion, or intent from fluent prose.

## Candidate selection

Sampling is deterministic for a fixed index, seed, and limit. It balances six broad action families, bot and month, favors session diversity within each family, and collapses exact system/context + action/parameter + revised-status repetitions. It is a review queue, not a random prevalence estimate, a semantic deduplicator, or a train/test split. Near-duplicate loops can survive and require reviewer grouping.

Candidate ranks and family/bot/month rounds are sorted in SQLite with file-backed temporary storage. The query is streamed twice so Python retains only the selected signatures and session groups, bounded by the requested limit. This trades extra local sorting and temporary disk I/O for bounded process memory when an archive contains many distinct bots or months.

Each candidate points to a seven-line window around a decision. Interleaved teammates may occupy those lines; filter by bot, inspect earlier context and later continuation, and extend the window as needed. The tool deliberately does not call this a complete episode. Every candidate is `split=development_candidate`; no held-out test set is created from one persistent historical world.

## Independent episode review

Two reviewers independently inspect each of the first 60 candidates with access to the same restricted source evidence. Record each review separately with reviewer ID, record/source IDs, label version, reviewed UTC, line spans, bot, and the following fields:

- Attempted action and relevant preconditions, separating visible observations from inferred state.
- Execution status: succeeded, failed, blocked, cancelled, timed_out, or unknown.
- Mission progress: achieved, partial, none, or unknown, supported by cited evidence.
- Evidence quality: observed, reviewed, or verified. A reviewed interpretation is not replay verification.
- Recovery sequence and terminal condition, or explicitly censored/missing continuation.
- Contradictions, attribution uncertainty, human/supervisor intervention and privacy exclusions.
- Duplicate/related episode group and development-only disposition.

Reconcile disagreements without deleting original reviewer decisions. Report agreement and unresolved counts. If primary-outcome agreement is below 95%, revise the rubric and repeat review before expansion. This is a process gate, not a statistical claim of accuracy. Unresolved cases must remain out of gold metrics.

A historical record cannot become replay-verified without an appropriate reproducible snapshot. A later inventory observation from a shared world is not automatically attributable to the preceding action. New controlled scenarios inspired by old failures need separate IDs and provenance. Keep all historical source bytes and original labels intact.

## First calibration result and next gate

On 2026-09-12, two independent AI-assisted reviewers inspected the first 60
blinded candidates. They agreed on execution status in 45/60 cases (75%) and
mission progress in 46/60. Twenty candidates had a disagreement on at least
one axis. This fails the proposed 95% primary-outcome agreement gate. These
are model reviews, not human validation or controlled replays. Zero records
were promoted to verified or gold status. Original reviews remain immutable;
disputed fields are unknown in the separate reconciliation artifact.

Before bulk annotation, revise the review form to record these separately:

- The executor's reported result, including its exact supporting text.
- The observed postcondition, its timestamp/source and the preceding state.
- The attribution claim: intervening actions, missing reactive events,
  teammate effects and the elapsed gap can make causation unknown.
- The mission predicate and whether it was already satisfied before the
  sampled action. Existing resources cannot be credited as newly acquired.
- An attributable outcome or unknown, separate from contradictions and
  promising but unverified state changes.

Positive prose is a report, not a postcondition. A later same-bot inventory or
position can be corroboration, but must not automatically become action
success. Conversely, a conflicting later state does not prove this particular
action failed when intervening actions or observation semantics are unknown.
Keep those hypotheses and evidence in the review instead of forcing a label.

Use a common continuation-evidence protocol, calibrate the revised form on a
fresh independently reviewed batch, and report original agreement before any
reconciliation. Agreement reached by discussing the same disputed cases is
not an independent validation score. The existing 300 candidates remain a
development review queue; no bulk labels, locked test split or training run
is authorized by this calibration result.
