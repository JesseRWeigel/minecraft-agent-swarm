# Synthetic pilot lifecycle qualification

Run a complete tiny offline demonstration from the repository root:

```bash
python3 -m tools.pilot.smoke demo --output /private/new-pilot-demo
```

The parent directory must exist. The destination must be new and its path must
not contain symlinks. Files are private (0600) and directories are 0700. The
command builds synthetic prospective inputs, prepares them, restores a fresh
state for every seed/condition/scenario combination, executes built-in fake
actions, and writes `smoke-run/report.json`. It uses no Minecraft server,
network connection, external provider, GPU, or production configuration.

To qualify a previously prepared synthetic fixture:

```bash
python3 -m tools.pilot.smoke run \
  --prepared /private/prepared-fixture \
  --manifest-sha256 THE_REVIEWED_PREPARED_MANIFEST_SHA256 \
  --output /private/new-smoke-run
```

The caller supplies the manifest hash. The runner captures and verifies every
listed input, rejects unlisted files and symlinks, then revalidates the captured
plan and runtime identity in a private temporary directory. Execution uses
those captured bytes. Changes to the original input files cannot change an
already captured case.

Only uncompressed, bounded synthetic tar fixtures containing the single file
`world/state.json` are accepted. The existing tar scanner validates the entire
archive; the consumer then reads only that fixed payload. It never extracts
arbitrary paths. The payload has schema version 1, `synthetic: true`, and an
`actors` object whose entries contain integer XYZ coordinates and a standard
Minecraft dimension identifier. This is a tiny grid fixture, not Minecraft
world data or a simulated physics engine.

Only `builtin-fake` / `grid-fixture` / version `1` is supported. Conditions must
explicitly choose `fake_behavior`: `move_to_goal`, `claim_only`, or `fail`.
The condition labels do not implement real coaching or coordination. Both
conditions in the demonstration run the same fake behavior; their results
establish no advantage. The fixture plan uses an all-zero source commit as an
explicit synthetic placeholder. The report separately fingerprints the files
actually used by the controller; it does not claim to verify execution against
the declared plan commit.

The runner supports navigation goals only and reuses the benchmark's objective
pre/post-state predicate. Starting inside the target is rejected. Provider
prose cannot satisfy a goal. Each case gets its own private initial and final
state files, event observations, counters, and outcome. Dimension mismatch,
failed fake providers, budget exhaustion and late responses cannot become
successful trials. An incomplete run retains partial evidence without a final
report; the controller never cleans up arbitrary output directories.

Budgets are checked before each step/request. A request charges its known
input and reserves maximum output before invocation. Completion reconciles
actual output and checks the deadline; a late completion retains its usage but
cannot count as an on-time success. Failed calls retain their pending output
reservation conservatively. These are fixed synthetic accounting units, not
measured model tokens or dollars. Deadline enforcement occurs at boundaries;
it is not hard cancellation of a blocking external call. There is no external
call implementation here.

Smoke-specific bounds are 1 MiB per captured file, 8 MiB total captured input,
128 cases, 256 steps per case, and 64 KiB for the single world-state payload.
An exit code of zero means all requested cases were recorded, including failed
or exhausted cases; inspect their outcomes. It does not mean every case
succeeded. `synthetic_smoke_completed` and `live_benchmark: false` remain
explicit in all reports.

Next: implement and qualify a separately isolated Minecraft server process
controller, verified real-world restoration and runtime/skill manifests,
provider cancellation and actual usage accounting, and broader objective
predicates. Coordinate a research window with Fable before using the GPU or
starting a real controlled trial. Never reset the live world to run this smoke
command.
