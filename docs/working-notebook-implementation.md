# Working notebook implementation

Implemented 2026-10-30 from [the redesign plan](working-notebook-redesign-plan.md).

## Reading flow

`Notebook` is a shell for `ThoughtsPane`, `TutorPane`, and `SynthesisPane`. All three remain mounted while modes change. Thoughts is the default for a new source; mode, independent drafts/anchors, editor selections, active question, scroll positions, and the Tab preference persist locally and through the notebook-state API. A new browser client can resume the most recent source state, then keeps an independent buffer.

Thoughts contains personal captures and optional contextual metadata. Editing retains earlier wording in `annotationRevision`; the original capture remains revision zero. A capture key prevents duplicate submissions after a connection failure. Legacy questions stay questions and legacy AI answers retain their authorship. Source anchors freeze on typing, composition, or dictation start, including all selected regions, geometry, and extraction revision.

Tutor pairs questions and answers using durable run IDs and falls back conservatively to chronological pairs for older entries. Source-extraction answers remain separate from AI explanations. Stop and recovery activity attach to the current turn. Detailed evidence, routing reasons, and diagnostic data are collapsed or in the inspector. The prompt model picker preserves Qwen 3.8 and explicit Auto · local routing. Synthesis has a separate, persisted provider/model picker in Settings with the same local/cloud provider groups. That global selection applies across papers; legacy per-document local-model metadata no longer overrides it.

Synthesis edits the full Markdown document, while reading view hides YAML and internal provenance comments. Existing properties, callouts, wikilinks, mathematics, repeated headings, and unrelated prose remain in the source. Native editor undo/redo handles direct writing; persisted revision history also provides safe document-level undo. A resizable divider and wider-note view support desktop reading; narrow screens select either Source or Notebook.

## Durable records and API

Shared literature documents are deliberately outside session-data deletion. There is no document-deletion action in this release; document history must not be deleted by clearing a reading session.

New notebook records use the existing extensible SQLite `records` schema, version 2; the notebook contracts have their own `schemaVersion: 1`. No destructive schema migration or legacy artifact reclassification runs on startup. Existing records and the normal database backup behavior are preserved.

- `literatureDocument`: vault identity, note path, stable paper/source associations, Markdown, current and synced revisions, synced content/hash, connection preferences, conflict state.
- `documentRevision`: parent revision, before/after Markdown, attribution, and timestamp. Accepted suggestions retain original input snapshots and inspected evidence.
- `annotationRevision`: retained earlier capture wording, source anchor, and assumptions.
- `synthesisSuggestion`: revision-scoped block range/fingerprint, operation, original inputs and input revision IDs, inspected evidence, model/run, and review state.
- `contribution`: input revisions considered, proposed, accepted, dismissed, held, or explicitly reconsidered.
- `synthesisRun`: model/provider, retry key, base document revision, status, inspected evidence IDs, and available-but-unread source inventory.
- `notebookState`: source and browser-client drafting state.
- `bridgeWrite`: short-lived, versioned editor-coordination requests and acknowledgements.

The logical paper identity uses the canonical vault plus note association, citation key, Zotero attachment/item identity, and source aliases. Concurrent imports recheck identity within the creation transaction. Ambiguous associations require relinking; independently created documents are not silently combined.

The global `POST /api/settings` contract accepts `synthesis: {provider, model}` and bootstrap returns `config.synthesis` with the selected model, destination, and availability. Invalid provider/model pairs are rejected before any settings persist. The old per-note organization-model control is replaced by the Settings picker.

Main endpoints:

| Endpoint | Contract |
| --- | --- |
| `GET /api/sources/:id/notebook` | Resume/create the paper document from the current vault note; return document, suggestions, revisions, pending material, latest run. |
| `GET /api/documents/:id` | Current versioned document view. |
| `PATCH /api/documents/:id` | Save `{expectedRevision, markdown}`; stale clients receive HTTP 409 with the current document. |
| `POST /api/documents/:id/connect` | One-time existing/new note association and explicit sync method/enablement. |
| `POST /api/documents/:id/preferences` | Automatic organization and sync enablement; provider/model selection is global in Settings. |
| `POST /api/documents/:id/sync` | Merge current vault changes and synchronize only when safe. |
| `POST /api/documents/:id/resolve` | Resolve conflicting blocks using the expected document revision and external file hash. |
| `POST /api/documents/:id/undo` | Safe inverse for a retained revision; reject overlapping newer changes. |
| `POST /api/documents/:id/organize` | Bounded asynchronous pass with a retry key and optional explicit input IDs/answer excerpt. |
| `POST /api/documents/:id/organize/cancel` | Stop generation while retaining all source captures. |
| `POST /api/documents/:id/suggestions/:suggestionId` | Inline accept/edit/dismiss with an expected revision. |
| `POST /api/documents/:id/accept-section` | Atomically accept related suggestions in one section; roll back if any target is unsafe. |
| `POST /api/documents/:id/reconsider` | Explicitly reconsider a dismissed/held/stale input revision. |
| `GET/PUT /api/sources/:id/notebook-state/:clientId` | Independent mode buffers; `?resume=1` optionally restores the latest source state for a new client. |
| `PATCH /api/artifacts/:id` | Version-checked annotation text/anchor/type editing, or optional learning status. |
| `GET /api/artifacts/:id/revisions` | Original and retained annotation wording. |
| `POST /api/bridge/poll`, `POST /api/bridge/writes/:id/ack` | Authenticated loopback coordination with the matching vault's bridge. |

All mutations retain the existing per-process token, host/origin guards, validation, and vault containment checks. Markdown export works without models. JSON export includes documents, both revision histories, suggestions, runs, contribution records, and notebook buffers. Session-history deletion does not own or delete the shared document and provenance; referenced evidence snapshots survive.

## Saving and synchronization

Typing immediately updates a browser recovery buffer and debounces a SQLite save by approximately one second. Server revisions commit independently of model and vault availability. The browser rebases non-overlapping edits from another Margin client; overlapping text opens recovery with both originals retained. Save status distinguishes Saving, Saved locally, Synced to Obsidian, Offline, and Conflict.

Sync compares the current vault file with the last synced Markdown. Line-scoped three-way merging preserves independent edits and carries exact conflicting ranges for inline resolution. A resolution rechecks the external file hash. Writes serialize per document and share an atomic, expected-hash writer with promotions. Successful sync refreshes the note index; changed passage hashes invalidate cached retrieval results.

The updated Obsidian bridge checks the actual editor buffer and expected file contents. Dirty buffers decline the write and stay editable. Clean buffers receive a versioned editor transaction; unopened files use `Vault.process`. Missing bridge acknowledgements retain the local revision and require reconciliation on retry. Without the bridge, syncing requires the explicit closed-note option. Filesystem checks cannot determine whether a separate Obsidian instance has an unsaved buffer.

Renamed/deleted targets are retained as local revisions and require explicit relink/restore. A write failure after the local commit does not discard the note. Undo merges a revision's inverse with current text and refuses unsafe overlap.

## Incremental organization

Organization reads at most eight new input revisions, sixty revision-scoped Markdown blocks, and a bounded set of exact source/previously inspected evidence passages. The prompt distinguishes statements, doubts, questions, commands, quotes, and fragments. It requires preservation of mathematical notation and qualifications and prohibits invented understanding. Mechanical validation checks target ranges, citations, input scope, competing summary headings, output size, and overlapping proposed targets; it does not prove claims correct.

Operations are small insertions or replacements. No whole-note replacement is accepted. Repeated headings are distinguished by revision/range/fingerprint rather than heading text alone. A response generated against changed document/input revisions becomes stale. At acceptance, an unchanged, uniquely matching block can be safely rebased; ambiguous or edited targets require reconsideration.

Each input revision is mapped to its suggestion or held with its original wording. Retry keys, one active pass per document, and contribution records prevent repeated processing. Dismissal persists until meaningful input changes or explicit reconsideration. Accepted text keeps readable source links and an AI-assisted/unverified attribution, as well as durable provenance snapshots. Acceptance never modifies learning or verification flags.

Optional organization coalesces completed captures after roughly two seconds with a ten-second throttle; continuous typing never triggers generation. It uses the independently configured synthesis model, defaulting to `qwen3.8:27b-q4_K_M`. Settings stores the validated provider/model pair and its cloud destination separately from Tutor. Manual organization and Tutor-to-note edits use this global selection. Specific local Ollama, Ollama cloud, and OpenAI models are supported; Tutor Auto routing remains separate because it is not a synthesis strategy. The selected unavailable model stays visible without substitution. Local discovery refreshes when a selected Ollama model is missing.

Cloud synthesis requires a visible, explicit action using the selected cloud destination. Automatic organization pauses while the synthesis model is cloud, with guards in both the UI and service. Selecting a cloud Tutor model does not affect synthesis. Every run freezes its own provider/model pair so a later Settings change cannot redirect a request already running.

## Validation and remaining live checks

Validation completed: `npm test` passed all 172 tests; `npm run build` and `git diff --check` passed.

Automated tests use disposable vaults and mocked model responses. They cover keyboard/editor helpers, anchor freezing, legacy pairing, import identity, preserved note structures, persistence, two-client revision guards, merges/conflicts, rename/delete recovery, safe undo, bridge buffers, versioned HTTP contracts, suggestions, deduplication, dismissal, cancellation, invalid operations, and local/cloud boundaries.

Browser acceptance uses a disposable three-page reading source and a temporary literature note. It verifies independent drafts through the three modes, page-1 anchoring after navigating to page 2, paired question/answer presentation, a focused cited proposal, explicit acceptance, connected-note syncing, mode/draft reload recovery, a 390-pixel single-pane layout, and conflict recovery between two open Margin clients. The browser checks confirmed a resolved note reached the temporary vault with an accurate Synced to Obsidian status. Source and Markdown remain usable without a live model. Synthesis Settings browser checks additionally verified all three provider groups, independent Tutor selection, persistence after reload, and a manually requested cloud synthesis pass using a mock provider; see `synthesis-model-settings.png`.

Live microphone/macOS dictation and concurrent editing inside a running Obsidian installation remain manual acceptance checks. Automated bridge tests exercise clean, dirty, and unopened editor states with stubs. No real vault content is changed during tests. The repository bridge must be copied/reloaded to activate the new contract; the implementation does not silently install a plugin.

The three-real-paper reading study in the plan still needs a researcher session. No improvements in reading time, acceptance rate, duplicate rate, or model quality are claimed from synthetic fixtures. Cross-paper synthesis, semantic concept merging, automatic MOC restructuring, and autonomous theorem-note generation remain outside this release.
