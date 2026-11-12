# Bounded local-model Minecraft demo

This is a developer demonstration on one fixed disposable survival fixture, not
a general agent benchmark, a learned-skill result, or a production swarm.

The model chooses each action. The trusted broker validates a small JSON action
schema; the game observer, not the model's text, determines whether an oak log
was acquired. No live world is loaded or reset.

## What is real

- Existing local GGUF weights and the bundled llama-server runtime are pinned.
- All inference is local. No cloud API, download, new subscription or paid service.
- An owned backend runs inside the protected outer network namespace. Its private
  UNIX socket and GPU device are unavailable to the nested game participant.
- Tokenization uses the runtime's native tokenizer. Completion receives exactly
  those token IDs, and its evaluated count must match.
- GPU qualification requires CUDA device and positive offloaded-layer evidence.
  A CPU fallback is rejected, not mislabeled as GPU performance.
- The backend is terminated and reaped after the trial. Cancellation testing
  verifies process-group disappearance, not merely a closed HTTP connection.

## Limits and evidence

The explicit local-model resource profile allows at most 16 GiB host memory,
no swap, two CPU equivalents and 256 tasks, with the existing 180-second
whole-trial bound. Backend startup has 30 seconds, one separately recorded
warmup has 20 seconds / 32 output tokens, and gameplay retains the original
20-second action deadline. Gameplay permits at most 8 model responses and
256 output tokens per response. Invalid, late or malformed actions are rejected.

Model snapshots are exclusively created, size/hash-verified and mounted
read-only. Before capture, free-space preflight reserves the model copy,
game image and 40 GiB host reserve. Raw images/logs remain private. Only reviewed
derived results should be published.

An infrastructure qualification is not task success. Report both values:
`infrastructure` and `task_acquired`. A failed-loop observation may precede
participant quiescence; it is explicitly labeled and must not be presented as
a clean post-action endpoint. Every attempt, including failures, is retained.

## Reproduce

Use the existing [fresh fixture](fresh-fixture.md), [pinned client snapshot](clean-checkout-reproduction.md)
and [bounded storage](bounded-storage.md). Java 21, Node 22, supported Linux/WSL,
Bubblewrap, working user cgroups/FUSE and the existing CUDA runtime are required.
This command does not install anything or accept the Minecraft EULA.

```sh
python3 -m tools.pilot.local_model_demo --launch \
  --model qwen3.5:9b \
  --workspace "$NEW_PRIVATE_WORKSPACE" \
  --archive "$FIXTURE_ARCHIVE" --archive-sha256 "$FIXTURE_SHA256" \
  --paper "$PAPER_JAR" --paper-sha256 "$PAPER_SHA256" \
  --bootstrap "$MOJANG_JAR" --eula "$EXISTING_ACCEPTED_EULA" \
  --client-tools "$CLIENT_SNAPSHOT" --client-manifest-sha256 "$CLIENT_PIN" \
  --storage-tools "$STORAGE_HELPERS" --bwrap "$PROTECTED_BWRAP"
```

The launcher currently supports the two explicitly pinned installed candidates
`llama3.2:3b` and `qwen3.5:9b`; it is not an arbitrary model-download command.
Paths for the installed runtime/model blobs are deliberately explicit in
`local_model_config.py`. Porting to another installation requires reviewed
pins and prerequisites, not silently guessing a compatible model.

The Qwen no-thinking generation prefix was checked against the installed
GGUF's `tokenizer.chat_template`:
`<|im_start|>assistant\n<think>\n\n</think>\n\n`.
The model-weight digest pins that metadata too. Llama uses explicit Llama3
framing. The two development attempts are not a controlled model comparison:
prompt/history presentation changed during implementation.

## Verification status

A real local GPU smoke test produced valid JSON with exact 20 input / 6 output
tokens and 29/29 layers offloaded. A separate cancellation probe observed an
active inference slot before cancelling; backend TERM then KILL, HTTP-worker
reaping, process-group absence and idle GPU were verified.

The first Llama 3B gameplay attempt repeated look actions until the 8-call limit.
It is a failure, not a successful demonstration of collection. The first Qwen
attempt failed in storage preparation before any game/model process launched.
A separate tiny storage diagnostic succeeded. See the derived attempt ledger
for subsequent results rather than omitting these failures.

The generic `look_at` primitive faces the center of a model-chosen block. It
does not choose the target, mine it, move the bot, or insert a task solution.
It supplements the lower-level yaw/pitch primitive and is tested at arbitrary
coordinates. This is an interface change, so before/after development runs are
not an apples-to-apples model benchmark.

## Recorded outcome, November 12

[The complete derived attempt ledger](local-model-results-2026-11-12.json)
contains all four preserved attempts, including the pre-launch storage failure.
No run established successful collection. The last Qwen run selected the chosen
block with `look_at` and received a completed dig reply, but did not collect it;
a later invalid dig ended the participant before a valid terminal endpoint was
captured. This is progress in tool use, not a successful survival-task result.

Do not turn the failed-trial observation into a success claim. In the preceding
Qwen attempt, the independent observer reported no acquired log; that observation
was taken on a failure path, not a clean finalized episode. The last attempt's
terminal endpoint is unknown.

Verification: 312 Python pilot tests (no skips), 1,054 npm tests, lint, typecheck,
format check and build passed. Real GPU smoke and active-inference cancellation
checks passed. Further gameplay tuning stopped after the planned bounded pass.

A useful next experiment is better feedback about dropped items and recoverable
action errors, with a frozen prompt/tool version and a declared trial budget.
Do not increase model size, retry indefinitely or publish cherry-picked wins.

## Frozen feedback follow-up

The [predeclared plan](feedback-trial-plan-2026-11-12.json) froze source,
prompt, model/runtime pins and a maximum of two trials. The second was allowed
only after clean acquisition on the first. [Results](feedback-trial-results-2026-11-12.json):
one trial ran, failed, and the batch stopped without tuning or retry.

Dropped-item feedback worked: after digging, the model saw a nearby oak-log
entity with its position. It then moved right, observed that it had moved away,
and moved right again into the wall. It exhausted eight calls without collecting.
An independent failure-path observation reported no log; this is not a clean
finalized successful episode. All owned processes and storage were cleaned up;
resource limits held without violations.

Expected pre-dispatch dig failures now return one of four strict recoverable
codes. No dig is executed for a rejection. Unsafe/malformed commands,
unexpected API errors, disconnects and deadlines remain fatal. This recovery
path passed protocol tests; this particular live trial did not exercise a
rejected dig.

Reproduction can reuse an existing private, read-only model snapshot with
`--reuse-model-snapshot "$VERIFIED_SNAPSHOT"`. The launcher rehashes it,
validates ownership/mode/ancestors and mounts it read-only. No old evidence is
deleted. GPU preflight checks idle compute, utilization and available VRAM;
this is a point-in-time check, not exclusive reservation.

Updated verification: 317 Python pilot tests (no skips), 1,063 npm tests and
standard checks passed. The user-facing autonomous collection goal is still
unfinished; the draft remains unmerged. The next bounded design question is
how to expose safe target-directed movement rather than require reliable
low-level spatial control from the model. Larger models or more retries are
not established solutions.
