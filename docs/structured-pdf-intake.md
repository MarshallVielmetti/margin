# Structured PDF regions and local intake

Margin keeps the original PDF as the reading surface and overlays regions from a versioned extraction.
A normalized box is `[left, top, right, bottom]` in the displayed page coordinate system, after PDF crop and rotation.
PDF.js renders the original at the current width; normalized boxes scale with that viewport and do not depend on device pixel ratio.

## Reading interaction

Hover previews the smallest region under the pointer, and clicking pins it.
Expand follows the region's `parentId`; numbered definition and theorem groups can contain paragraphs and displayed equations.
The region menu supports keyboard selection, and Alt-click can select an enclosing overlapping region.
Add note focuses the existing notebook capture field; Ask about this focuses the research tutor.
Saved annotations include `sourceId`, page, region ID, revision, normalized box, and the selected text.
A saved box remains selectable when a subsequent extraction produces different region IDs.
Immutable layout snapshots preserve the previous extraction and its chunk context.

## Extractors

`server/regions.mjs` extracts native PDF text and its geometry using the existing PDF.js dependency.
It groups text fragments into lines and paragraphs, separates column gutters, recognizes likely displayed equations, and proposes mathematical environment boundaries from headings.
Those semantic boundaries and native formula classifications are heuristic.
Native extraction does not reconstruct LaTeX or read scanned text.
Pages without text explicitly suggest PaddleOCR.

`server/paddle.mjs` invokes `extraction/paddle_extract.py` through `uv run --locked --project extraction --extra paddle` without a shell.
The Python worker uses local `PPStructureV3`, with formula recognition enabled and page orientation/unwarping disabled to preserve overlay alignment.
It keeps block content, labels, coordinates, and page dimensions, and passes a validated result to the shared region schema.
Official model weights are downloaded on first use; private PDF contents are not submitted to a hosted OCR API.
The optional environment is pinned in `extraction/uv.lock` and supports Python 3.11–3.12.
Model files use PaddleX's normal local cache.
PaddleOCR is given a 30-minute subprocess limit; local model analysis has a three-minute per-chunk timeout.

## Intake artifacts

The application server owns the bounded intake workflow: extraction, local vault discovery, candidate region matching, optional local model analysis, output validation, and durable persistence.
The processor is not given shell execution or vault write access.
New imports run retrieval-only native intake, and the reader lazily starts intake for older PDFs when first opened.
Choose an installed local chat model in the intake controls to enrich every nonempty region with generated analysis.
The research tutor's independently selected model is preserved.

Each `chunkContext` record contains:

- Source/region identity, extraction revision, PDF content hash, processor version, timestamp, local model, and vault signature.
- Candidate vault passages with actual note paths, titles, headings, line numbers, note hashes, and excerpt snapshots.
- Candidate regions with IDs, pages, types, source excerpts, and matching reasons.
- Optional structured analysis: summary, concepts, assumptions, questions, proposed note links, and proposed region relationships.
- Completion or partial status, validation errors, and an explicit unverified label.

Proposed links must resolve to a supplied note path or region ID and contain exact nonempty quotations from both supplied excerpts.
Matching quotations establish the identity of the cited text; they do not establish that the proposed mathematical relationship is correct.
The processor does not infer mastery or promote generated claims into permanent notes.

Successful chunks are saved individually and reused when the document revision, vault signature, processor version, and model match.
Invalid model output leaves a partial bundle with its retrieval context and error, and a subsequent intake run retries it.
Cancellation retains completed bundles and aborts an active model request.
A server restart marks unfinished jobs interrupted rather than silently resuming expensive model work.
A fresh vault scan marks older bundles stale, and stale bundles are excluded from subsequent tutor context.
Historical snapshots remain inspectable.

## Local API

All endpoints retain Margin's existing loopback, host/origin, and mutation-token checks.

| Endpoint | Result |
| --- | --- |
| `GET /api/sources/:id/regions` | Current layout and latest intake job. |
| `POST /api/sources/:id/intake` | Starts/resumes `{extractor: "native" or "paddle", model: "" or installed local model, force: false}`. |
| `POST /api/sources/:id/intake/cancel` | Requests cancellation, preserving completed work. |
| `GET /api/sources/:id/chunks?regionId=...&revision=...` | Versioned layout and saved chunk bundles, including freshness flags. |
| `GET /api/export` | Existing research export plus layouts, immutable snapshots, chunk contexts, and intake history. |

The chunk export is the handoff artifact for later local agents.
It includes original extracted text and supporting snapshots alongside generated context, with origin and verification status preserved.
A tutor question about a selected region automatically includes current bundles for that region and its parent, under separate `C` evidence handles.
Those handles are labeled as intake context containing unverified proposals rather than original source claims.

## Validation

`npm test` covers real PDF geometry, stable IDs, nested region hit testing, Paddle result normalization, invalid geometry, local-only processor selection, resumability, cancellation, interrupted jobs, exact quotation validation, changed-vault exclusion, annotation persistence, export, and tutor context.
`npm run build` checks the TypeScript interface and production bundle.
`node scripts/qa-regions.mjs` starts a disposable browser fixture on port 4320 with its own SQLite database and vault.
`node scripts/validate-local-intake.mjs [installed-model]` runs one controlled chunk through real local Ollama and reports the result.
`node scripts/validate-paddle.mjs` runs the real local PaddleOCR adapter on a controlled two-page PDF.

The initial live Qwen 3.6 validation completed one chunk in approximately 14 seconds and produced a summary and one quote-backed note connection.
That small run verifies the integration, not the quality or throughput of document-wide analysis.

The initial real PaddleOCR validation parsed the controlled two-page fixture into nine regions, including one recognized equation, without warnings.
Its first run took approximately 226 seconds including initial model downloads; it is not a steady-state performance measurement.
