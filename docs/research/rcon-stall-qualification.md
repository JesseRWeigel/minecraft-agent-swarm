# RCON query stall: preserve partial observations

A real TCP regression test exposed a timeout race in the protected observer.
The command sampler and its outer Promise guard both had a five-second deadline.
The outer guard could fire first, preventing the sampler's structured failure
and already-completed observations from reaching stdout. This lost evidence;
it did not create a successful score.

The sampler still gets five seconds. Its outer guard now allows six seconds,
so the sampler can return its bounded partial result. This applies to ordinary
samples and the sample following fixture setup. The overall 25-second observer
watchdog and parent process deadline remain unchanged. The margin does not
promise output under an indefinitely blocked event loop or total-watchdog expiry.

## Transport regression, 22 September 2026

`tools/pilot/protected-rcon-stall.test.mjs` uses the real `rcon-client` transport
against a test-only loopback TCP endpoint on an ephemeral port. That endpoint:

1. Authenticates the synthetic credential.
2. Receives the fixed actor position query and returns a valid position.
3. Receives the dimension query and deliberately leaves the connection open
   without replying.

Before the fix, the test failed because stdout contained no JSON. After the fix,
it verifies one structured failed sample containing only the completed position,
a timeout on the dimension query, no later queries, exit code 1, generic stderr,
no credential disclosure and closed client/server sockets. Completion is bounded
below nine seconds. The unchanged host scoring contract rejects failed or
incomplete samples, so this is never an observed stationary control.

The test runs in CI with Node 20 and 22 after dependency installation:

```sh
node --test tools/pilot/protected-rcon-stall.test.mjs
```

For a pinned local client snapshot, `PILOT_TEST_RCON_MODULE` may identify its
absolute file URL for `rcon-client/lib/index.js`. That override exists only in
the test. Production request schemas and fixed RCON endpoint are unchanged.
The pinned client's `maxPending: 1` also sets its EventEmitter listener limit to
one; overlapping pending-query and cleanup listeners emit a warning during this
fault. The regression verifies socket closure; it does not claim a heap-leak audit.

## Evidence boundary

This is a real TCP protocol fault with a synthetic RCON server, not a stalled
Paper process or a new Minecraft gameplay trial. No world, swarm mode, live
process, model or GPU workload was changed. Previous game controls retain their
original captured sources. A combined isolated-game RCON stall and remaining
mid-action faults are still release gates, followed by redistributable inputs
and the prespecified model comparison.

[Real-game follow-up](rcon-game-qualification.md): Paper reply withholding now
has a retained fault case and forward control. Storage headroom blocked the
stationary control; the combined check remains incomplete.
