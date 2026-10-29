# Research harness implementation and release checks

Implemented on 2026-10-29 from `codex/pi-harness` at `a25ac92`, after fetching the upstream changes that merged `main` at `da39fb9`. This implements the application/server portions of [the plan](agent-harness-plan.md). The live release gates below remain open; this is not a claim that all core-harness acceptance gates have passed.

## User-visible behavior

- “What are these citations 11,12,26” reads the active paper's extracted bibliography across pages. It returns every requested label, anchored entries, or explicit missing, scanned, incomplete, or ambiguous statuses. This path makes no model request and works when no model is available.
- Numbered paper references stay numbered. Saved answer-local `S1`, `N2`, `N4`, and `C1` mappings and new evidence handles render as descriptive citation previews. Code and math are not rewritten as citations.
- Previews retain the exact saved excerpt, provenance, revision, and locator. Legacy note paths remain usable and explicitly unchecked. New note snapshots check the current file, resolve unique exact-hash renames after reindexing, and keep the snapshot when the file is changed, missing, or ambiguous. PDF actions select the correct source and page, including cross-paper navigation.
- Runs expose ordered activity, provisional text, Stop, Retry, Continue investigation, and context pin/exclude controls. A rejected or failed request does not lose the saved question. Reconnecting consumes saved events without starting another model run.
- The current source position, last open question, and saved next step support resumption. Explicit research records preserve the distinction between user reasoning, source statements, AI proposals, and provisional assessments.
- AI note changes use the existing promotion preview/apply/undo boundary. The model has no apply, shell, arbitrary filesystem, or general HTTP tool.

## Execution and evidence

`server/agent-api.mjs` connects the existing domain services to `AgentHarness`. The harness freezes the task, model selection, source revision, workspace source allowlist, vault scope, budgets, and policy versions. Question creation and idempotency checks are atomic. Conflicting reuse of a key returns a conflict; continuation creates a new run while retaining the original question identity.

The bounded runtime selects a small relevant subset from typed Zod tools. It validates arguments before execution, rejects unregistered or repeated calls, allows one malformed-call repair, bounds tool results, and compacts complete assistant/tool-result groups. Evidence that was discovered or evicted is not accepted as evidence loaded into the final model context. Final artifacts remain partial if mechanical citation or quotation validation fails. These checks establish citation/quotation integrity, not mathematical truth or sentence-level source support.

Quick runs default to three model calls, six tool executions, and 90 seconds. Investigate/connect allow eight calls, twenty tools, and 240 seconds; proof/assumptions allow 300 seconds. Hard limits apply to caller overrides. Initial retrieval and the existing Auto local model router consume the same run budgets. Under a one-call budget, Auto local selects the default local model directly and reserves that call for the answer.

Source reads are limited to papers registered in the current workspace. Vault reads retain containment, freshness, and bounded-file checks. Search candidates are run-scoped discovery records; passage reads register evidence. Cross-page source exclusions check every covered page. Saved intake context from the upstream selected-region workflow remains available and explicitly unverified.

The tool catalog includes source search/read/outline/references, local library metadata search/get, reference resolution, vault passage search/read/outline/links/resolve-link, workspace context, attributed history/state reads, and proposal creation. Local library matches are metadata matches; they do not imply that an attachment or cited claim was read.

## Providers and Pi

Ollama and llama.cpp adapters support structured tool messages, bounded context/output, streaming, usage, and cancellation. The OpenAI adapter is available only through explicit cloud selection and currently delivers a completed response rather than streaming tokens. There is no cloud fallback. Explicitly selected Ollama cloud models are labeled cloud even though their transport uses the local gateway.

Pi's actual embedded `Agent` candidate is implemented behind an endpoint-specific adoption gate. Exact dependencies are `@earendil-works/pi-agent-core@1.4.0` and `@earendil-works/pi-ai@1.4.0`. The candidate uses Margin's provider adapters and narrow Zod-validated tools; it does not load the Pi coding-agent CLI. The application uses the bounded Margin runtime while the live gate is closed. See [the Pi audit](pi-runtime-audit.md) for package, telemetry, probe, and compatibility details.

The llama.cpp adapter and capability probes are programmatic interfaces with contract tests. The existing application selector continues to expose Ollama and OpenAI; a llama.cpp settings/selector rollout is not enabled here.

## Storage, export, and rollback

SQLite schema version 2 adds a migration ledger and native run/event/final-artifact tables while retaining existing JSON records. Existing databases receive a consistent `VACUUM INTO` backup before migration. Migration is transactional, is not repeated on restart, and rejects a future schema version. No private vault migration is performed.

Interrupted runs retain available partial text, evidence, and normalized tool transcripts and are marked recoverable. Completed writes are never replayed. Transcripts retain user-visible messages and tool records; private reasoning is not required or saved.

JSON export version 2 includes runs, events, tools, evidence snapshots and links, reference entries, attributed research state, and readable named-citation Markdown. PDFs remain in their existing storage locations.

The notebook offers two separate explicit data controls:

- Clear diagnostic details removes terminal-run transcripts, tool records, and intermediate events. It preserves saved input/answers/evidence and a terminal replay event with its original sequence number.
- Delete notebook history removes the selected session's entries, runs, and research records, and clears its derived next-step/takeaway. It rejects active runs. The reader session, workspace, source records, and files remain. Evidence referenced by surviving records is retained. This control does not erase database backups or rewrite already applied vault notes.

Settings exposes `agentHarness`, `citationRendering`, and `sourceExpansion` independently. Disable `agentHarness` to use the retained single-call tutor path for diagnosis. Citation rendering and stored evidence remain independently readable. For binary rollback across the database migration, stop the app and restore the pre-migration backup rather than opening schema 2 with an older binary.

## Validation and acceptance status

The pristine fetched baseline passed 46 tests and the production build. The final suite passes **130/130 tests**, and `npm run build` succeeds. The implementation adds deterministic tests for bibliography coverage/extraction status, citation parsing and legacy mappings, exact quote checks, scoped retrieval/proposals, migration and restart, cancellation, idempotency, budget enforcement, transcript compaction, provider transports, actual embedded Pi orchestration with mocked transports, authenticated SSE, export, retention, and workspace boundaries.

A sanitized browser fixture was used to check the original reference question without a model, named legacy note previews, direct source-page navigation, notebook layout, activity, and resumption controls. It contains invented bibliography entries and one synthetic note, not private vault content.

The following gates require a separate explicit live evaluation before declaring the full core harness released:

1. Run the selected-model tool probe on an available Ollama endpoint, and repeat against a configured llama.cpp endpoint. No local Ollama server was listening during implementation. Mock transport success is not a live capability result.
2. Verify endpoint cancellation and local-only network/telemetry behavior. The dependency audit and injected-fetch tests do not establish the behavior of an actual model server.
3. Test the original real paper's extraction and bibliography. Scanned PDFs and suspicious two-column layouts currently report uncertainty; OCR/vision recovery is not enabled.
4. Install/run the Obsidian bridge and verify actual heading, duplicate-heading, block, and renamed-note navigation. URI construction and browser preview checks do not prove cross-app positioning.
5. Review at least 30 representative live research tasks for source support, mathematical qualifications, and task completion. Record failures and p50/p95 latency, first progress, token usage, tool calls, and memory pressure. No live success rate or performance threshold is claimed here.
6. Exercise the minimum supported Node 22.19.0 runtime. Development validation used Node 26.0.0.

Attributed session-summary persistence is available to explicit service callers and history retrieval, with links to original artifacts; automatic summary generation and a full inquiry-editing UI remain future work. Optional scholarly web, OCR/vision, mathematical computation, and MCP tools remain disabled. The current mechanical validator does not provide automated evidence-support or theorem-correctness adjudication.
