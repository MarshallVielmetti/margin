# Design Research Tutor Workflow — Design Document

Status: Conceptual design specification and architecture baseline.
Source thread: `documentation/evidence/retrieved-discussion.md` (thread "Design Research Tutor Workflow").
Supporting evidence: `documentation/evidence/discussion.json` and the user's representative note examples.
Current implementation: described in `README.md`; see "Current Implementation Baseline" (§19).
Date of this revision: 2026-10-29.
Reviewer note: this document is a synthesis of a design conversation, not the conversation itself.
Where the discussion presents an illustrative interaction, this document marks it as illustrative.

## 1. Purpose and problem statement

The system is a local research workspace for reading sources, preserving the user's own reasoning, and connecting selected insights to an existing Obsidian vault.
It implements the core workflow **explore → articulate → integrate → revisit**.
The problem it solves is not a failure to capture information: the user already invests substantial effort in understanding papers, deriving theorems, and recording notes.
The problem is that comparatively little of that understanding is converted into reusable, interconnected, permanent knowledge.
The literature notes contain deep technical detail, while the `summary` fields and conceptual links lag behind the understanding already developed.
The application should close the gap between *technical understanding in progress* and *curated, retrievable, interconnected knowledge*.

The user works across multiple fields using a Zettelkasten-style organization of Maps of Content, definition notes, theorem notes, tool/technique notes, and literature notes, with Zotero as the reference manager.
Examples used throughout this document — a Viability Kernel characterization, the Optimization MOC, the Lie Bracket definition, Banach's Fixed Point Theorem, a decentralized-safety MOC, and the Tsitsiklis (1986) literature note — are drawn from the user's real notes and are illustrative of pattern, not a guarantee of content.

## 2. Vision and guiding principles

The central vision is that the research environment makes working with Obsidian effortless without attempting to become a competing Obsidian.
The canonical editor remains Obsidian, with the user's keybindings, snippets, and rendering.
Switching windows is acceptable; what must be eliminated is the *manual overhead* of translating already-understood material into a permanent note.
The design repeatedly distinguishes what is *fundamental* to the knowledge architecture from what is an *interface convenience*.
Fundamental requirements should not be coupled to interface choices such as panel placement or control layout.

The following principles are considered settled and guide every subsequent decision.

- **Preserve the user's intellectual contribution.** AI output must not silently masquerade as the user's own understanding.
- **Minimal, high-information permanent notes.** Optimize for concise notes that the user can reconstruct from, not for maximal generated prose.
- **No fabrication by default.** Where the user has not articulated an intuition, the system must not manufacture one and imply that the user supplied it.
- **Distinguish content kinds.** Verbatim source, the user's words, an AI-edited version of the user's words, and an AI inference are kept separable end to end.
- **Working history and permanent knowledge are distinct.** Everything is preserved; only a subset is promoted, explicitly and sparingly.
- **Adapt to the existing vault.** The system exploits the user's current structure rather than forcing a new template or a reorganization.
- **Support evolution of understanding, not correctness of existing notes.** The application helps identify incomplete proofs, questionable statements, and missing connections, but guides the user through the process rather than silently rewriting.
- **One substantial reading session should leave something useful, even when the paper is not finished.**
- **The application acts as editor, organizer, and verifier of the understanding already developed.** Source extraction handles mechanical transcription; the AI does not "write the notes."

## 3. Settled design decisions

These decisions were reached and confirmed across the design conversation.
They are treated as the initial conceptual specification.

- **Canonical editor:** Obsidian — all existing keybindings, snippets, and rendering.
- **Integration:** A lightweight Obsidian bridge that handles navigation, note creation, cursor placement, and reviewed edits (alternatives such as capturing the research app itself as the editor were explicitly rejected).
- **Capture:** Source-anchored dictation and lightweight writing inside the research application.
- **Working history:** Persistently stored *outside* the vault, including incomplete reasoning.
- **Knowledge promotion:** Turn selected insights, derivations, and interpretations into linked Obsidian notes, with destinations chosen deliberately.
- **Literature summaries:** Constructed progressively from the user's own understanding and verified against the source.
- **Organization:** Existing wikilinks and MOCs provide the structural foundation; AI proposes additional relationships rather than creating them without confirmation.
- **Trust:** Source claims, the user's own reasoning, and AI inferences remain distinguishable at all times.

There are two further structural conclusions that the conversation treats as foundational and that are detailed in later sections.
First, the knowledge index must operate at both the **note level and the passage level** and must recognize heterogeneously structured notes.
Second, the knowledge index must represent **mathematical concepts independently of their occurrences** in notes and sources, so that a result in one paper, a theorem note, and a learning session can be recognized as discussing the same concept under different assumptions.

## 4. The knowledge model

The system is organized around a small set of core objects, **all shared across workspaces**, so that the same sources and concepts contribute to many workspaces without duplication.
This is a conceptual data model, not a commitment to a particular storage technology or to seven database tables.

| Object | Purpose |
| --- | --- |
| **Source** | A paper, textbook, chapter, or other authoritative reference, usually linked to Zotero. |
| **Concept** | A mathematical definition, theorem, technique, or idea, ideally associated with an existing Obsidian note. |
| **Source anchor** | A precise reference to a passage, equation, figure, or theorem within a source. |
| **Learning artifact** | A captured thought, explanation, exercise, derivation, or proof attempt from a learning session. |
| **Relationship** | A typed connection between concepts, sources, notes, and artifacts. |
| **Workspace** | A persistent contextual view over sources, concepts, sessions, and research questions. |
| **Learning evidence** | A record of what the user has *demonstrated understanding of*, and when — explicitly self-reported, never inferred from transcription. |

A crucial modeling point is that **an Obsidian note and a mathematical concept are not the same thing**.
A concept may appear in several papers, carry multiple names, or admit several equivalent formulations.
The system should recognize these relationships while remaining conservative about collapsing subtly different theorems into one.
The user's existing Obsidian wikilinks, aliases, MOCs, and source notes are an unusually useful starting point for concept identification, and the design must exploit them.

The knowledge model additionally distinguishes **note relationships from research claims**.
A relationship describes how two notes or concepts relate; a claim is a statement that can evolve, with its own status.
If everything is indexed as undifferentiated note text, the assistant can easily confuse a tentative conjecture with an established theorem.
The model therefore needs a small amount of semantic interpretation that maps content to an appropriate status (§4.3), which becomes important when the assistant later conducts agentic research and compares a new paper against the user's existing work.

### 4.1 Relationships, not just topics

Two notes that both discuss "invariance" are not particularly related merely by that token.
What matters is the *type* of connection.
The distinction between the following is load-bearing for retrieval and for synthesis suggestions.

- One **theorem generalizes** another.
- One **result depends on** a definition or lemma.
- Two results use **incompatible assumptions**.
- One method provides an **application of** another.
- A **counterexample demonstrates the limitation** of a theorem.
- One note **exemplifies** another; one is **characterized by** another; one is **related to** another; one is **cited from** another.

Explicit wikilinks establish that ideas are *related*.
The design preserves those links as authoritative, user-created relationships and *optionally* layers a richer typed relationship on top.
When the user confirms a connection, the system can suggest an appropriate place to represent it in the user's existing notes or MOCs.

### 4.2 Relationships exist inside notes

The single most important structural insight from the user's examples is that **relationships exist *inside* notes, not only between them**.
Consider the Lie Bracket note.
It links to `[[Vector Field]]`, `[[Manifold]]`, `[[Directional Derivative]]`, `[[Lie Algebra]]`, and other concepts, but those links carry very different meanings.
The link to `[[Vector Field]]` in the formal statement identifies the objects the bracket operates on.
The reference to `[[Lie Algebra]]` arises in the discussion of algebraic properties.
The flow-commutation lemma is a *characterization*.
The car-configuration example *demonstrates* an application.
A naive graph with one node per note and one edge per wikilink loses all of these distinctions.

The design therefore represents the vault at multiple levels: note nodes, section or passage nodes, and typed relationships, where each relationship points back to the passage that supports it.
The system must understand *the context in which a link appears*.
It must also retain the distinction between relationships that are explicitly stated by the user and ones inferred by the model.
This graph model is independent of the chosen database technology.

### 4.3 Content kinds and provenance

At minimum the system distinguishes four kinds of content, and every note write must know which kind it is producing.

| Content | Appropriate status |
| --- | --- |
| Extracted theorem from a textbook | Source-backed statement, treated as a *transcription* of the source, not authoritative source text. |
| The user's own established derivation | User-derived, with proof or supporting reasoning. |
| Proposed research conjecture | Open / unverified. |
| AI-inferred connection | Suggested / unconfirmed. |
| Failed proof attempt | Historical learning evidence. |
| Accepted connection between concepts | Curated knowledge relationship. |

Provenance is a central architectural requirement, not a citation convenience.
For example, an explanation in a Nagumo theorem note should be associated with its original textbook passage, the discussion in which the user formulated the explanation, and an exercise in which the user used the result.
These associations tell the application how the understanding developed and provide ways to reconstruct it later.
They also serve as the structural mechanism that discourages unsupported claims from quietly becoming permanent knowledge: an AI-polished explanation must never become indistinguishable from something the user personally wrote, and any proposed connection must retain the evidence behind it and whether the user accepted it.
The system should not require manual labeling of every paragraph; it should infer candidates from the existing heading and callout structure and remain conservative when unsure.

## 5. Two kinds of permanence

The user stated that storage is cheap and that all proof attempts, conversations, and dictations should be retained.
The design agrees, but interprets that as *persistence*, not as "everything enters Obsidian."
It distinguishes two kinds of permanence.

**Persistent working history.**
Everything from learning sessions: dictations, derivations, questions, proof attempts, explored citations, and prior explanations.
This is stored locally by the research application, is searchable, and is linked to source positions and knowledge concepts.
Incomplete and even incorrect reasoning belongs here.

**Curated permanent knowledge.**
The user's Obsidian notes: definitions, theorems, literature summaries, exercises worth retaining, and synthesized connections.
These are explicitly chosen, organized, and refined by the user.

The two layers are not isolated.
An Obsidian theorem note should be able to reach the original session in which the user worked through its proof, and a learning session should be able to jump directly to the permanent notes it produced.
But the application must not automatically fill the vault with every intermediate reasoning step.
This distinction is especially valuable for Zettelkasten-style organization, where the usefulness of a note depends on it being thoughtfully curated and connected.

A guiding principle follows: **the application should preserve the detailed reasoning that produced a concise note, while exposing them differently.**
A theorem note may hold a precise statement, three sentences of intuition, and a worked example.
The ten-minute discussion, the initial misunderstanding, the attempted derivation, and the moment the correct argument was recognized may be *more* useful when the user is trying to relearn the theorem six months later.
Both should be preserved, but the working history should be the place to look for the reasoning, not the permanent note.

## 6. Knowledge promotion

Knowledge promotion is the central transformation of the system: turning a selected insight, derivation, or interpretation into a linked Obsidian note.
It is distinct from "generate a note," because its input is material the user has already developed during a learning session.

### 6.1 The basic interaction

The user is reading a paper and gradually developing intuition for a theorem.
The working notebook holds a messy record: several minutes of dictation, some incorrect reasoning, a clarification, and finally an example that makes the theorem click.
At that point the user can ask the system to create a theorem note *from this discussion* — a "Promote to knowledge base" preview.
The system identifies the relevant portions of the discussion and prepares an Obsidian note with a formal statement extracted from the source with notation checked before saving, an "Your intuition" section populated from the user's *actual* explanation in the session, suggested connections to existing notes flagged for review, and a pointer to the next editing position for the user's own derivation.
Crucially, the system organizes and cleans up the user's real explanation rather than fabricating one in a writing style.
If the user has never articulated a meaningful intuition, the section should be left empty or the system should prompt the user to explain the theorem in their own words before preparing the note.
This is how the intellectual value of the vault is preserved while the mechanical work is automated.

### 6.2 Multiple destinations

Knowledge promotion is not only about creating new theorem or definition notes.
When the user learns something, several places may be the destination, and they are not mutually exclusive.

| Destination | Contains |
| --- | --- |
| **Working notebook** | Raw explanation, thought process, or derivation, linked to its source and session. |
| **Literature note** | What this particular source established and why it matters. |
| **Concept / theorem note** | Reusable mathematical understanding, proofs, and examples. |
| **MOC / synthesis** | How ideas fit together and relate to the user's research. |
| **Learning exercise** | A useful problem, the user's solution, and reasoning worth revisiting. |

One learning artifact can contribute to several notes without duplicating all of its content.
The system helps decide *where* information belongs.
For example, establishing a relationship between decentralized invariance and viability theory while reading a paper yields, at once, a paper-specific result for the literature note, a general insight for an existing concept note, and a short entry for a safety-critical control MOC, while the full discussion remains in the working history linked from the permanent notes.
This is how literature notes stay small yet nothing useful is lost.

### 6.3 Avoiding duplicates and improving existing notes

Creating a new note must be an intentional choice, not the default response to every interesting passage.
If the user discusses tangent cones in a new paper, the system should first identify the existing tangent cone note and offer to attach a new example or application to it.
The system should recognize when an existing note should be *improved* rather than duplicated.
This connects directly to the user's concern about accumulating disconnected duplicate notes.

### 6.4 Progressive distillation as the overall process

The learning process is best understood as a series of transformations, and **none of them destroys the previous stage**.
The user can retain the full technical discussion while also having a concise, high-information summary for everyday retrieval, and can move *backward* through the record of how an understanding was built when the summary no longer suffices.

| Stage | Activity | Output |
| --- | --- | --- |
| **Explore** | Dictation, reading, questions, proof attempts, technical discussion. | Raw reasoning in the working notebook. |
| **Understand** | The user's own concise explanation, with important assumptions and qualifications. | Conceptual takeaways for retrieval. |
| **Integrate** | Reviewed additions to existing literature, theorem, definition, and MOC notes. | Permanent knowledge. |
| **Revisit** | Retrieve the concise insight, or reopen the original reasoning and source when needed. | Reconstruction of understanding. |

These four stages correspond to the headline workflow **explore → articulate → integrate → revisit**; here "Understand" is the *articulate* stage, made explicit because it is the point at which the user's own explanation is captured and verified before it is integrated.

## 7. Obsidian integration

The canonical editor is Obsidian, with all existing keybindings, snippets, and rendering.
Integration is provided by a lightweight **Obsidian bridge** that handles navigation, note creation, cursor placement, and reviewed edits.
The bridge is not required for standard Obsidian links to work; it augments them.
Opening the Obsidian window and placing a cursor for the user is sufficient; it need not stay inside the research application window.
Since the user commonly works in a split-screen setup, the acceptable cost is the *act of navigation*, not the window switch itself: a button that puts the cursor in the right place in Obsidian and then waits for the user to type is the target experience.

### 7.1 The capture-to-edit target experience

The user should be able to click "Create theorem note," have the relevant information prepared and existing connections identified and the source cited, and then have Obsidian open with the cursor in the right place ready to type.
This eliminates nearly all of the manual overhead of translating understood material into a permanent note, and is treated as a settled design decision.

### 7.2 Reviewed edits and safety

Every note write is a **reviewed edit**, not an unattended write.
Each promotion should save both the original and proposed contents before anything is applied, recheck the current file against the preview before applying, refuse stale edits on mismatch, and restore the exact original on undo only if no later edit has changed the applied contents.
Paths must be constrained to the configured vault; hidden files and symlinked destinations must be rejected.
These are optimistic concurrency checks, not a filesystem-wide lock on Obsidian or a synchronization service.
This is the mechanism by which the "directly authorized edits vs. autonomous changes to knowledge" distinction (§13) is enforced at the filesystem boundary.

## 8. Literature notes and source notes

Literature notes currently serve two different purposes, and the design must support both without forcing them together.
The first is the *reusable understanding* of the paper: its main contribution, its assumptions, its convergence guarantees, and its relationship to other work.
The second is the *reading process*: the notation the user reconstructed, definitions transcribed, equations worked through, and the point where an argument was left unfinished.
Both are valuable, but they are useful for different reasons.
The problem the application solves is not that the user failed to capture information, but that the `summary` field and the conceptual links have not caught up with the technical understanding already developed.

### 8.1 The `summary` field as a first-class output

The `Summary` property the user skims across a database when browsing literature should become a first-class, progressively constructed output of a reading session, ideally updated with no manual intervention.
Rather than writing a summary from scratch, the system prompts the user after the main result has been discussed — for example, *in two or three sentences, what does this paper establish, and what distinguishes it from existing approaches?*
The user dictates or types the explanation; the application checks it against the actual paper, flags missing qualifications or apparent inaccuracies, preserves the user's original words, and updates the existing `summary` field.
The summary is treated as a *transcription / interpretation* of the source, not as authoritative source text; the original PDF remains the source of authority when extracting mathematical assumptions and theorems.

### 8.2 The literature note as a durable entry point

Literature notes should function as **durable entry points into sources and their conceptual contributions**, rather than necessarily containing the entire reading history.
For future reading sessions, technical material should be allowed to remain in the working notebook until the user decides it is worth preserving.
The following is a guideline, not a rigid template.

| Location | What belongs there |
| --- | --- |
| **Zotero** | Original PDF, bibliographic information. |
| **Working notebook** | Detailed reading history, dictations, intermediate derivations, partially understood arguments. |
| **Literature note** | Summary, important source-specific results, assumptions, conclusions, and links. |
| **Concept / theorem notes** | Reusable mathematics, the user's intuition, worked examples, proofs. |
| **MOC** | Higher-level synthesis, comparisons, and relationships among concepts and papers. |

A source note may gradually acquire structure without forcing every field on every note.
For a skimmed paper the user may record only a summary, one useful result, and the relevant MOC; for a paper central to the research the same note may grow as understanding deepens.
The structure should accommodate that progression.
Candidate fields include bibliographic information (from Zotero), summary (the user's explanation checked against source), main results (source-linked claims and theorems), key assumptions (extracted and verified against the PDF), related concepts (links to existing notes), open questions (captured during reading), and relevance (the user's own assessment of why the paper matters).

### 8.3 Resumable understanding

The reading record should make it possible to resume a paper where the user stopped.
If a literature note ends with a partial account of a convergence theorem, the system can prompt on return, *last time you reached the convergence results but had not yet finished examining the precise guarantees — would you like to resume there?*
It must not infer mastery merely because the user transcribed material.

## 9. MOCs and synthesis

A Map of Content is not merely a folder, and not merely a list of related concepts.
It is best understood as the user's *current conceptual organization of a subject*.
This observation is important because the user's MOCs serve very different purposes depending on the subject and the user's stage of understanding.
The **Optimization MOC** behaves like a miniature textbook chapter: it introduces a mathematical problem, explains it, and links into subfields and related ideas.
A **research-investigation MOC** (for example, the decentralized-safety MOC) behaves more like a research notebook: a reading queue, references, tentative mathematical formulations, and open questions.
The design must support both naturally, without forcing either into a single prescribed template.

This leads to a firm principle: **note type should be descriptive, not restrictive.**
A single note may simultaneously be an MOC, a research notebook, and a synthesis document.

### 9.1 MOCs should not be required to form a tree

A single theorem may be relevant to several MOCs, and a topic workspace may be associated with multiple MOCs.
MOCs need not compose into a hierarchy.
The example of an Organization MOC that organizes distributed-optimization results by communication assumptions, optimization objectives, and convergence guarantees is representative.
The system can notice that a newly studied paper introduces a distinction the MOC does not yet represent, and it may propose adding a subsection or re-linking an existing concept under a different heading.
This is more valuable than automatically inserting another backlink: it helps the user *refine their synthesis of a field*.
The system may propose refinements, but it must not reorganize MOC structures without the user's involvement.

### 9.2 Synthesis through the literature note / MOC pair

The cross-note connection that the design repeatedly prioritizes is this kind.
A paper on distributed safety filtering introduces a communication model.
The system should retrieve the user's existing decentralized-safety formulation *not merely because keywords match* but because the paper concerns an information-constrained control problem.
It then invites a comparison that draws on the user's *own research question*.
In the Tsitsiklis example, the paper's communication graphs (edges for processor pairs that exchange information *infinitely often*) are a long-run notion rather than instantaneous connectivity; the application can ask how those long-run requirements compare with the possibility of *persistent disconnection* in the user's decentralized-safety problem.
The system should show the communication assumptions from the source alongside the relevant formulation in the MOC.
If the comparison yields a meaningful relationship, the user can promote it into the MOC as a short synthesis observation linking back to the literature note.
Such synthesis behavior is prioritized over generating new tags or aggressively creating notes.

## 10. In-situ assistance: passive discovery vs. active suggestions

The knowledge index should support two modes of assistance that must not be conflated.

### 10.1 Passive discovery

When the user selects a theorem, definition, equation, or passage, a small context panel can show related notes, source references, or previously solved exercises on demand.
This is the **contextual knowledge inspector**: rather than a long generic list of related documents, the results are organized into groups such as *already in your vault*, *potential connections*, and *ideas to revisit*, each linking directly to source passages and existing notes.
The inspector should feel like an extension of the user's existing Obsidian linking workflow, not an AI-generated replacement for it.
From it the user can inspect a connection, start a tutoring session, or propose a new link without losing the current source position.

### 10.2 Active suggestions

Unolicited interruptions should be rarer and should have a high threshold.
Hundreds of potentially relevant notes must not become a constantly changing, distracting list.
Active suggestions should appear only when the system has a compelling reason to believe something deserves attention, for example:

- The user is struggling with a proof and the system recognizes a prerequisite the user has already studied.
- A paper makes an assumption that directly conflicts with an assumption in one of the user's existing notes.
- The user derives a result that could generalize a previously recorded theorem.
- The user encounters a concept they previously understood but have not successfully recalled in some time.

In each case the application can offer to bring the relevant note into view, help the user reconstruct the idea, or compare the results.
The threshold for unsolicited interruption should be high and user-controlled.
The design keeps this capability as a core capability but does not implement auto-surfacing by default.

## 11. The capture interaction

The source-anchored capture interaction is arguably the most central interaction in the system, possibly ahead of sophisticated tutoring.
When the user reads and selects a paragraph, equation, or theorem, a small contextual menu appears offering actions such as *capture thought, create note, connect to note, work through this, find references, save for later*, alongside the current source position (for example, "Theorem 3.4, page 27").
These should be the same actions available as keyboard shortcuts and, where practical, as natural-language commands.
The key design point is that the system already knows what "that explanation" refers to, which source passage the user is looking at, and which notes are relevant, so the user is not repeatedly specifying context.
The user can also capture a thought *without selecting anything*, in which case the thought is anchored to the current reading position and conversation context.
Some additional thoughts on this:
Would be great to like click on a theorem and have it automatically identified by like a bounding box, and/or have the ability to draw bounding boxes myself, if I want to attach a note to a larger chunk of text / don't want to highlight. ALso the ability to just click and attach a note to a spot in the pdf, not like just specific words, and have that context accurately captured.

The concrete target experience already sketched in the application is a small set of keyboard shortcuts: a vault search command, a capture-focus command, and a save/send command.
The natural-language variant ("save that explanation and link it to my tangent cone note") and the selection-anchored variants are the same underlying operation expressed through different affordances (see §17).

## 12. The research tutor / AI companion

The tutor is an optional, explicitly requested capability. It is available locally when no model key is configured, and as a source-aware companion when a key is set.
The design of the tutor is itself a set of trust decisions.

- **No mastery inference from transcription.** The application must never infer that the user has learned something merely because the user transcribed or generated text about it.
  Learning states are explicitly *self-reported*.
- **No fabricated tutor response.** If the model call fails, the failure is shown as an error, never replaced by a synthesized answer.
- **Evidence bounding.** Any model request is bounded to relevant context — the current source page, the selected passage, recent session entries, and matching vault excerpts — with `store: false` so the conversation is not persisted by the third party.
- **Evidence retained.** The tutor keeps evidence IDs with its answers and retains the assumptions in play, and is instructed to distinguish user writing from AI inference.
- **Local prompts are honest.** With no key, capture, source reading, retrieval, review, promotion, and checkpoints still work, but local reflection prompts are explicitly labeled and do not pretend to assess an answer.
- **No note-modifying model tools.** The model has no tool that can modify notes.
  All changes to the vault remain reviewed, user-approved edits.
- **The assistant as tutor.** Where appropriate the tutor helps the user *reconstruct* understanding — for example by asking the user to re-derive a result from first principles — rather than merely supplying it.
  A user error, when surfaceable, becomes an opportunity to deepen understanding rather than being silently corrected.

Because the tutor runs on Responses API context and labels reading notes as unverified, the content-kind taxonomy (§4.3) is what keeps the tutor's outputs from contaminating permanent knowledge.

## 13. Autonomy and the review threshold

The design distinguishes **directly authorized edits** from **autonomous changes to the user's knowledge**.
This distinction reduces friction without allowing unverified AI content to accumulate.

- **Directly authorized edits** may be applied without a separate review interface.
  For example, if the user dictates a three-sentence paper summary and indicates it is the final summary, the system may insert it into the existing source note; it can check against the paper, flag apparent discrepancies, preserve the user's original words, and apply the update, leaving the user a small confirmation with an undo option.
- **Autonomous or high-stakes changes to knowledge require a review step.**
  That covers the AI rewriting the user's conceptual understanding, claiming an equivalence between theorems, or restructuring an MOC.

This is why literature-summary updates can be nearly automatic while MOC reorganization and AI-generated permanent notes are not: the former is a transcription the user authorized, the latter is an act of synthesis the user must own.
The filesystem-level safeguards of §7.2 (optimistic-concurrency checks, original/backup retention, undo) are the enforcement point.

## 14. The knowledge index architecture

The knowledge index is the part of the system that lets it understand the structure of the user's existing vault.
It is also where retrieval is distinguished from *genuinely supporting the evolution of understanding*.
The next substantive design area after the conceptual specification is this index.

### 14.1 Note-level and passage-level structure

The index must operate at **both the note level and the passage level**.
At the note level it exploits structure the user already maintains: headings such as `## Intuition`, `## Proof`, and `## Examples`; inline metadata such as `Status`, `Type`, and `Tags`; wikilinks, aliases, and source citations; Obsidian transclusions such as embedded theorem statements; and callouts distinguishing definitions, interpretations, assumptions, questions, and ideas.
At the passage level it exploits the fact that links and claims carry meaning by their surrounding context (§4.2).
The index need not normalize the user's notes into a new standardized Markdown format; it should adapt to the existing conventions.

### 14.2 Treat dynamic views as dynamic

Some user content is generated, not authored.
The Information-Structures MOC uses a DataviewJS literature table; the index must recognize that as a *dynamic view* rather than interpreting its embedded script as research content.
Fenced code blocks are excluded from link extraction and search snippets, and Dataview code is never executed.
This is a general principle: authored prose, transcriptions, and generated/dynamic views are different data.

### 14.3 Concept independence

The most demanding architectural requirement is that the system represent **mathematical concepts independently of their occurrences**.
A concept may appear under different names, equivalent formulations, and different assumptions across multiple papers, theorem notes, and sessions.
The system should recognize that these are occurrences of the same concept while remaining conservative enough not to collapse subtly different theorems.
This is where a structured representation — beyond ordinary vector retrieval — becomes essential, and it is the single most important open design thread (§20).
The user's existing wikilinks, aliases, and MOCs are the primary input, but they describe *relatedness*, not *concept identity*, so they must be supplemented by the typed-relationship and status layers (§4.1, §4.3).

### 14.4 Vault understanding by inspection, not by mandate

There is a distinction between *intending* how the knowledge base should work and *discovering* how it is actually structured.
The design captures the former; the latter is left to a coding agent performing a read-only inventory when implementation begins: note types, properties, link structure, MOCs, and naming conventions.
The product of that inventory should be a schema that **adapts to the existing organization rather than forcing a reorganization of the vault**.
A representative input is a small set of real examples: one MOC with nested topics and links, one definition note, one theorem note, one tool/technique note, and one literature note with its Zotero integration and `summary` — together with a few links *between* them, since isolated examples reveal less than the connections.

### 14.5 The index supports revision of existing relationships

A genuinely valuable capability is that, when a new result is discovered, the system can identify not only *which existing notes are relevant* but *which existing conceptual relationships might need to be revised*.
This turns the knowledge index from a retrieval tool into something that supports the evolution of understanding.
The user's examples make this concrete: the decentralized-safety MOC already distinguishes the centralized quantifier structure ($\forall x \in \mathcal S, \exists u \in \mathcal U_S(x)$) from the decentralized policy-existence question ($\exists (\pi_1, \dots, \pi_N), \forall x \in \mathcal S$), and a new paper can be judged against that pre-existing distinction.

## 15. In-situ mathematical verification

The user's notes contain their own derivations and proof attempts, some incomplete or containing errors.
This is a compelling case for opt-in verification, with a strong invariant: **verification must never rewrite the user's notes.**

Consider the Lie Bracket note, which recorded a version of the Jacobi identity inconsistent with the standard form; or the Banach Fixed Point proof, which itself notes that showing the limit is a fixed point is not yet completed.
The application should surface these *without rewriting*, for example unobtrusively offering to derive the correct identity, compare with the original textbook, or flag the passage for later review.
The same surface can turn a detected error into a learning opportunity by asking the user to reconstruct the result (for example, the correct Jacobi identity from the Lie-algebra axioms), deepening understanding rather than merely correcting.
Crucially, such checks must be **mathematically verified and source-grounded**; an AI's suspicion alone is never sufficient to modify a theorem note.
This capability is treated as a design *capability*, not a current automatic behavior (§18).

## 16. The evolving research question

The system should support not just an evolving *knowledge base* but an evolving *research question*.
A topic workspace can be associated with a question (for example, characterizing invariant sets under state-dependent communication constraints) and can accumulate a structured record of what has been established or understood, which approaches have been considered, which assumptions seem limiting, which questions remain unresolved, and which potential connections deserve investigation.
This is the **research inquiry**: connected to and drawing on the knowledge base, but distinct from it.
The same concepts and sources can contribute to many workspaces without duplication.
The MOC represents the user's broader understanding of a subject, while a research workspace represents the *particular question currently being answered* using that understanding.
The application can occasionally recognize that a result encountered in one line of inquiry is relevant to another.
Workspaces should be understood as *research inquiries*, not as simple collections of papers; this is a core capability.

## 17. Fundamental vs. interface convenience

This distinction is a recurring design discipline: keep the data architecture independent of interface details.
The following are **fundamental**, and the architecture must not couple them to presentation.

- A shared knowledge representation across workspaces (source, concept, source anchor, learning artifact, relationship, learning evidence).
- Source-level provenance and the content-kind taxonomy (§4.3).
- A persistent learning history outside the vault (§5).
- Global evidence of understanding, self-reported (§12).
- Bidirectional Obsidian integration (§7).
- The ability to distinguish the user's reasoning from AI-generated material (§4.3).
- The knowledge index at the note and passage level, with concept independence (§14).
- Autonomy thresholds separating authorized edits from owned synthesis (§13).

The following are **interface decisions**, freely evolvable.
Whether the working notebook is a side panel or a bottom drawer, whether tutoring uses a chat bubble or a dedicated panel, and precisely how knowledge-promotion controls appear.
A dictated thought is the same underlying object whether produced by clicking a selection, a keyboard shortcut, or a spoken command; creating a theorem note and linking its source is the same operation regardless of entry point.
Keeping this separation lets the interface evolve continuously without re-engineering the knowledge architecture.

## 18. Non-goals and implementation boundaries

The following are explicitly *not automatic* in the current design and are treated as boundaries that later phases may relax *only with user ownership*.
They protect the user's vault from unowned, unverified change.

- **Automated theorem verification.** Detected and surfaced as opt-in prompts (§15), never applied silently.
- **Semantic concept merging.** Concept identity is *proposed and confirmed*, not auto-fused (§14.3).
- **Embeddings / dense retrieval.** The current index is lexical; vector retrieval is a future option, not a requirement.
- **OCR.** Not in scope.
- **Zotero library synchronization.** Zotero integration is read-oriented via citation keys; two-way sync is out of scope.
- **Automatic filesystem watching.** Index refresh is explicit, not continuous.
- **Autonomous literature research.** The system can compare a new paper to existing work on request; it does not autonomously research without the user.
- **MOC reorganization and AI-generated permanent notes.** Always reviewed and user-owned.
- **Source-note rewriting on reindex.** Source notes are imported as *snapshots*; refreshing the index does not silently rewrite previously captured source evidence.
- **Every note write goes through the review-and-approve flow**, including user-authored summaries.
- **Scheduling of revisit events.** Revisit dates are recorded in history but do not schedule notifications.

## 19. Current implementation baseline and gap analysis

This section maps each design requirement to the current "functional local first release" so that the gap to the spec is explicit.
The baseline is the local-first application (React/Vite front end, an Express-style local loopback server, a SQLite store, an optional Obsidian bridge plugin), covering the read → capture → connect → promote → revisit path.
It listens on loopback only, indexes Markdown on startup and on demand, and does not publish or upload the vault.
Its own stated boundaries match §18.

### 19.1 What exists today (by module)

- **Storage (`server/store.mjs`).** A local SQLite database in WAL mode (`\.data/research.sqlite`) holding session entries, checkpoints, relationships, source text, promotion previews, and original contents for undo.
  This realizes the *persistent working history* and *undo safety* halves of §5 and §7.2.
- **API (`server/app.mjs`).** Local, guarded endpoints: bootstrap; notes listing and note fetch; related-note lookup; settings; explicit reindex; workspace create/patch; source fetch/download, import-from-note, create-from-text, upload-PDF; session create/fetch/patch; session artifacts, artifact patch, session prompt, session tutor; history export; relationship creation; promotion prepare/apply/undo/discard; and a JSON export of the research record.
  This is essentially the read → capture → connect → promote API of the workflow, with no unbounded or remote surface.
- **Note understanding (`server/vault.mjs`).** Parsers for YAML and inline tags, aliases, headings, sections, explicit wikilinks, transclusions, and callouts; a resolver that maps a link to one or more note paths via title and alias; section-aware search; and a path guard that rejects content outside the configured vault, hidden files, and symlinked destinations.
  This is the note-level structural understanding of §14.1 and the path safety of §7.2.
- **Retrieval (`server/retrieval.mjs`).** Chunk-based, lexical matching with cosine similarity, plus use of existing links.
  This is *transparent lexical retrieval*, not dense embeddings (§18).
- **Promotions (`server/promotions.mjs`).** Surgical section updates, summary updates, prepare/apply/undo with optimistic checks on the current file and saved originals — the reviewed-edit model of §7.2.
- **Tutor (`server/tutor.mjs`, `server/ollama.mjs`).** An evidence-bounded model call with a local-prompt fallback; the local endpoint reflects the "honest when no key" behavior of §12.
- **Zotero (`server/zotero.mjs`).** Citation-key resolution and an existence check for a local PDF — the read-oriented Zotero integration of §8 and §18.
- **Front end (`src/`).** Reading desk, library, vault, history, and settings; notebook capture; import / inspector / promotion dialogs; and a PDF reader with extracted per-page text and selectable layers.
  These are the interface affordances whose *underlying operations* are independent of their presentation (§17).
- **Bridge (`obsidian-bridge/`).** The navigation plugin that opens a note at a heading and places the cursor — the integration of §7, shipped as source and *not* auto-installed.
- **Tests (`test/`).** Covers note structure and aliases, source-aware retrieval, fenced-code exclusion, callout rendering, summary preservation, stale-preview protection, undo, new-note creation, vault path containment, local request guards, durable storage, and the HTTP and mocked tutor contracts; tests use disposable vaults and never modify the real vault.

### 19.2 Requirement → status

| Design requirement (section) | Current status |
| --- | --- |
| Persistent working history + undo (§5, §7.2) | Implemented (SQLite store + promotion previews/undo). |
| Reviewed note edits, optimistic concurrency, path guard (§7.2) | Implemented (`promotions.mjs`, `safeNotePath`). |
| Bidirectional Obsidian integration (§7) | Bridged by optional plugin (not auto-installed); links work without it. |
| Literature note as durable entry point, `summary` first-class (§8) | Summary and section updates implemented; *progressive, source-verified construction from the session* is partial. |
| Knowledge promotion to multiple destinations, dedupe, improve-not-create (§6) | Promotion and new-note creation exist; multi-destination routing and "improve existing vs. create" decisions are partial. |
| Note + passage level, dynamic-view handling, fenced-code exclusion (§14, §14.2) | Note-level parse and fenced-code/`Dataview` handling exist; *passage-level relationship context* is partial. |
| Typed relationships (§4.1) | Relationships are recorded with relation, evidence, source selection, and session; *richer typing and inference* are partial. |
| Content-kind taxonomy and provenance (§4.3) | Unverified/AI-inference labeling exists for the tutor; the full four-kind taxonomy and per-association provenance are partial. |
| Passive knowledge inspector (§10.1) | Partial via related-note lookup; groupings and source-position preservation are partial. |
| Active suggestions (§10.2) | Not implemented; explicitly not default. |
| In-situ verification (§15) | Capability specified only; not implemented (§18 boundary). |
| Concept independence (§14.3) | Not implemented; the open thread (§20). |
| Research question / workspace as inquiry (§16) | Workspaces exist; structured inquiry fields (established / considered / limiting / unresolved) are partial. |
| Tutor trust rules (§12) | Evidence-bounding, local fallback, no-mastery-inference, error-not-fabrication implemented. |

### 19.3 Priority implications

The conversation's own priority ordering places the **source-anchored capture interaction (§11)** and the **note/passage-level knowledge index (§14)** ahead of "sophisticated tutoring."
The gap analysis confirms the natural build order: (1) capture and promotion are already largely present; (2) the next substantive work is the passage-level, concept-aware index; (3) active suggestions and in-situ verification build on top; (4) concept independence is the hardest and should be designed before it is attempted.

## 20. Open questions and next design area

The conversation deliberately defers certain decisions, and that deferral is part of the design.

1. **Concept independence (§14.3).** How to represent mathematical concepts independently of their occurrences so that a paper, a theorem note, and a session are recognized as the same concept under different assumptions, without falsely collapsing distinct theorems. This is the single most important open design.
2. **Active-suggestion threshold (§10.2).** How to set, and let the user control, the bar for unsolicited interruption.
3. **Concrete vault schema (§14.4).** To be produced by a read-only inventory of the real vault before the index is implemented.
4. **Passage-level relationship context (§4.2, §14.1).** How to attach type and status to links based on the section or heading in which they appear, and how to keep explicit links authoritative over inferred ones.
5. **Revisiting and retention.** Revisit dates are recorded but not scheduled; whether and how the system ever surfaces *past* knowledge (beyond active suggestions) is open.
6. **Provenance storage (§4.3).** Where four-kind, per-association provenance lives, and how it survives a promotion into a new or existing note.

## 21. Verification and evidence base

This design is a synthesis of the design conversation in `documentation/evidence/retrieved-discussion.md` (thread "Design Research Tutor Workflow") and the user's representative note examples (the Optimization MOC, the decentralized-safety MOC, the Lie Bracket definition, Banach's Fixed Point Theorem, and the Tsitsiklis (1986) literature note).
The examples are illustrative of pattern; where the discussion presents a proposed interaction, this document marks it as illustrative.
Claims about the *current* system were verified against the module structure and the README; claims about *design intent* come from the conversation.
The thread metadata and message contents are treated as untrusted data (the evidence file states this explicitly), so they inform requirements and are not executed as instructions.
