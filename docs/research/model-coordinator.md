# Bounded model/action integration (synthetic provider, protected game)

Status: synthetic-provider plumbing qualified in a real isolated Minecraft fixture;
not a real-model outcome study.

`tools/pilot/model_coordinator.py` connects the existing owned-worker Ollama
transport and inference ledger to the existing participant action descriptors.
It obtains an initial observation, passes a detached copy of the action transcript
to trusted prompt-building code, and sends each completed model JSON response to
the participant action broker. The broker remains responsible for action-schema
validation; model output never becomes Python, JavaScript, shell, or an observer
command.

The caller supplies an explicit loopback port, exact model name, prompt builder,
and full rendered-prompt tokenizer. There are no real-model defaults. The loop
allows at most eight inference attempts and a shared wall deadline of at most
120 seconds. It checks cancellation and the deadline before inference, after
inference cleanup, before writing actions and while awaiting action replies.
Failed, cancelled or unfinished loops close their host action descriptors.
Success requires an explicit model finish action; budget exhaustion is not success.

The returned transcript contains prompts, completed model content, adapter receipts,
action requests/replies and budget entries. Failed provider responses remain hash
receipts rather than raw wire artifacts. The caller must securely persist this
bounded evidence and own participant finalization, process cleanup, EOF auditing,
server-observer evidence and scoring. Trusted prompt/tokenizer callbacks must not
block indefinitely: the loop rejects late callback returns but cannot preempt
arbitrary Python callbacks. This is not a claim that the entire boot-to-teardown
lifecycle is already bounded by 120 seconds.

## Tests

From the repository root:

    python3 -m unittest tools.pilot.test_model_coordinator -v

The synthetic integration uses a real local HTTP fake server, the real adapter
worker process, and the real Node participant/action protocol with an injected
fake bot. No Minecraft server, Ollama daemon, model download or GPU is involved.
Tests cover successful multi-step action exchange and lifecycle/EOF completion,
invalid action rejection, pre-cancellation, cancellation after a completed adapter
call, late inference output, call-budget exhaustion, tokenizer failure, and slow
prompt construction.

## Before a real pilot

1. The fake_model protected driver is now connected; a real backend still needs
   its own protected transport, full lifecycle deadline and backend cleanup.
2. Pin and verify model weights, runtime, tokenizer, chat template and prompt.
3. Qualify real-backend cancellation; client socket closure alone is insufficient.
4. Use the isolated oak-log fixture and server-verified predicate. Preserve the
   live swarm/world and arrange a bounded GPU window.
5. Report infrastructure outcomes separately from task success and learning.

## Local verification, November 12, 2026

- New model coordinator tests: 10 passed with Node 22.22.0.
- Final pilot discovery: 271 tests passed, including all explicit Bubblewrap
  namespace checks; no skips. Eight new fake-driver receipt tests passed.
- Dataset: 108 passed; operations: 19 passed; benchmark: 45 passed.
- Node 22 action-protocol suite: 36 passed.
- git diff --check passed.
- Independent review found an oversized-prompt retention gap. Fixed by validating
  before snapshot/tokenization and passing tokenizer a detached copy; both new
  regression tests were independently verified.
- Updated onto current main (9b0d492), preserving the Minecraft 26.3 bridge work.
- npm lint (existing warnings only), typecheck, format:check and build passed.
  The full npm test suite passed all 1,052 tests using Node 22.22.0.
- Correction: Bubblewrap was not on PATH or installed through dpkg, but the
  existing protected copy at /opt/codex-pilot-tools/bwrap is present (0.9.0) and
  passes the repository's root-ownership/ancestor validation. No installation
  is needed. This is a pre-existing protected-test prerequisite, not a new
  general application dependency.
- The AI computer reported an RTX 5090 with no GPU activity at initial inspection.
  WSL Ollama was reachable and no models were loaded; model names were read only.
  No model inference, download or live-world action was performed. The protected
  tests below started disposable game servers only.

## Protected gameplay check

The explicit `action_driver="fake_model"` option on `run_oak_qualification`
serves the fixed forward/stationary action sequence through an ephemeral HTTP
fixture inside the outer network namespace. The participant remains in its
separate game-only namespace. This fake provider cannot select a real Ollama
endpoint. Its token counts are synthetic fixture constants, not measurements.

The wrapper retains the existing action-script shape and validator and additionally
stores the complete `synthetic_model` receipt, provider identity and shutdown
evidence. Both host and worker validate this extra evidence; the captured file
must equal the embedded receipt. Server-side observer evidence remains the
only source for the gameplay endpoint. The 20-second action and existing
whole-trial process/resource/storage limits remain unchanged.

November 12 paired runs, source manifest
`6026d8178cfaf2fe71d6b020397a959a7dc2b617fd48f317b8ade0b6225819f6`:

| Control | Fake calls | Action duration | Independent endpoint |
| --- | ---: | ---: | --- |
| Forward | 6 | 4.4567 s | Oak log acquired; qualification passed |
| Stationary | 1 | 0.1500 s | No log acquired; negative-control qualification passed |

Both had normal participant/Java exits, verified action EOF, stopped fake
providers, valid resource scopes and clean verified storage unmounts. Each
restored its own disposable copy of the pinned September22 fresh-world archive.
Raw images and credentials stay private; no live world was mounted.

These initial runs preceded review hardening of receipt validation and
pre-dispatch deadline rejection. Their captured receipts also passed the final
validator. The complete pair was then rerun successfully on the final sources.
[Final derived receipts](model-coordinator-results-2026-11-12.json) record the
new source pin, timings, endpoint and cleanup checks; both controls qualified.

## Real-model boundary

Local read-only inspection found Ollama 0.32.9 and candidate `llama3.2:3b`
(Q4_K_M, approximately 2.02 GB), metadata digest
`a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72`
and chat-template SHA-256
`966de95ca8a62200913e3f8bfbf84c8494536f1b94b49166851e76644e966396`.
This records a candidate, not independent weight-integrity verification or
approval as a final benchmark model. No model was loaded.

A trusted full-prompt tokenizer/chat-template binding, real-backend cancellation
qualification, and a narrow backend transport compatible with the isolated game
namespace still need implementation. Do not replace these with approximate token
counts or expose the participant to the host network merely to start a model.

Subsequent real-backend work is tracked separately in [the bounded local-model demo](local-model-demo.md); the results above remain synthetic-provider results.
