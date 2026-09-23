# Bounded local Ollama adapter

Status: implemented and tested against ephemeral local fake HTTP servers. No real
model call, GPU workload, or Minecraft model episode has been run with this adapter.

`tools/pilot/ollama_adapter.py` exposes `call_ollama` for a trusted coordinator.
It implements the [Ollama chat API](https://docs.ollama.com/api/chat) with a
non-streaming JSON response, thinking disabled, and explicit generation options.
The host is fixed to `127.0.0.1`; callers must supply a port and exact model name.
There is no default port, endpoint discovery, proxy inheritance, redirect following,
automatic retry, or game action execution.

## Contract

Pass plain system/user/assistant messages, a trusted token count for the entire
rendered prompt (including chat framing), and an `InferenceBudget` created at the
begun episode boundary. The ledger reserves a call and its output allowance before
dispatch. The adapter requests at most 256 output tokens and an 8,448-token context
(8,192 input plus 256 output). These settings still need qualification with the
pinned runtime and tokenizer before inference.

The effective response deadline is the lesser of the ledger allowance and the
caller's `timeout_cap`, which must be positive and at most 20 seconds. It includes
worker startup and response parsing. Cancellation and late completion suppress
content, including cancellation observed during final cleanup. The worker is
terminated, then killed if necessary; cleanup uncertainty is explicit. Cleanup
has a separate bounded wait and may extend total function duration past the
response deadline. Operating-system process creation itself is synchronous and
cannot be interrupted by this function; a late return is rejected.

Requests and response bodies are limited to 64 KiB; assistant content is limited
to 4 KiB. Responses must have the requested model name, completed generation with
stop reason, assistant role, and JSON-object content. Duplicate JSON keys,
nonfinite numbers, thinking/tool/image output, malformed usage and excessive
usage are rejected. A supplied provider input count must match the trusted count;
a mismatch could indicate truncation or a tokenizer/template disagreement. Missing
input usage remains explicitly unavailable. Missing output usage keeps the full
reserved output allowance. Failed and cancelled calls also keep that allowance;
only completed, on-time calls with valid known output usage refund unused tokens.

A completed result returns content, available provider counts, request/response
hashes and worker cleanup status. Failure returns no content or raw provider error.
Call records remain on the supplied budget ledger. Hashes are not a substitute for
a future protected trial transcript: preserving raw usage and prompt/response
artifacts, including rejected responses, still needs coordinator integration.

## Reproduce the transport tests

From the repository root, on Linux/WSL with Python 3:

```sh
python3 -m unittest tools.pilot.test_ollama_adapter
```

The 12 tests use ephemeral loopback ports and cover ordinary/chunked HTTP,
missing usage, malformed/oversized/mismatched responses, redirects, stalled and
trickling responses, cancellation before dispatch and during transport/cleanup,
exhausted budgets, invalid requests, delayed startup and spawn failure. Timeout
and cancellation tests verify the worker is reaped; stalled-server tests also
observe the client socket close. No running Ollama service is contacted.

## Remaining integration

A loopback address and matching response name do not attest loaded model weights,
runtime configuration or tokenization. Closing the client socket does not establish
that a real backend stops computing. Qualify backend cancellation and isolation
before using latency or GPU cost measurements. The caller must validate returned
JSON through the existing action broker; JSON-object syntax alone is not action
validation.

Next, connect this transport to the protected coordinator with fake responses,
align the full lifecycle deadlines with the proposed 120-second episode, preserve
transcripts, and verify that no cancelled/late output can start an action. Then
freeze model/runtime/tokenizer/prompt identities and arrange the logged GPU window
specified by the [first model pilot protocol](first-model-pilot-protocol.md).
