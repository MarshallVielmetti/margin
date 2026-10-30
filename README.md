# Margin

A local research reading desk for Zotero PDFs, Obsidian notes, and source-grounded tutoring through local or configured cloud models.

## Run

Use Node.js 22.19.0 or newer.

```sh
npm install
cp .env.example .env # only for a new installation; preserve an existing .env
npm run build
npm start
```

Set `RESEARCH_VAULT` to the absolute vault directory.
Open [Margin](http://127.0.0.1:4318).
For development, use `npm run dev`.

## Open an existing Zotero PDF

Keep Zotero open with Better BibTeX enabled.
Reload the updated Margin Research Bridge plugin in Obsidian, open a literature note, and run **Margin Research Bridge: Open literature note in Margin**.
The plugin’s URL setting must match the running Margin port.
You can also choose **Add source → Zotero / literature note** inside Margin.

Margin resolves frontmatter citation keys, `@citekey` filenames, and Zotero links through [Better BibTeX’s local JSON-RPC API](https://retorque.re/zotero-better-bibtex/exporting/json-rpc/index.html).
It reads the PDF in place and stores extracted page text, provenance, and attachment identity locally.
No upload or duplicate PDF copy is needed.
Multiple attachments require selection; missing files show a recovery message.
For linked attachments outside Zotero storage, configure their containing folder in Settings.
Scanned PDFs can be displayed and parsed locally with the optional PaddleOCR intake engine.
Reading-note snapshots retain separate provenance and old sessions are preserved.

## Structured PDF reading and intake

Hover a paragraph or equation in the PDF and click to select its region.
Use **Expand** to select an enclosing definition, theorem, or page, then **Add note**, **Ask about this**, or **Context**.
Use Cmd/Ctrl-click or Shift-click to add or remove regions, or turn on **Multi-select** so ordinary clicks toggle selection.
Selections can span pages and are saved together with a note or question.
Aligned mathematical rows, including subscripts and equation numbers, are grouped into a selectable equation block; Alt-click drills into its rows.
The region menu offers the same selection through the keyboard.
Notes retain page coordinates and extraction revision; earlier region anchors remain usable after a different extraction engine runs.

New PDFs get native text-and-geometry intake automatically.
Open **Intake & context** in the reader to choose PaddleOCR or an installed local chat model, then **Run / resume intake**.
Default intake finds related vault passages and region candidates without generating AI summaries.
A local model additionally produces a summary, assumptions, questions, and proposed note/region connections for every nonempty chunk.
Intake never selects a cloud model or modifies the vault.

Chunk bundles are durable local records with note snapshots, hashes, model identity, and exact quotations supporting proposed connections.
Completed chunks are reused on retry; Stop preserves completed work.
Changed vault contents mark bundles stale and exclude them from tutor requests until intake is rerun.
The tutor automatically receives current context for the selected region and its enclosing block.
Use the download button beside **Intake & context** to export the full chunk JSON for another local agent or LLM.

PaddleOCR is optional and uses its own locked uv environment:

```sh
uv sync --project extraction --extra paddle --python 3.12 --locked
```

The PaddleOCR selector can also set up this environment on first use, if `uv` is on the server's PATH.
Initial extraction downloads official model weights; subsequent inference runs locally on CPU.
Native grouping and definition/theorem boundaries are heuristic, and recognized equations and inferred relationships require source checking.
See [the intake contracts and validation notes](docs/structured-pdf-intake.md).

## Living knowledge

Open the library icon beside **Notebook** to inspect persistent knowledge preparation separately from your literature note.
Every indexed note gets a lightweight manifest, and explicit note/MOC routes coexist with global discovery.
After PDF region intake, build a model-free extraction map or explicitly select a local model for meaningful unit cards, a coverage-aware overview, and bounded comparison proposals.
Preparation never changes human prose or curated links.
Corrections and rejected proposals persist across chats; acceptance remains separate from mathematical verification.

The tutor can discover preparation from earlier chats and other workspaces in the same vault/library, then inspect actual source and note passages for citations.
Stale generated guidance is withheld from agent loading while current direct note retrieval remains available.
Background preparation is off by default and has its own local-model setting and budgets.
The inspector offers cancellation, coverage and provenance details, review controls, and a Markdown snapshot export.
See [storage, API, validation, and limits](docs/living-knowledge-implementation.md).

## Research tutor models

Start Ollama; Margin discovers installed models and their capabilities, including MLX models.
Choose a model directly above the tutor’s prompt box, or in **Settings**.
The default is `qwen3.8:27b-mlx`; your explicit selection is saved across sessions and restarts.
Use **Model options → Refresh available models** after installing another model.
Embedding models remain separate in Settings.
No model is downloaded by Margin.

**Auto · local** appears when both `qwen3.8:27b-mlx` and `qwen3.6:35b-a3b` are installed as local chat models.
It uses a bounded, structured classification call to the installed Qwen 3.6 MoE model to route routine definitions, recall, and summaries to Qwen 3.6, and proofs, derivations, or deeper research questions to Qwen 3.8.
This reuses a general-purpose local model; it is not a separately trained routing model or a calibrated quality guarantee.
The classification step adds a local inference call (and can load Qwen 3.6 when it is cold).
Invalid routing output or a 20-second router timeout selects Qwen 3.8 for that question.
Answers record the actual responding model, routing reason, router model, and whether fallback occurred.
Auto routing stays local and never selects a cloud model.

The **Tutor** mode answers questions directly; optional commands offer recall practice, assumption checks, connections, proof hints, and investigation. Synthesis has its own document surface.
The tutor receives the selected source page, selected passage, recent reasoning, research question, and retrieved vault passages.
Local choices use the [Ollama chat API](https://docs.ollama.com/api/chat) through loopback HTTP.
The picker groups local models separately from cloud models configured in Ollama and OpenAI.
To enable OpenAI, set `OPENAI_API_KEY` in `.env`, restart Margin, and refresh models.
Margin discovers available OpenAI text models through the [models endpoint](https://developers.openai.com/api/reference/resources/models/methods/list).
Ollama cloud models appear when registered in the local Ollama model list and use Ollama’s own cloud authentication.
Choosing a cloud model explicitly sends the tutor context to that provider; the prompt box shows the destination.
API keys stay on the server and are never returned to the browser.
Provider failures do not cause an automatic switch to another provider.
Model responses retain model identity, evidence IDs, and an unverified AI label.
Citation labels make evidence inspectable; they do not establish mathematical correctness.
Browser dictation is separate from Ollama and may use the browser’s speech service; macOS dictation can be used in the text field instead.

Build the semantic index in Settings to embed vault sections locally.
Unchanged chunks are reused on subsequent builds, and lexical matching plus explicit wiki-links remain available without embeddings.
Refresh the vault index after external edits and rebuild the semantic index when its status is stale.
Deleted or changed indexed chunks are excluded from semantic retrieval.
Index sizes depend on the connected vault; Settings reports current coverage.

## Chat from Obsidian

The [Margin Research Bridge](obsidian-bridge/README.md) adds **Chat with Margin** to the command palette. From a literature note, open a terminal-style pane beside the note with its Zotero PDF, current note context, persistent conversation, model selection, agent activity, and Stop/Reconnect controls. The note is saved and refreshed before each turn; the PDF remains available through bounded source tools. Install all three bridge files and reload the plugin, and restart Margin after updating the server.

## Working notebook

**Thoughts** preserves personal annotations, source selections, original wording, and later revisions. **Tutor** pairs questions with answers and keeps evidence and activity with their turn. **Synthesis** is the editable literature note: Markdown/LaTeX, wikilinks, a rendered reading view, dictation, local recovery, export, and revision history.

Tab cycles modes from the plain writing areas; Shift+Tab reverses. Escape followed by Tab leaves the editor. Turn cycling off in the notebook inspector for ordinary Tab navigation. Synthesis uses Tab for list indentation and table cells before cycling. Ctrl+Alt+1/2/3 selects a mode; Cmd/Ctrl+J focuses writing; Cmd/Ctrl+Enter captures a thought or asks a question. Each mode retains its draft, cursor, and scroll position. A draft's source anchor freezes when writing or dictation starts.

An associated literature note opens from its **current vault file**, with frontmatter, headings, math, callouts, and links intact. Use **Note options → Connection & relink** to connect or create a note and enable syncing once. The default remains local editing until syncing is enabled. Without a connected vault, write normally and export Markdown.

**Organize new thoughts** proposes focused changes beside their destination, using the original annotations and inspected passages. Keep, Edit, or Dismiss each proposal; related changes can be kept by section. **Use in note** brings a Tutor explanation or selected answer passage into this review. Accepted changes retain authorship, source links, input revisions, and an unverified label. Acceptance does not assert understanding or mathematical correctness. Pending fragments retain their original wording. Dismissed material stays dismissed until edited or explicitly reconsidered.

Choose the synthesis model in **Settings → Synthesis model**. The picker has Local · Ollama, Cloud · Ollama, and Cloud · OpenAI groups, independently of Tutor. The selection is saved across papers and restarts; the default remains `qwen3.8:27b-q4_K_M`. Synthesis requires structured output support; Tutor’s Auto · local routing remains a separate option. An unavailable selection stays visible, with no provider substitution, and pending downloads are discovered on the next organization attempt.

Manual **Organize new thoughts** and **Use in note** use this synthesis selection. Cloud actions show their destination before sending the note, selected thoughts, and inspected passages. Optional **Organize as I read** uses the selected local model and pauses when a cloud synthesis model is selected. A cloud Tutor selection does not change synthesis or enable background cloud requests. Missing models and cancelled runs leave writing and captures intact.

Save status distinguishes local saves, vault sync, offline recovery, and conflicts. Vault synchronization merges independent changes and exposes overlapping blocks for resolution. Reload the updated bridge plugin to coordinate open Obsidian buffers; unsaved buffers pause the write. Without the bridge, select the closed-note option and keep that note closed in Obsidian. Renamed/deleted files require relink or explicit restore. Undo retains unrelated newer edits where a safe inverse exists.

The notebook inspector holds context controls, keyboard preferences, and session data tools. Session-history deletion preserves shared documents, revision history, and suggestion provenance. Creating concept, theorem, and MOC notes remains a separate contextual promotion action.

See [implementation, API contracts, and validation](docs/working-notebook-implementation.md).

## Storage and boundaries

Session history and settings live in `.data/research.sqlite` unless `RESEARCH_DATA_DIR` is set.
Zotero PDFs remain in Zotero storage; old uploaded sources, if any, remain in `.data/sources`.
Back up both the Margin data directory and Zotero library.
JSON export includes extracted text, history, literature documents, all document/annotation revisions, suggestions, contributions, synthesis runs, and notebook state; it excludes PDF bytes.
Margin binds to loopback and protects mutation endpoints with a per-process token and same-origin checks.
Vault imports reject traversal and symlink escapes.
PDF access is restricted to configured attachment folders and validates file identity against extracted text.

## Validation

```sh
npm test
npm run build
```

The automated suite covers persistence, provenance, source selection, model routing, notebook API contracts, frozen multi-region drafts, concurrent edits, merge conflicts, safe undo, incremental suggestions, deduplication, cancellation, and bridge buffer coordination. Tests write only to disposable vaults. Browser acceptance checks cover mode switching, page anchoring, paired tutoring, suggestion acceptance, connected-note syncing, reload recovery, and a narrow-screen reading desk.

The updated Obsidian bridge must be installed/reloaded before buffer coordination is available. Real microphone dictation and concurrent editing in a running Obsidian installation still require live acceptance testing; automated bridge tests use editor stubs.

Core modules: `server/zotero.mjs`, `server/ollama.mjs`, `server/retrieval.mjs`, `server/tutor.mjs`, `server/app.mjs`, and `obsidian-bridge/main.js`.

## Research harness

The notebook now saves each research request as a durable run. It can identify
numbered references from the active source's full bibliography without a model,
show named inline citations with exact evidence previews, and stream research
activity with Stop and Continue controls. The existing prompt model selector
continues to select the provider for each run.

The default runtime uses bounded Ollama/OpenAI adapters. A second local
llama.cpp adapter and an embedded Pi candidate are available for explicit
integration tests; Pi adoption stays gated until the selected local endpoint
passes the checks in [the runtime audit](docs/pi-runtime-audit.md).

See [implementation and validation](docs/agent-harness-implementation.md) for the
API contracts, feature flags, migration/rollback procedure, tested behavior,
and remaining live acceptance checks. Existing saved artifacts remain readable.
