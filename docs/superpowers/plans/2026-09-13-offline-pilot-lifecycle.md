# Offline pilot lifecycle implementation plan

Goal: qualify preparation, per-case reset, objective observations, and request budgets without contacting Minecraft or a provider.

Design: extend the existing prepared-input pipeline with a strictly synthetic consumer. Require the caller to pin the prepared manifest hash. Revalidate and capture referenced bytes before running. Accept only a bounded fixture archive containing world/state.json; never extract arbitrary archive paths. Restore the captured state into a fresh private case directory for each seed/condition/scenario. Use only built-in fake actions and objective navigation predicates. Preserve failures and budget-exhausted cases. Mark every artifact synthetic and not a live benchmark.

This is an offline qualification stage. It is not a Minecraft server process controller and cannot establish robotics transfer or model learning. Actual server restoration, process containment, runtime freezing, and research-window coordination remain subsequent work.

Implementation:
- Budget module and regressions: strict five-field limits, pre-request reservations, no overspend, monotonic deadline checks, step limits, explicit failure handling. Agent owns budgets.py and test_budgets.py.
- Synthetic controller and regressions: pinned manifest/source validation, small archive fixture capture, private independent resets, seeded fake navigation, fail/claim-only behaviors, complete outcome accounting, no network/process hooks. Root owns smoke.py, smoke_fixture.py and tests.
- Independent review: verify input integrity, filesystem ownership, resource bounds, and honest claims. Test malformed manifests, tampered snapshots, symlinks, nonsynthetic inputs, exhausted budgets and provider failures.
- Run focused and full relevant suites, execute a private demo, update docs and issue 32, push only after review and tests, verify exact-commit CI.
