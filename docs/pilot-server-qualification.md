# Actual isolated-server qualification — 2026-09-19

A preserved backup was restored into a new private runtime and started under
the pilot controller with no host networking. This was development
qualification, not a frozen controlled gameplay trial. The live swarm, its
operating mode, and its original world were not changed.

The first attempt exited with code 1 because Paperclip tried to download its
missing vanilla cache. Networking remained disabled. Inspection of the pinned
Paper JAR identified the required cache filename and SHA-256; an existing local
cache matched it. The restore tool now accepts that explicit input, verifies it,
and records it in the runtime manifest.

The fresh second runtime used Paper/Minecraft 1.21.4 and Java 21. It reported
`Done (7.855s)!`, remained under a 90-second controller limit, accepted the
controller's `stop`, reported saves for all three dimensions, and exited with
code 0. Total observed lifecycle duration was 90.725 seconds. Neither TERM nor
KILL was needed. Cleanup verification covers the owned process group and
captured pipes; namespace containment is configured separately.

The original backup's SHA-256 still matched after the test. Both runtime copies
and private lifecycle logs were retained outside the source checkout. No model
provider or GPU workload was started, and no raw world/log data is published
here. Expected authentication-key lookup failures occurred because network
access was disabled.

These observations qualify offline bootstrap and graceful shutdown from the
preserved backup. They do not establish protocol readiness, successful client
login, independent state observations, gameplay performance, or trial validity.
The machine-readable lifecycle correctly keeps `ready: false` and
`live_benchmark: false`; `timed_out` means the requested 90-second deadline
triggered graceful stop, not that startup failed.

Next: run the server, deterministic client and observer within the same network
namespace, choose an explicitly isolated authentication arrangement, and verify
loaded-world identity and a simple task without a language model. Model-consuming
trials still require the separate frozen-runtime and operations protocol.
