# Deadline-limited scripted interruption

On 22 September 2026, the scripted collection path was run with an explicit
half-second coordinator deadline. Observe and look completed; dig was sent but
never received a reply or completion timestamp. The coordinator returned after
0.5015 seconds. The trial remained failed, with no terminal observation, lifecycle
completion or score. The partial action receipt was preserved.

[Machine-readable evidence](scripted-deadline-results-2026-09-22.json) includes all
three attempts, independent observations, action traces, fault configuration,
source/input hashes, and hashes rechecked from the closed storage images.

| Attempt | Condition | Outcome |
| --- | --- | --- |
| 001 | Scripted forward, 0.5-second deadline | Two completed requests, unfinished dig; no score |
| 002 | Scripted forward, ordinary deadline | Seven requests; oak log acquired; 4.082-second action exchange |
| 003 | Scripted stationary, ordinary deadline | Two requests; empty inventory, intact target and unchanged position |

All three used the same captured source, controller, world snapshot, server JAR
and dependency manifest. These are one trial per condition on one WSL host,
with no model calls and no live-world changes.

## What the evidence establishes

A configured fault record is not itself proof that an interruption occurred.
`tools/pilot/scripted_interruption.py` separately audits the matching fault records
and partial transcript. It requires a half-second configured deadline, elapsed
time between 0.5 and 2 seconds, the exact completed observe/look prefix, an
unfinished dig, and correctly ordered finite timestamps. Missing, mismatched,
early or successful-script records fail this negative-evidence check.

The evidence export additionally verified the files recovered from each closed
image against the host hashes and worker records, independently verified fixture
and baseline, missing terminal score, normal Java stop, and confirmed whole-scope
cleanup. The negative trial's resource scope reports `valid: false` because its
worker exited unsuccessfully; the kernel limit checks and cleanup still passed.
This expected failure is retained rather than converted to gameplay qualification.

As an offline acceptance check, the successful control's full worker record and
server endpoint were combined with the interrupted action receipt. Acceptance
still failed, including after changing the receipt status to `finished`. This is
a forged-record regression, not an actual in-game item injection in this batch.

## Limits

The coordinator currently records a generic transport failure, so these artifacts
do not identify the precise low-level exception. They demonstrate the imposed
deadline, elapsed time and incomplete dig. The supervisor forcibly killed the
participant during cleanup; graceful cancellation of an in-flight dig is not
established. Java stopped normally, the game bridge completed, and the owned
resource scope was confirmed inactive. No terminal sample is synthesized.

The historical intermittent bridge shutdown failure remains unresolved and did
not recur in this batch. Model learning, comparative costs and robotics transfer
remain untested.

## Reproduction and next work

Use the existing [scripted qualification recipe](scripted-oak-qualification.md)
with a fresh workspace and `action_driver="scripted"`, `control_mode="forward"`,
`failure_case="scripted_deadline"`. A failed/non-scoring summary is expected.
Run separate forward and stationary controls with `failure_case="none"` from the
same source and input pins. Keep all attempts and recheck storage reserve before
each launch. Fixed-client and stationary deadline-fault combinations are rejected.

The offline predicate audits only its three supplied records. Callers must verify
file hashes, fixture/baseline, failed lifecycle and cleanup separately, as above;
it is not a complete trial validator and never supplies a gameplay score.

Next resolve or characterize bridge shutdown reliability, then freeze the first
model pilot's conditions, token/time budgets and cost accounting. Do not count
these scripted trials as model performance results.
