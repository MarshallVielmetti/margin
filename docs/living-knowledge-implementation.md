# Living knowledge implementation

Implemented 2026-10-30 from [the living knowledge plan](living-knowledge-skills-plan.md).
This release provides the cross-conversation vertical slice, universal lightweight manifests, and bounded incremental local preparation.
It does not establish mathematical verification or enable background cloud processing.

## Use

Open the library icon beside **Notebook** to inspect **Living knowledge**.
The catalog searches current note text and retained preparation across the configured vault/library.
Explicit note and MOC routes open one skill at a time.
The current human note remains available through **Open current note**.

Run PDF region intake first.
Choose **Build extraction map** to create meaningful units without model calls, or select an installed local model and choose **Prepare with local model**.
Optional page numbers and the unit, model-call, and comparison limits bound preparation.
The inspector distinguishes extraction coverage, generation state, freshness, review decisions, and mathematical verification.
Missing pages, truncation, failed units, and limited overview coverage remain recorded.
The paper overview is a bounded synthesis when generated, and an explicitly labeled extraction map otherwise.

Comparisons retain exact excerpts from both inputs, an AI inference, qualifications, and remaining checks.
Incoming comparisons are also visible when inspecting the target note's lightweight manifest.
Accepting a proposal changes its review state only.
Rejecting or correcting it preserves the decision and its human-written explanation across sessions and regeneration.
Unchanged rejected proposals reuse their retained work instead of making another comparison call.

**Background preparation settings** are independent of Tutor and Synthesis model selection.
Background preparation defaults to off.
When enabled with an explicitly selected local model, completed intake and a 30-second incremental check schedule bounded preparation.
Each check schedules at most two changed entities, with one active worker and at most sixteen waiting jobs.
Stop preserves completed unit work and the last published revision.
No preparation step edits vault notes, curated links, literature documents, or mastery records.

## Storage and identity

Generated content is authoritative Markdown under the configured data directory:

```text
knowledge/<scope-id>/<entity-id>/
  manifest.md
  work/<input-key>.md
  revisions/<revision-id>/
    overview.md
    units/<unit-id>.md
    connections/<comparison-id>.md
```

The scope identifies the canonical vault root, or the local library when no vault is configured.
Skills are shared across sessions and workspaces within that scope.
Every indexed note gets a minimal manifest without requiring a model.
Note manifests reference the note, its hash, and its current location; they do not create a competing editable copy of the human document.
Authorship is not inferred from residence in a vault.
AI-origin descriptions and comparison prose retain AI provenance even when a proposal is accepted.
Accepted synthesis wording carries its application-owned acceptance record into later exact-match note reads and comparison anchors, with attributed spans kept separate from surrounding unknown-origin prose.
Self-declared provenance comments do not establish authorship.

Unique exact-hash renames preserve identity and expose both the original evidence locator and the reconciled current path.
Missing and ambiguous notes are not silently redirected.
Registered source, attachment, citation-key, and extracted PDF identities reconcile duplicate associations within the scope.
Deliberately linking an already prepared source to a note preserves its preparation and retains a redirect for the former lightweight note identity.
Conflicting note associations remain separate.

SQLite owns jobs, identity reconciliation, dependency/index metadata, retry counts, and human review history.
Generated prose is not independently editable in SQLite.
Successful unit work is saved before publication so interrupted jobs can reuse it.
Failed unchanged generation inputs have a durable three-attempt limit.
Complete revision directories are validated and renamed before an atomic manifest-pointer update.
SQLite indexes can be rebuilt from the published Markdown after a crash between publication and indexing.
Incomplete staging directories do not replace the last published snapshot.
The configured generated directory is excluded from vault scanning, including when macOS resolves the vault through an alternate filesystem path.

Source and extraction revisions invalidate their dependent preparation.
Note edits refresh direct discovery immediately and invalidate comparisons depending on that note, while unrelated source cards remain current.
MOC changes refresh navigation and candidate discovery without regenerating unchanged source units or an unrelated paper overview.
Candidate discovery records its input revision and does not claim exhaustive checking of every possible relationship.
Generated revision IDs are excluded from discovery fingerprints to prevent self-triggered regeneration loops.

## Preparation and evidence

The pipeline consumes existing `documentLayout`, `layoutSnapshot`, and source records rather than introducing another extractor.
Meaningful units group definitions, result environments, proofs, and section arguments with adjacent paragraphs and equations.
Grouped regions are not duplicated as independent paragraph and equation-fragment skills.
Classification remains heuristic.
Source page/region locators, exact retained excerpts, hashes, and context-region pointers remain available independently of generated accounts.

Discovery uses direct lexical passage search, explicit note/MOC routes, exact registered bibliography metadata matches, and retained source excerpts from other prepared papers.
A model sees inspected excerpts on both sides of a proposed comparison.
Both quotations must match those supplied excerpts exactly before publication.
The model can explicitly report that no relationship is supported.
Mechanical checks validate references and quoted spans, not mathematics.

The harness has four schema-validated discovery tools:

| Tool                    | Purpose                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `knowledge.search`      | Small catalog results with identity, aliases, description origin, coverage, and freshness; global search remains available. |
| `knowledge.load`        | One overview or unit, provenance, and read instructions; stale generated prose is withheld.                                 |
| `knowledge.children`    | Explicit routes under depth, fan-out, visited-node, node-count, and character limits.                                       |
| `knowledge.connections` | Bounded proposals, negative findings, corrections, and rejection state; stale or rejected prose is withheld.                |

These tools do not register original evidence.
Loading an AI card does not imply inspection of its anchors.
The agent must use `source.read` or `vault.read` before citing original passages.
Prepared library sources are included in a new run's frozen read scope so another workspace can inspect their actual evidence.
Unprepared sources from unrelated workspaces do not gain that permission.
Disabling source expansion also withholds source preparation from knowledge tools.

`source.read` accepts a page plus an optional region ID and extraction revision to inspect exact structured or OCR text.
It registers the actual extracted region, its location, and source provenance.
Citation navigation preserves the region, extraction revision, and geometry when reopening the passage.
Historical answers keep their independent evidence snapshots.

## Local API

All mutations use the existing local-origin and `X-Margin-Token` protections.

| Endpoint                                     | Purpose                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/knowledge/search?q=...`            | Refresh notes and discover skills.                                                  |
| `GET /api/sources/:id/knowledge`             | Inspect a source's manifest, preparation, routes, and jobs.                         |
| `POST /api/sources/:id/knowledge/prepare`    | Queue or reuse a bounded preparation job.                                           |
| `POST /api/knowledge/jobs/:id/cancel`        | Stop queued or active preparation.                                                  |
| `GET /api/knowledge/entities/:id`            | Inspect one skill.                                                                  |
| `GET /api/knowledge/entities/:id/children`   | Inspect direct routes.                                                              |
| `POST /api/knowledge/connections/:id/review` | Record a proposal decision and optional correction.                                 |
| `GET/POST /api/knowledge/settings`           | Read or configure independent local background preparation.                         |
| `GET /api/knowledge/entities/:id/export`     | Download authoritative Markdown files and relevant review history in a JSON bundle. |
| `POST /api/knowledge/recover`                | Reconcile manifests and rebuild index metadata.                                     |

The general research-history export also includes knowledge Markdown, jobs, review events, and dependency records.
Recovery requires the retained source/extraction records to restore original evidence access; Markdown preparation is not a replacement for the source library.

## Validation and limits

`test/knowledge.test.mjs` covers identity, cyclic navigation, direct discovery, model-free operation, partial coverage, restart reuse, selective invalidation, PDF changes, review persistence, quotation rejection, cancellation, scope, retry limits, recovery, and incremental background behavior.
`test/knowledge-api.test.mjs` runs a new conversation in another workspace against controlled local-model responses.
That conversation discovers earlier preparation, loads a retained correction, inspects an exact OCR theorem and current note passage, and returns direct evidence citations without a previous chat transcript.
Additional citation coverage checks exact region navigation.
The existing intake, notebook, provider, evidence, and promotion suites remain part of validation.

The controlled workflow evaluates discovery, condition preservation, origin separation, unchanged human writing, and persistent corrections.
It does not measure a live model's mathematical accuracy or demonstrate improved research quality on a real-paper benchmark.
Preparation cost is recorded as actual model calls per job; real-model latency and retrieval-quality evaluation remain to be measured.
The overview inspects bounded excerpts from at most sixteen selected units, with its exact unit list and excerpt budget recorded separately from extraction coverage.
Semantic/hybrid ranking and a verified theorem/dependency graph remain later expansions.
