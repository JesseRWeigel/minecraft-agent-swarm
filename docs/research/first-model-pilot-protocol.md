# First model pilot: protocol draft

Status: proposed protocol, not frozen or executed. The existing game qualification covers deterministic scripts, including a rejected deadline-limited dig. It does not establish model performance or learning. No inference or live-swarm changes are authorized by this document itself.

## Start with a small adapter pilot

The first model run should answer one narrow question: can a pinned local model use observe/look/dig/move/finish to collect the declared oak log, with independently scored and fully costed actions? It should not attempt all achievements or claim robotics transfer.

Use a fresh copy of the qualified arena for each attempt. Initially give the model the task, action schema, coordinate convention and target location. This deliberately measures action selection and execution, not object discovery or navigation. The current initial advisory observation can contain no visible blocks; omitting the target location would silently add a perception/search task that has not been qualified.

Run two development attempts with the same frozen model, prompt and arena. Preserve all attempts, including invalid JSON, stalls, failed connections and no-score outcomes. Fix adapter defects before defining held-out evaluation; never count development attempts in that evaluation. No frontier coach or retained memory is needed for this first connection check.

## Proposed budgets to qualify before use

These are proposed caps, not implemented runtime guarantees:

| Resource | Initial proposed cap |
| --- | --- |
| Actions, including observe and finish | 25 per episode |
| Model calls | 8 per episode, including retries |
| Input context | 8,192 tokens per call, measured with the pinned tokenizer |
| Generated tokens | 256 per call; 2,048 across the episode |
| Model request wall time | 20 seconds each |
| Inference wall time | 90 seconds cumulative |
| Whole begun episode | 120 seconds, including inference, actions and observation overhead |
| Physical action limits | Existing 6-second dig and shorter look/observe/move limits |
| Concurrent episodes | One |

The current 20-second scripted session and transport deadlines cannot support this unchanged. Before any inference, enumerate and align coordinator, participant session, lifecycle transport, inner/outer relay, server readiness, resource scope and whole-process deadlines. Qualify that a slow or stalled model is cancelled, sockets close, no late response starts movement, and the full trial still fits the enforced resource window. Server readiness and cleanup need separately reserved time; they must not silently consume the action budget.

Treat exhausted budgets and invalid output as failed attempts. Do not repair a model request for free. If one retry is permitted, give every condition the same rule and charge its tokens and latency. Record actual provider usage when available, and report missing usage explicitly rather than substituting tokenizer estimates without a label.

## Freeze a machine-readable run manifest

Before the first actual pilot, fill and hash:

- Model weights/quantization, tokenizer, runtime binary/version, serving configuration and actual loaded model identity.
- Prompt bytes, action schema, observation projection and every source/configuration hash.
- World snapshot, server JAR, dependency manifest, trial id and condition id.
- Each enforced deadline and token/action/call cap, retry policy, random seed and decoding settings.
- Start/end timestamps, GPU/device identity and concurrent workload policy.
- Price source/date for paid calls, currency, and whether local energy/hardware costs are measured, estimated or unavailable.

Pinning only an endpoint name is insufficient. A running service must attest or be independently checked against the declared loaded artifact. Any unresolved field leaves the manifest a draft. The live swarm must not compete for the same GPU during a measured local-model run; arrange a logged maintenance window through the existing operations protocol before taking that resource.

## Follow with a learning experiment, not more adapter claims

After the small pilot works, use a 2-by-2 design to separate coaching from retained learning:

| Condition | Frontier coaching | Retained lessons |
| --- | --- | --- |
| A | Off | Off |
| B | On | Off |
| C | Off | On |
| D | On | On |

Keep the local model/team topology identical across conditions. Freeze the coach's role, maximum calls, input evidence and output schema. Coaching must be advisory text routed through the same restricted action interface, without RCON, world editing or hidden manual interventions. Charge every coaching call, including failed/retried calls. Do not compare an inexpensive single actor against a differently configured team and attribute the difference solely to coaching.

Only retained lessons cross episode boundaries in C/D, in a bounded versioned artifact. A/B start with empty memory every episode. Reset world state each episode in all conditions. Hash lesson versions and record which exact version each episode read. No lessons, summaries or model-generated code may leak across condition stores or from held-out evaluation back into training.

Use a declared development split to build lessons, then freeze memory before held-out scoring. Hold out meaningful task variants (layout, reach, collection route and distraction), not merely trial ids. The current single visible oak-log arena is inadequate for a learning claim. Predetermine the number of repetitions and randomization before seeing results; a small pilot estimates feasibility and variance, not statistical significance.

Primary reporting should include independently scored completion, valid-evidence rate, all-attempt cost, elapsed time and actions. Report infrastructure failures separately and retain them in the attempted-run denominator; apply any exclusion rule symmetrically and show the unfiltered table too. Compare both success at a common total budget and observed cost per success. A zero-success condition has undefined cost per success, not zero cost.

## What this could support

A reproducible dataset of goals, advisory observations, chosen actions, failures, interventions, independent outcomes, lesson versions and actual costs would be useful for studying agent reliability and learning from experience. Minecraft movement and block actions alone do not establish robotics transfer. That would require a separate transfer task, embodiment assumptions and evaluation.

## Next implementation order

1. Characterize the remaining bridge shutdown issue without changing failure criteria.
2. Add a bounded model-provider adapter and budget ledger; test with a local stub before inference.
3. Align and qualify all deadlines for the proposed pilot, then freeze concrete model/prompt/runtime identities.
4. Coordinate a logged GPU window and execute the two development attempts.
5. Design and freeze the broader held-out learning experiment from the development findings.
