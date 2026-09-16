# Isolated Minecraft lifecycle plan

Goal: restore pinned preserved inputs into a new private runtime and supervise only its own namespace-isolated server process.

Restore contract: copy a hash-pinned tar/tar.zst archive and server jar from stable regular file descriptors, accept a previously accepted EULA file, bound decompression and extraction, restore only the three named world trees, discard archived live configuration/identity files, generate safe configuration, and publish a file-hashed runtime manifest last. Never overwrite or remove existing user directories. Retain failed preparation for diagnosis without a completion manifest.

Controller contract: require a pinned runtime manifest and verify all runtime files before launch. Use fixed Java arguments under Bubblewrap with a new network namespace, limited read-only system paths, a writable private runtime, minimal environment, and no host home or credentials. Supervise a new process session with bounded logs and elapsed time. Stop gracefully, then terminate only the owned process group. Keep early exits, timeouts, overflow, interruption, and uncertain cleanup explicit. Logs alone never establish readiness or trial success.

Tests: synthetic archives; corruption, traversal, links, collisions, extension entries, expansion limits, missing EULA acceptance, existing output and input tampering; fake processes for exit, hang, overflow, descendants, stop behavior and cleanup. Do not launch Java/Minecraft or restore a live backup during implementation. Real server qualification, isolated observer integration, and GPU trials remain separate steps.

Implementation split: root owns restore.py/tests and integration; agent owns server.py/tests/docs; independent agent reviews both. Run relevant suites and full CI before reporting completion.
