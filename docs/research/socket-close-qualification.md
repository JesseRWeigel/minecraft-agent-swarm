# Participant socket shutdown correction

The pinned minecraft-protocol implementation's end() method starts stream shutdown and returns without waiting for the socket to close. Both isolated participant implementations previously awaited that void result and immediately destroyed the socket.

Real loopback TCP regressions reproduced two problems before the fix: delayed final peer bytes were lost, and a peer that never closed still produced protocol_completed. The corrected participants subscribe before requesting quit, wait within the existing cleanup budget for a clean socket close with readable and writable completion, and report failure if cleanup times out or errors. Forced destruction remains the bounded fallback. Relay resets, pending bytes and incomplete drains remain failures.

The tests cover both oak and protected movement participants. The full pilot JavaScript suite passed 174 tests locally. A read-only review found no retained close/error listeners or unbounded cleanup path. The test uses a real socket with a protocol-compatible void quit callback; it does not claim to reproduce the historical Minecraft failure.

An isolated scripted oak collection qualified with the change: seven requests, one oak log acquired, normal lifecycle and independent score. The same-source stationary attempt failed before game launch because the private storage helper exited 3 during mount. Its image and manifest remain preserved; its missing score is not a stationary-control pass. No model inference or live-swarm changes were made.

The historical intermittent bridge failure remains unattributed because its original artifact recorded only generic bridge errors. This correction addresses a demonstrated shutdown defect; a passing game control cannot prove that every historical bridge failure is resolved.

[Recorded attempts and verified hashes](socket-close-results-2026-09-23.json). The [first model-pilot protocol](first-model-pilot-protocol.md) remains a draft until deadlines and concrete model identities are qualified.
