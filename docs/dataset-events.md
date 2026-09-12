# Prospective dataset events

This change adds collection formats for future process runs. It does not rewrite or relabel historical logs, restart the live swarm, create a world snapshot, or claim that any collected action completed a mission.

## Files and joins

Restricted event data is written below `logs/episode-events-v1` by default:

- `events/<readable-run-id>-<sha256-of-full-run-id>.jsonl` is the append-only event sequence.
- `payloads/<hash-prefix>/<sha256>.json` holds content-addressed payloads.
- `DATASET_EVENT_DIR` and `DATASET_RUN_ID` can select a different root and run.
- New compact summaries use `logs/trajectories-v2/<process-session>.jsonl`. Explicit session IDs must already contain only letters, digits, dots, underscores, or hyphens so distinct IDs cannot collapse onto one file. Existing `logs/trajectories` files remain unchanged.

Every provider call has a new request ID. The request and response events share that ID. Every top-level action routed through the brain has a new action ID; its start, normalized decision, execution observation, and terminal outcome share that ID. Strategic actions also receive a compact trajectory summary. Provider-derived actions retain the request ID. Deterministic overrides and the respawn hostile reflex are captured without a provider request.

This is not a complete trace of every Mineflayer control update. Movement, pathfinder calls, and helper actions nested inside a skill remain evidence inside the enclosing top-level action rather than separate action records. New top-level reactive paths must use the brain capture wrapper.

`episodeId` currently means one process-run and bot collection session (`<run-id>:<bot>`). It is not a mission, scenario, independent trial, world reset, or evaluation episode. A future scenario runner must define those boundaries and write independently verified episode-end predicates.

Each action terminal uses one of `succeeded`, `failed`, `blocked`, `cancelled`, `timed_out`, or `unknown`. These values describe observed action execution only. They do not establish mission progress. Exact chat transport confirmation is recorded as succeeded. Explicit guards, exceptions, and exact timeout/interruption protocols receive typed outcomes. Positive built-in prose stays unknown. A skill's legacy reported boolean is retained as `reportedSuccess`; a true value remains `unknown/skill_reported_success_unverified` until an independent postcondition checker supplies evidence. Same-skill busy responses are blocked before a legacy boolean can be consumed.

## Provider capture

Capture happens at the provider boundary before decision parsing. The restricted request payload contains the model, sampling options, and the message array actually sent. Successful responses retain the provider envelope (or a bounded pre-parse wire response for OpenAI-compatible HTTP), provider/model identifiers, duration, and provider-supplied token quantities. Malformed and failed responses retain bounded response metadata when available. Missing usage is `null`; the collector does not infer token quantities or cost. Retries are separate requests with separate IDs.

Provider responses, parser results, and local fallbacks are recorded separately. Valid action aliases and repairs retain provider origin with a normalization trace. No-JSON replies and replies missing an action keep the originating request ID, usage, and provider metadata but are marked `local_fallback`; malformed JSON follows the query's existing safe fallback with the same provenance. Critic parse fallbacks follow the same rule, so synthesized idle, flee, or critic values cannot be presented as provider proposals.

Payload serialization redacts credential-shaped object keys such as `authorization`, `apiKey`, `access_token`, cookies, passwords, and client secrets. It preserves provider accounting fields such as `prompt_tokens`, `completion_tokens`, `total_tokens`, and `tokenCount`. The captured messages are therefore a redacted snapshot of the exact provider-bound request structure, not a promise of byte-identical provider traffic. Secrets embedded inside arbitrary message or response strings are not guaranteed to be detected. Keep this source restricted and perform a separate content and provenance review before any release.

## Collection context and health

Request, action-start, and trajectory records include an explicit collection-context snapshot. The optional values come from:

- `DATASET_OPERATION_MODE`
- `DATASET_TRIAL_ID`
- `DATASET_GIT_COMMIT`
- `DATASET_DIRTY_DIFF_HASH`
- `DATASET_WORLD_SNAPSHOT_ID`

Unset values remain `null`; collection never invents them. These fields support later joins to the separately maintained operations ledger. They do not prove that the world snapshot is consistent or that a named trial followed an evaluation protocol.

The event recorder exposes an in-process health state. Any event or trajectory write failure marks it incomplete and emits a visible `[Telemetry]` error without crashing gameplay. Each trajectory v2 row snapshots that health after its action events were attempted. Consumers must exclude or explicitly classify rows whose `telemetry.complete` is false, including rows with dangling evidence references. A whole-device failure can still prevent both the event and health snapshot from reaching disk; this is not durable transaction storage.

Recovery is deliberately narrow. `recoverInterruptedActions()` reconciles unmatched starts in the explicitly selected, inactive run file and marks them `unknown/process_interrupted` with a synthesized flag. The default startup creates a new random run ID and does not scan previous runs. An unterminated final line, including otherwise valid JSON without its newline, or a mismatched embedded run ID marks the recorder incomplete and blocks appends and recovery without changing the original bytes. Serialization failures store an explicit diagnostic payload rather than claiming the original payload was captured; subsequent writes return an unavailable reference without further I/O. Offline cross-run auditing for missing terminals remains a future task.

## Rollout and operations

Collection begins only after reviewed code is deployed and the bot process is restarted under the existing operations protocol. No current process is modified by merging this code. Operators should set the commit, dirty diff hash, operation mode, and trial identifiers before restart when those facts are known.

The format creates one event-log append plus content-addressed payload files. At historical traffic near 10,000 decisions per day, request, response, action, and observation payloads can create tens of thousands of small files daily. There is no automatic retention, compaction, rotation, or cleanup in this foundation. After the first supervised collection cycle, measure bytes, inode/file growth, event/payload reconciliation, and archive throughput before enabling long-term unattended retention. Existing archive manifest and index size limits also need a scalability check against this format.

The first rollout should verify:

1. event and payload directories and files are restricted to the collector account;
2. every action start has one terminal or a documented synthesized recovery record;
3. request/action IDs join through parser fallback and reverse completion order;
4. trajectory rows report healthy evidence references;
5. disk space and file counts remain within the operator's alert thresholds; and
6. no release copy is made before privacy, provenance, and license review.
