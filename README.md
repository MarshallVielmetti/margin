# Margin

A local research reading desk for Zotero PDFs, Obsidian notes, and source-grounded tutoring through local or configured cloud models.

## Run

Use Node.js 22.13 or newer.

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
Scanned PDFs can be displayed, but OCR is not included.
Reading-note snapshots retain separate provenance and old sessions are preserved.

## Research tutor models

Start Ollama; Margin discovers installed models and their capabilities, including MLX models.
Choose a model directly above the tutor’s prompt box, or in **Settings**.
The default is `qwen3.8:27b-mlx`; your explicit selection is saved across sessions and restarts.
Use the refresh button beside the model picker after installing another model.
Embedding models remain separate in Settings.
No model is downloaded by Margin.

**Auto · local** appears when both `qwen3.8:27b-mlx` and `qwen3.6:35b-a3b` are installed as local chat models.
It uses a bounded, structured classification call to the installed Qwen 3.6 MoE model to route routine definitions, recall, and summaries to Qwen 3.6, and proofs, derivations, or deeper research questions to Qwen 3.8.
This reuses a general-purpose local model; it is not a separately trained routing model or a calibrated quality guarantee.
The classification step adds a local inference call (and can load Qwen 3.6 when it is cold).
Invalid routing output or a 20-second router timeout selects Qwen 3.8 for that question.
Answers record the actual responding model, routing reason, router model, and whether fallback occurred.
Auto routing stays local and never selects a cloud model.

The **Research tutor** offers discussion, recall feedback, assumption checks, related-concept comparison, proof hints, synthesis checkpoints, and refinement of your own explanation.
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
The completed initial index contains 4,430 passages from 2,407 notes.

AI edits remain proposed working-notebook entries.
Permanent note promotion still uses an explicit preview, review, apply, and undo flow with conflict detection and backups.
Reading prompts at the bottom of the notebook remain model-free reflection prompts.

## Storage and boundaries

Session history and settings live in `.data/research.sqlite` unless `RESEARCH_DATA_DIR` is set.
Zotero PDFs remain in Zotero storage; old uploaded sources, if any, remain in `.data/sources`.
Back up both the Margin data directory and Zotero library.
JSON export includes extracted text and history, not PDF bytes.
Margin binds to loopback and protects mutation endpoints with a per-process token and same-origin checks.
Vault imports reject traversal and symlink escapes.
PDF access is restricted to configured attachment folders and validates file identity against extracted text.

## Validation

```sh
npm test
npm run build
```

30 automated tests cover the local workflow, provenance, promotion conflicts/undo, vault parsing, model discovery and selection, local/cloud request routing, automatic local classification and fallback, Zotero attachment resolution, escaped paths, semantic cache reuse, and stale-chunk exclusion.
Live validation opened the existing 10-page Tsitsiklis PDF, retrieved a cited `gemma4:12b` answer, and built the full semantic index.
Browser verification confirmed the note deep link opens the PDF and exposes the local tutor controls.
The updated Obsidian plugin must be reloaded before its new command appears.

Core modules: `server/zotero.mjs`, `server/ollama.mjs`, `server/retrieval.mjs`, `server/tutor.mjs`, `server/app.mjs`, and `obsidian-bridge/main.js`.
