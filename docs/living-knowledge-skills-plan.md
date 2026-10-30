# Living knowledge skills for Margin

Date: 2026-10-30. Status: proposed design for discussion; no runtime changes.

## Intent

Every note should expose a reusable, progressively loadable knowledge skill. MOCs expose routes into related skills. Literature notes connect the researcher's evolving understanding to persistent, source-anchored AI preparation of the paper. New conversations can discover and use this preparation without repeating the entire analysis.

The important outcome is cumulative research: importing, reading, correcting, and connecting a paper improves future work across papers and topics. Markdown makes that accumulated preparation inspectable and portable. Retrieval, evidence registration, and revision tracking make it usable reliably.

## 1. What “every note is a skill” means

A knowledge skill answers four questions: what is here, when might it help, where should the agent look next, and what supports its contents?

Every note gets a minimal manifest, even if it has no generated analysis yet. The manifest references the existing note rather than replacing it. It can expose source-backed content, user explanations, application guidance, prerequisites, caveats, unresolved questions, and related skills when those exist.

Use a shared interface with different content by note type:

| Note type | What its skill exposes |
| --- | --- |
| MOC | Curated topic structure, child routes, its own substantive content, and separately labeled proposed routes. |
| Literature note | Paper identity, source coverage, contributions, assumptions, results, links to paper sections, and pointers to the researcher's current note. |
| Theorem | Exact statement, scope, hypotheses, notation, source anchors, proof dependencies, applicability checks, and known limitations. |
| Concept/definition | Definitions and variants, notation, relationships, examples, and source references. |
| Procedure/worked example | Inputs, steps, conditions, outputs, and whether the example was user-worked or AI-generated. |
| Unfinished note | Available content and explicit gaps; a stub remains useful without invented completeness. |

Some skills contain procedures; others expose knowledge. A mathematical theorem need not be rewritten as imperative instructions. A generated applicability checklist is AI interpretation until checked against the actual theorem.

Here “skill” is a Margin knowledge interface, not a requirement to install every note as an executable agent skill. The agent receives a small catalog and explicit loading tools. Arbitrary prose in PDFs and notes remains retrieved content, never authority to change tool permissions or agent behavior.

## 2. Two user-facing layers, with distinct evidence origins

**Human layer:** existing notes, deliberate edits, annotations, questions, interpretations, accepted contributions, and curated links. Preserve authorship at passage level: residence in the vault alone does not prove that the researcher wrote a passage. Accepted AI text retains its AI-assisted origin.

**AI layer:** generated search descriptions, aliases, paper maps, result cards, suggested applications, cross-paper comparisons, unresolved mismatches, and candidate connections. It is persistent, versioned, inspectable, and refreshable independently of the human note.

**Original sources support both layers:** PDF text, bibliography, equations, and exact locations remain independently accessible. Preserve three evidence origins—source, human, AI—even though the interface presents two working layers.

This enables answers such as “Your note interprets the assumption this way; the paper states this narrower condition; the connection to the other paper is a proposed inference.” Neither the user's interpretation nor an AI summary silently becomes the paper's claim.

An AI card can discover relevant material. Factual or mathematical support comes from the underlying inspected passages. A comparison needs evidence from both sources and an explicit account of the inference connecting them. If the original is unavailable, disclose that the claim is based on a retained summary or excerpt.

## 3. Progressive disclosure through MOCs and direct search

Load the smallest useful representation first:

1. **Catalog entry:** identity, title, type, short search description, aliases, coverage, freshness.
2. **Skill overview:** scope, navigation, main distinctions, assumptions, relevant child IDs.
3. **Targeted content:** theorem/result/section card, selected user passage, or comparison.
4. **Evidence:** exact current note or PDF passages, registered for citations.

MOCs are entry points into a graph. They can contain mathematical prose as well as links. A note may belong to several MOCs; cycles and cross-links are normal. Store stable IDs, track visited nodes, cap traversal depth/fan-out/context, and select branches relevant to the question.

Keep explicit user links separate from AI-proposed links. Loading a parent does not load every descendant. Permit direct global note/passage search alongside MOC traversal so incomplete MOCs cannot hide relevant knowledge.

Illustrative route, not a claim about existing vault links:

```text
Optimization MOC
  → Distributed optimization
    → A paper's literature skill
      → Convergence theorem card
        → Exact theorem + assumptions in PDF
        → Researcher's explanation in literature note
```

## 4. Paper preparation pipeline

### Stage A: Identity and extraction

Resolve Zotero item/attachment, citekey, linked literature note, source revision, and duplicate associations. Extract pages, sections, paragraphs, equations, bibliography, and candidate mathematical environments. Record OCR quality, missing pages, ambiguous formulas, and actual processed coverage.

### Stage B: Meaningful content units

Build units around definitions, results, assumptions, proofs, methods, examples, and useful section arguments. Use smaller PDF regions as evidence anchors rather than generating a separate skill for every paragraph or equation fragment. Link each unit to enclosing context and definitions it uses. Keep heuristic classifications explicit.

### Stage C: AI preparation

For each useful unit, produce a bounded Markdown card containing a retrieval description, source-backed account, assumptions and notation, exact evidence anchors, unresolved extraction issues, and candidate relationships. Do not manufacture a theorem when the paper only gives an informal claim.

Build a paper overview from inspected units. Include problem, approach, contributions, result map, limitations, and coverage. A paper overview is a synthesis, not just concatenated chunk summaries. An incomplete paper gets an incomplete overview with identified gaps.

### Stage D: Vault discovery and cross-paper synthesis

Find candidates through explicit links, MOCs, bibliography, lexical search, and later hybrid semantic retrieval. Read the relevant candidate passages before proposing a relationship. Compare assumptions, objects, quantifiers, conclusions, and differences in notation.

Persist bounded comparison cards: the two claims/passages, proposed relation, reasoning, qualifications, and what remains to check. Useful relations include uses, specializes, generalizes, analogous-to, incompatible-assumptions, possible-application, and apparent-tension. Prefer apparent tension pending inspection to an automatic contradiction label.

Retain useful negative findings such as an assumption mismatch. A high similarity score is discovery evidence; it does not establish a mathematical relationship. A novel cross-paper idea is a hypothesis, with its supporting argument and unanswered checks retained.

### Stage E: Publish the AI snapshot

Validate structure, identities, quoted spans, references, coverage, and revision dependencies. Publish a complete snapshot atomically. Retain partial work for recovery and mark failed or unchecked units. Mechanical validation does not prove the mathematics.

The resulting skills are shared across sessions and workspaces under the configured vault/library scope. Reopening the paper or discussing another topic does not require reimporting it.

## 5. Markdown and storage

Recommended first release: keep generated artifacts in a separate Margin-managed directory, with an export route and an inspector. Avoid adding generated prose to every visible vault note. The existing human literature document remains independently editable and synchronized through the notebook's existing protections.

Illustrative layout; exact filenames are an implementation choice:

```text
.data/knowledge/
  <entity-id>/
    manifest.md
    revisions/<revision-id>/
      overview.md
      units/<unit-id>.md
      connections/<relation-id>.md
```

`manifest.md` points to one current immutable revision. The Markdown snapshot is authoritative for generated content; SQLite indexes that snapshot and owns jobs, identity reconciliation, dependency records, review states, and run provenance. Do not independently edit competing Markdown and database copies of the same generated prose. Rebuild search metadata from a valid snapshot; retain the source inputs needed to regenerate it.

Minimum manifest/card metadata:

| Group | Fields |
| --- | --- |
| Identity | Stable entity/unit ID, type, title, aliases, source/note IDs and current locations. |
| Inputs | Note revision/hash, PDF hash, extraction revision, exact evidence IDs/locators. |
| Generation | Schema/processor/prompt version, model/provider, job/run ID, timestamp. |
| State | Extraction coverage, freshness, authorship origin, relation review state, independent verification state. |
| Navigation | Parent/child/related IDs and relation origin; these are graph links, not a single ownership tree. |

Keep extraction coverage, model-generation completion, human review, and mathematical verification as independent dimensions. “Generated,” “accepted,” “current,” and “verified” mean different things.

Store pointers and revision-scoped evidence excerpts from human notes rather than generating a second authoritative copy of the researcher's writing. Preserve original questions and uncertainty. Personal reasoning becomes durable context when captured, linked, or deliberately retained; an arbitrary tutor answer does not automatically become accepted knowledge.

## 6. A living document without runaway regeneration

Treat updates as a dependency graph:

- A PDF/extraction revision changes its unit cards, paper overview, and dependent comparisons.
- A user edit immediately updates direct note search; only dependent AI descriptions and comparisons require regeneration.
- A MOC edit refreshes navigation without forcing every linked paper through intake again.
- A new paper searches for bounded candidate connections rather than comparing every pair of vault notes.
- A corrected or rejected relation remains recorded so unchanged inputs do not recreate the same proposal.
- A renamed/deleted/ambiguous note updates identity and availability rather than silently redirecting evidence.

Use input fingerprints, deduplicated jobs, per-entity locking, cancellation, retry limits, atomic publication, and a bounded queue. Track actual dependencies and the search/index revision used to discover candidates. When discovery changes, schedule incremental rediscovery; do not claim that every unseen relation has been checked.

Stale AI guidance is visibly stale and excluded from asserted support. Current source/human passages remain retrievable while regeneration is pending. Historical answers retain their exact evidence snapshots.

Background preparation uses an explicitly configured local model and budget. Cloud preparation requires a separate explicit action or setting identifying the destination and scope. Tutor model selection alone does not enable background cloud processing. Reading and human editing work without an available model.

## 7. How a later conversation uses it

Example question: “Can the convergence argument from the earlier paper help with this MPC formulation?”

1. Search skill descriptions and current human passages; explore relevant MOC branches and global candidates.
2. Load only the relevant result cards and any stored comparison, checking freshness and coverage.
3. Read the actual theorem, definitions, assumptions, and the researcher's relevant explanation.
4. Compare conditions to the current formulation; identify matches, mismatches, and missing facts.
5. Answer with direct citations to the original sources and user passages, identifying any new inference.
6. Save a reusable comparison proposal with dependencies if useful; preserve the user's correction or dismissal.

The agent might find “the earlier result requires a communication assumption this formulation has not supplied.” That is useful research progress even when the proposed transfer fails.

Proposed tool contracts include `knowledge.search`, `knowledge.load`, `knowledge.children`, and `knowledge.connections`. They return typed discovery/content records with provenance and budgets. Existing note/source read tools register the underlying evidence. Loaded AI cards have their own AI provenance; their source pointers do not count as proof that the agent inspected those sources.

## 8. Relationship to the current application

Repository baseline inspected 2026-10-30:

- `server/intake.mjs` already produces durable region context with optional local-model summaries, concepts, assumptions, questions, quoted connection proposals, input hashes, and resumability. It uses a broad vault signature for freshness.
- `server/agent/tools/vault.mjs` separates lexical passage discovery from inspected evidence. The older `server/retrieval.mjs` also has semantic retrieval machinery; the agent's vault search does not automatically inherit it.
- The notebook now has shared literature documents, retained revisions, Thoughts/Tutor/Synthesis surfaces, incremental human-note suggestions, and independent synthesis model selection. These are described in `working-notebook-implementation.md`; the earlier redesign plan alone is no longer an accurate implementation baseline.
- Existing evidence snapshots and citation validation provide a foundation for source references. Existing human-document synchronization and suggestion handling provide the boundary for deliberate promotion.

The proposed additions are universal knowledge manifests, meaningful-unit cards, paper-wide preparation, graph navigation, persistent cross-paper comparisons, and agent retrieval across these artifacts. None is implemented by this planning document. Extend the current services rather than introducing an unrelated second intake, identity, or document-sync system.

## 9. Implementation sequence and evaluation

### First vertical slice

Use one fresh paper, one paper with detailed existing human notes, and their relevant MOC/concept notes. Reuse existing extraction/context bundles. Create minimal manifests for those notes, unit cards for a small selected section, a coverage-aware paper overview, and at most a few supported comparisons.

Add shared skill discovery/loading to the harness and an inspector showing AI preparation separately from the human document. Start a new conversation on the other paper and demonstrate retrieval, condition checking, direct source/user citations, and persisted correction handling.

Do this before a full-vault migration. It tests whether the preparation helps actual questions and whether the two layers remain intelligible.

### Expansion

1. Incremental background jobs, dependency invalidation, export/recovery, and rejection persistence.
2. Lightweight manifests for every indexed note and bounded MOC traversal with direct-search fallback.
3. Meaningful-unit extraction and paper-wide preparation across the library; generate deeper analysis on demand or by budgeted priority.
4. Hybrid search and richer comparisons after measuring retrieval failures and answer usefulness.

### Acceptance criteria

- A new conversation on another paper retrieves relevant retained preparation without relying on the previous transcript.
- Every substantive answer can distinguish original source evidence, human interpretation, and AI inference; exact citations open the supporting passage.
- A partial/OCR-damaged paper is never represented as completely analyzed.
- Editing a source or note invalidates dependent AI artifacts while preserving current direct retrieval and unrelated snapshots.
- Cyclic MOCs terminate under configured budgets; an unlinked relevant note is discoverable globally.
- Repeated intake/retry does not duplicate skills or recreate unchanged rejected proposals.
- A killed process leaves the last published snapshot readable and partial work recoverable.
- Paper preparation alone never changes human prose, curated MOCs, or mastery/verification state.

Evaluate a small fixed question set before and after: useful result discovery, exact evidence support, assumption preservation, human-attribution accuracy, latency, preparation cost, and redundant reads. Include questions where a tempting connection is wrong, questions outside extracted coverage, and corrections that should survive a new session. Citation validity and fluent prose alone are insufficient measures.

## 10. Recommended defaults for discussion

- Give every note a lightweight skill interface; invest deeper preparation where there is substantive content or reading activity.
- Keep the AI layer separate from ordinary vault browsing, with an explicit inspection/export route.
- Use MOCs as curated navigation plus direct global search.
- Treat generated comparisons as reusable proposals with source evidence and a lifecycle.
- Preserve the human note as the place for the researcher's developing understanding; a generated paper summary can exist before any human summary does.
- Implement one demonstrably useful cross-conversation research loop before scaling processing to the entire vault.
