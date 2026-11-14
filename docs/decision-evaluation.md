# Bounded local decision evaluation

`tools/decision-eval.ts` sends the real Forge strategic prompt (`buildStrategicPrompt` + `FORGE_CONFIG`) and six fixed scenarios from logged swarm failures to a **local** Ollama model. It writes one JSONL record per request. It is a small, repeatable smoke check. It is not a benchmark.

```
OLLAMA_HOST=http://127.0.0.1:11434 \
npx tsx tools/decision-eval.ts <local-model> --out runs/eval-<date>.jsonl \
  [--samples 1..3] [--scenario <name>]... [--num-predict 128..2048] [--timeout-ms 1000..120000]
```

Defaults: 1 sample, all 6 scenarios (6 requests), `num_predict` 1024 (same as production), 120 s timeout per request.

## Safety bounds (all checked before any network call)

- **Request cap:** samples × selected scenarios must be ≤ 12 `/api/chat` requests. For example, 3 samples × 6 scenarios = 18 is rejected, so with `--samples 3` you can select at most 4 scenarios. There is no warmup call. Beyond the chat requests, the only calls are metadata: `GET /api/tags` and `POST /api/show` beforehand, and one `GET /api/tags` afterwards. None of them generates text, loads the model, or pulls anything.
- **Host:** only `http://127.0.0.1[:port]` or `http://[::1][:port]`, written literally. The tool rejects `localhost`, other hosts, https, credentials, paths, queries, fragments, and numeric aliases (`2130706433`, `127.1`, `0x7f.1`). If `OLLAMA_HOST` is unset, it defaults to `http://127.0.0.1:11434`. Production's default `http://localhost:11434` is rejected here by design.
- **Local model only:** any model name containing `cloud` is refused, and so are names that aren't plain model references. The tool then calls `/api/show`. It fails closed if the response contains `remote_host` or `remote_model` (any value), contains an `error`, or lacks a `details` object.
- **No pulls.** The tool never calls `/api/pull`, and a missing model fails at `/api/tags`.
- **Exact identity:** `/api/tags` must list exactly one entry whose name equals the requested model after making Ollama's implicit `:latest` explicit (`qwen3` → `qwen3:latest`; a `:` before the last `/` is a registry port, not a tag). Matching is case-sensitive with no prefix matching, so use the exact name from `ollama list`. The entry must carry a sha256 digest (64 lowercase hex, optional `sha256:` prefix). Malformed bodies or entries, no match, multiple matches, a `model` field that disagrees with `name`, or remote fields all abort before any chat request.
- **Transport:** every fetch uses `redirect: "error"` and `AbortSignal.timeout(timeoutMs)`. Bodies over 1 MB are not parsed.
- **Unload:** every chat request sends `keep_alive: 0`, so an interrupted run never leaves the model loaded. As a result, every request includes a cold load. Use `load_duration_ns` and `eval_duration_ns` rather than `elapsed_ms` to read generation speed.
- **Output:** `--out` must be a new `.jsonl` path. It is opened with `wx` (O_CREAT|O_EXCL), so an existing file or symlink is refused.
- Model output is parsed as data only. Nothing is executed, and no Minecraft server, bot, or world is involved.

## JSONL records

1. `run`: model, `model_canonical_tag`, `model_digest` (`sha256:…` from `/api/tags`), `/api/show` `details`, host, samples, scenarios, `scenario_predicates` (per scenario: predicate `id`, `version`, `rule`, and `why`), planned requests and cap, timeout, exact request options (`think`, `format`, `keep_alive`, `options`), and the full system prompt.
2. `request` (one per call): scenario, `predicate_id`, `predicate_version`, sample, `user_prompt`, `elapsed_ms`, `transport` (`ok`/`timeout`/`transport_error`/`http_error`/`bad_body`), then for `ok`:
   - `content` (final answer) and `reasoning` (`message.thinking`), stored separately. Reasoning is never parsed for the decision.
   - `done_reason`, `eval_count`, `prompt_eval_count`, `total_duration_ns`, `load_duration_ns`, `prompt_eval_duration_ns`, `eval_duration_ns`
   - `answer_status`: `empty` (no content after stripping `<think>` and code fences, e.g. a reasoning-only reply), `malformed` (no complete JSON object, JSON that fails to parse, not an object, no non-empty string `action`, or non-object `params`), or `valid`
   - `budget_exhausted`: `done_reason == "length"` or `eval_count >= num_predict`. This is tracked independently of `answer_status`.
   - `scenario_accepts`: the scenario predicate on a valid decision (`null` if not valid)
   - `counted_success`: true only if the answer is valid, `done_reason == "stop"`, the budget is not exhausted, **and** the predicate accepts. Valid JSON that hit the budget is never counted.
3. `summary`: raw per-scenario counts and `model_identity_end`: `status` (`unchanged`/`changed`/`unknown`), the `end` identity (or `null`), any `error`, and `identity_snapshots_match`. That flag is true only for `unchanged`. A run whose identity is `changed` or `unknown` must not be reported as reproducible. If the run fails (for example, `/api/tags` or `/api/show` refuses), the last record is `aborted` instead, and no end check is made.

## Scenario predicates

Every scenario records a predicate `id` and integer `version`. Bump the version whenever the verdicts change. Fixture state text is never edited with a predicate revision, so earlier raw responses can be honestly re-scored. Do not compare counts across predicate versions.

`low-health-under-attack` is `low-health-under-attack/flee-only` v2 (`src/eval/scenario-predicates.ts`). The fixture has 6/20 HP, three zombies at 4/6/8 blocks, night, and no food. v1 accepted `attack`, `eat`, `neural_combat`, and `go_to` without any checks. v2 accepts only `flee` with params absent or `{}`. Reasons:

- `flee` is in `FORGE_CONFIG.allowedActions`, the prompt advertises it as `flee {}`, and production `executeAction("flee")` runs `flee()`. That handler escapes away from the nearest hostile toward standable, lava-checked spots and ignores params.
- Rejected: `attack` (melee against 3 zombies at 6 HP), `neural_combat` (not a Forge action or skill), `eat` (no food carried), `go_to` (arbitrary coordinates, not threat-aware), mining, and all other actions. Aliases such as `flee_to_safety`, and `flee` with non-empty params, are rejected because the eval scores verbatim.

"Accepted" means the most defensible action the code supports. It does not mean demonstrated survival, because `flee()` can still fail to find a path. The other five scenarios are `<name>/inline` v1, unchanged.

The JSON scanner tracks string and escape state, so braces inside string values do not end the object early.

## Interpreting results

There are at most 3 samples per scenario, sampled at temperature 0.8. Report raw counts (`counted 2/3`) together with the model, date, and JSONL path. Do not present them as win rates or model rankings. A run with any `budget_exhausted`, `empty`, or transport errors tells you about configuration (budget, think mode, timeout) before it tells you anything about decision quality.

## Divergence from production (`queryStrategic` in `src/llm/index.ts`)

Matched: system prompt builder, user-turn wording (no memory section), `temperature` 0.8, `repeat_penalty` 1.15, `format: "json"`, default `num_predict` 1024, and `think` policy (`"low"` for `gpt-oss*`, otherwise `false`). A unit test reads `src/llm/index.ts` and fails if production `thinkFor()` changes without updating the mirror.

Intentional differences:

- No recent-message history or memory context is included. Scenarios are single-turn.
- Raw `fetch` is used instead of the `ollama` client, so the tool can enforce redirect refusal and timeouts.
- `keep_alive: 0` is sent on every request. Production uses the server default.
- `num_predict` is adjustable (128–2048) for budget experiments.
- The parser is stricter. Production `extractJSON()` repairs truncated JSON and normalizes action aliases. Here, truncated output is `malformed` and actions are scored verbatim. As a result, the eval can score a response lower than production would act on it.

## Workflow

1. Run the unit tests (`npm test -- src/eval/decision-metrics.test.ts src/eval/scenario-predicates.test.ts`). They mock every response and use no network.
2. Do a bounded CLI smoke run: `--scenario low-health-under-attack` with the default single sample (1 request).
3. Only after that, the operator performs the real local GPU run with explicit flags and keeps the JSONL.

Local-model preflight also requires `details.format=gguf`, not merely an arbitrary details object. This deliberately rejects unknown formats.

## Validation snapshot (2026-11-14)

All 1,109 automated tests, typecheck, build and scoped lint passed. Two actual local `gpt-oss:20b` requests used the existing strategic prompt and 1,024-token budget: `low-health-under-attack` and `ore-backlog-should-smelt`. Both returned valid final JSON with `done_reason=stop`, respectively 46 and 44 evaluated tokens, and both scenario predicates as they stood then accepted them. These are pipeline smoke checks, not a model ranking or proof of good play. That low-health result was scored under predicate v1, which accepted `attack`, and the model chose `attack` despite multiple zombies. Under v2 the same decision would be rejected. Predicate acceptance must not be described as demonstrated survival. Neither decision was executed in a Minecraft world. These runs predate digest recording.

## Limits of the identity snapshot

The digest is the one `/api/tags` lists at two moments, start and end. It does not cryptographically pin each `/api/chat` request. Chat requests name the model by tag, and Ollama resolves that tag again on each request. A retag that happens and is undone between the two snapshots, or a race with a concurrent `ollama pull`/`cp`/`create`, would go undetected. The digest is Ollama's manifest digest as reported by the server. It is not an independent hash of the weight files computed by this tool. Treat `unchanged` as "no change observed," not as proof. For a formal comparison, also freeze the model store (no concurrent pulls) for the duration of the run. Cold load time is separated from generation time.

### Predicate/identity validation (2026-11-14)

All 1,121 tests and TypeScript passed. A metadata-only live check resolved `gpt-oss:20b` to `sha256:17052f91a42e97930aa6e28a6c6c06a983e6a58dbb00434885a0cf5313e376f7` at both endpoints. Replaying the preserved earlier `attack` response changed acceptance from v1 true to v2 false without overwriting the historical artifact or running new inference. `identity_snapshots_match` states only what the two metadata observations prove; it is not a claim of pinned requests or complete reproducibility.
