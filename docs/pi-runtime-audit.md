# Pi runtime candidate and local-only audit

Date: 2026-10-29

## Candidate package pair

The published runtime pair is pinned exactly in `package.json` and
`package-lock.json`:

| Package                         | Pin     | Manifest engine  | Compatibility evidence                                                        |
| ------------------------------- | ------- | ---------------- | ----------------------------------------------------------------------------- |
| `@earendil-works/pi-agent-core` | `1.4.0` | Node `>=22.19.0` | Its published manifest depends on `@earendil-works/pi-ai` at exactly `1.4.0`. |
| `@earendil-works/pi-ai`         | `1.4.0` | Node `>=22.19.0` | Same release as the agent core dependency.                                    |

Margin's declared Node floor is now `22.19.0`. Both upstream manifests are the
primary compatibility references:

- [Pi agent-core manifest](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json)
- [Pi AI manifest](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json)
- [Published pi-agent-core package](https://www.npmjs.com/package/%40earendil-works/pi-agent-core)
- [Published pi-ai package](https://www.npmjs.com/package/%40earendil-works/pi-ai)

The exact package pair was resolved into the lockfile with npm. The workspace
runtime used for this implementation is Node `26.0.0`; compatibility on the
minimum supported Node `22.19.0` was not exercised here.

## Telemetry and network review

`pi-ai@1.4.0` declares `@earendil-works/pi-telemetry@1.4.0` as a dependency.
Pi AI accepts telemetry as an explicit provider-request option and defaults to
its no-op telemetry context when none is provided. The telemetry package README
states that the package has no exporter or telemetry backend dependency. The
candidate passes no telemetry span, installs no exporter, and imports no Pi
coding-agent CLI. Margin's application path does not import or construct the Pi
candidate while the gate is closed; mock tests construct it directly to exercise
the integration.

The candidate uses Pi Agent for orchestration, but passes a custom stream
function backed by Margin's provider adapter. It does not load Pi model
discovery or provider catalogs. Ollama requests are constrained to an HTTP
loopback origin by Margin's existing endpoint validator. The llama.cpp adapter
independently enforces an HTTP loopback host and rejects credentials, query
strings, and fragments. OpenAI Responses is available only through the explicit
cloud provider selection; provider errors never trigger a cloud fallback. A
local-only run rejects OpenAI before making a request. Ollama cloud models are
reported as cloud when the application explicitly selects one; the local
Ollama gateway may relay those requests remotely.

The transport tests use injected fetch implementations and verify that local
adapters address only their configured loopback endpoints. They also verify
that local-only OpenAI selection is rejected before the injected fetch is
called. They do not prove network behavior of a live model server or the Pi
packages. No live telemetry or model-server request was made in this audit.

OpenAI function schemas use `strict: false` because the registered Zod schemas
include optional fields. The [official function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
requires every property to be required and every object to set
`additionalProperties: false` in strict mode; Margin validates arguments with
the original Zod schema immediately before tool execution. OpenAI tool names
are mapped to stable wire aliases and mapped back to the registered application
names on return.

## Adoption gate

`server/agent/pi-runtime.mjs` keeps Pi behind endpoint-specific evidence for:

1. Search, passage read, and cited answer on the selected local endpoint.
2. Streaming and cancellation reaching that endpoint.
3. Invalid tool-call rejection.
4. Context compaction and transcript reload.
5. No outbound telemetry or network request in local-only mode.

Each check must be true for the exact selected endpoint. Until that full gate
has evidence, `createPiRuntime()` delegates to Margin's bounded transport. The
embedded candidate is implemented with Pi `Agent`, narrow Zod-validated tools,
a custom provider stream adapter, and the bounded transcript compaction hook.
Mock tests execute search/read/cited-answer through the real Pi Agent, reject a
malformed call before execution, preserve evidence IDs for a retained tool
result, and remove evidence IDs when compaction removes its atomic tool pair.
An explicit `probeSelectedModel()` method can perform a bounded selected-model
search/read/cited-answer plus invalid-call check; it is not run automatically.
The tests do not contact a live endpoint, so Pi adoption remains gated.

## Remaining live checks

- Run the capability probe and search/read/answer smoke test against the
  selected Ollama model and server.
- Run `probeSelectedModel()` explicitly for the selected model to exercise the
  search/read/cited-answer and malformed-call checks.
- Repeat against a selected llama.cpp server when configured.
- Validate streaming tool-call behavior, cancellation, context handling, and
  local network isolation on those actual endpoints.
- Only after those checks, provide the evidence endpoint and completed check
  set to `evaluatePiAdoptionGate()`.
