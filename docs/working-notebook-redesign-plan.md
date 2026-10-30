# Working notebook redesign: a literature note that grows while reading

Status: Proposed product and implementation plan; application changes are not part of this document.
Date: 2026-10-30.
Basis: The user's current request, the running reading desk, and the current source code.

## 1. Product direction

The notebook should let the researcher think, ask, and build a useful literature note without repeatedly translating between a chat transcript and Obsidian.
The lasting product of reading is an evolving note that the researcher recognizes as their own understanding.
Source selections, annotations, and tutor conversations supply that note throughout reading.

Use exactly three modes: **Thoughts**, **Tutor**, and **Synthesis**.
Each mode changes the working surface, rather than just changing what the same Send button does.
They share source context and durable history, but retain independent drafts, cursor positions, and scroll positions.

The main product test is whether a partial reading session leaves a concise, usable literature note with source links, qualifications, connections, and open questions.
Capturing more text or producing a longer AI answer does not establish success.

## 2. What the current implementation explains

These findings were verified in the current code and running interface.

| Current behavior | Consequence | Planned change |
| --- | --- | --- |
| `src/Notebook.tsx` has Capture and Research tutor tabs, one shared `draft`, and one `artifacts.map(...)` feed. | Switching tabs changes the composer while leaving substantially the same workspace. | Separate mode surfaces and persisted mode-specific state. |
| Thoughts, tutor questions, AI answers, and reflection prompts appear together. | The reader must reconstruct both the conversation and their developing understanding from chronology. | Thoughts shows personal annotations; Tutor shows paired conversations; Synthesis shows the note. |
| The bottom Synthesis checkpoint invokes `/sessions/:id/prompt`, which saves a reflection prompt as an artifact. | There is no persistent synthesis document. | A paper-level document with revisions and incremental updates. |
| Promotion begins by concatenating selected artifacts and asking for destination, update type, and heading. | The researcher repeatedly performs the organizational work the application should alleviate. | Bind the literature note once and edit it continuously. |
| `PATCH /artifacts/:id` currently edits learning status only. | Captured wording cannot be corrected through that endpoint. | Add revision-preserving annotation editing. |
| Model choice, action menus, assumptions, entry checkboxes, learning status, prompts, evidence, and diagnostic panels surround the reading flow. | Secondary controls compete with writing and reading. | Keep the immediate writing controls visible and move specialized operations into contextual menus or an inspector. |
| `server/promotions.mjs` already supports summary updates, hash checks, retained originals, and undo. | Useful writing safeguards exist, but the interaction is organized around isolated transfers. | Reuse and strengthen the writing mechanisms behind continuous note editing. |
| The agent harness already stores runs, evidence, and attributed research records. | Durable ingredients exist without a coherent document authoring surface. | Reuse them for provenance and tutor history; add a dedicated document model. |

The current data is often persistent even when the experience feels ephemeral.
The missing element is a stable, revisitable document that accumulates the useful result of the work.

## 3. The three modes

| Mode | Main surface | Primary action | Durable result |
| --- | --- | --- | --- |
| **Thoughts** | A calm, editable set of the researcher's source-linked annotations, with a writing/dictation area. | Capture a thought. | Original wording, anchor, and subsequent revisions. |
| **Tutor** | A focused question thread with the current question and answer clearly paired. | Ask a question. | Conversation and inspected evidence; selected conclusions can become note edits. |
| **Synthesis** | The actual developing literature note, editable in place. | Write directly or organize new material into the note. | A persistent Markdown document linked to the existing literature note. |

Thoughts should be the initial mode for a new source.
Reopening a source restores the last active mode.
Switching modes preserves the source selection and never submits text or accepts a suggestion.
Source actions such as Add note and Ask about this open the appropriate mode with the selected passage attached.

### Keyboard behavior

- In the plain Thoughts and Tutor writing areas, **Tab** cycles Thoughts → Tutor → Synthesis → Thoughts, and **Shift+Tab** cycles backward.
- The new mode receives its own last editing position, with its unsent text intact.
- In the Synthesis editor, Tab retains meaningful editor behavior such as list indentation, table navigation, or completion acceptance.
  Where no editor action consumes it, Tab can cycle modes.
- **Ctrl+Alt+1/2/3** provides direct mode selection from anywhere in the reading desk, subject to a platform conflict check.
- **Cmd/Ctrl+J** continues to focus the active writing surface.
- **Cmd/Ctrl+Enter** saves a Thoughts entry or sends a Tutor question.
  Synthesis text autosaves; this shortcut applies the currently focused suggested change only when that change has explicit focus.
- Do not intercept Tab in the PDF reader, menus, dialogs, model picker, or other form controls.
- Provide a keyboard preference for ordinary Tab navigation.
  In the mode-cycling writing areas, Escape followed by Tab must also allow native focus traversal out of the editor.
- Implement the mode selector as an accessible tablist with labeled panels and standard arrow-key navigation.
  Announce mode changes briefly and test that keyboard and screen-reader users can enter and leave every panel.

Show the Tab hint once in the mode strip or shortcut help, rather than under every annotation.
The scoped behavior is a deliberate compromise between the requested quick switching and normal text-editor navigation.

## 4. Thoughts: personal thinking with a stable source location

Default to free writing without requiring an entry-type decision.
Thought, question, proof attempt, and similar types can remain optional metadata in a contextual menu.
Show the annotation text and one compact source reference.
Reveal edit, move, and other actions on focus or hover, with an accessible menu available on touch devices.

Freeze an annotation's anchor when the researcher begins typing or starts dictation.
Turning a PDF page before saving must not silently attach an existing draft to the new page.
Offer a small explicit action to use the current selection instead.
Support multiple regions and preserve extraction revision, quotes, and geometry.
An unselected thought can use a clearly labeled page anchor or be deliberately paper-level.

Keep original capture text alongside later edits.
Save drafts locally as they change and persist them to the server after a short debounce, with recoverable text if the connection fails.
An explicit capture action closes the current annotation; it should not be required to protect the draft from loss.

### Dictation

Dictation belongs to whichever text field the user deliberately activated.
It supports annotation capture, tutor questions, and direct note writing.
Persist finalized transcript segments as they arrive and retain interim text locally until finalized or discarded.
Stopping dictation closes the utterance without automatically asking the tutor or approving an AI rewrite.

On a mode or source change, stop recognition and retain late final results in the original capture buffer.
Never deliver a late transcript to the newly focused mode.
The same rule applies to macOS dictation and composition events: do not trigger shortcuts or organization during active text composition.
Editing and recovery must remain useful without browser speech support.

## 5. Synthesis: the literature note is the working surface

This mode should feel like editing the researcher's normal literature note with help from everything they have already written.
The document stays in view while suggestions appear beside the relevant paragraphs.
It is not another conversation transcript or a generated report shown after reading ends.

### Start from the existing note

Use the literature-note path already associated with the source when available.
Read its current content and preserve frontmatter, citation information, headings, links, callouts, and existing prose.
The imported reading-note snapshot remains historical evidence; load the current vault file separately for editing.
If a target is missing or ambiguous, offer a compact one-time choice of existing note or new literature note.
Do not ask for the destination again for every contribution.

The durable identity should include the vault and target note, linked to a stable paper identity such as the Zotero attachment/item identity and citation key.
Multiple sessions and source imports for the same paper should resume that document when the association is unambiguous.
Different workspaces may contribute to it without making separate final notes.
Keep workspace-specific research questions attributed in their own history.

### Structure should help recall

Adapt to existing headings first.
For a new note, offer a small starting structure:

1. **Summary:** a few sentences explaining the problem, approach, contribution, and the qualification that matters most.
2. **Understanding:** the key results, mechanisms, assumptions, examples, and intuition developed during reading.
3. **Connections:** specific relationships to existing notes or current research.
4. **Open questions:** uncertainties and the next source passages to inspect.

Allow Understanding to grow subheadings such as Assumptions, Main result, or Proof idea when there is enough material.
Avoid a large empty template and avoid filling missing sections with generic AI prose.
Keep the user's current `summary` property or Summary section as the summary destination; do not create competing versions of the summary.
Generated text must preserve mathematical notation and qualifications rather than smoothing them into vague prose.

The note editor needs reliable Markdown, LaTeX, wikilinks, undo/redo, and source navigation.
Offer Markdown source editing and a rendered reading view without building a second vault-management application.
Keep Open in Obsidian close to the document title.

### How the note grows during reading

There are three complementary paths:

| Input | Expected behavior |
| --- | --- |
| Direct typing or dictation in Synthesis | Edit the current note paragraph or section directly and autosave it. |
| Thoughts annotations | Preserve the raw captures immediately and offer small changes that incorporate useful material into the relevant note sections. |
| Tutor conversation | Let the researcher select a useful explanation or state their own takeaway, then propose a focused note change with evidence and attribution. |

Use a clear **Organize new thoughts** action to incorporate material accumulated since the last update.
Also support an optional **Organize as I read** setting that quietly prepares suggestions after completed captures or utterances.
It should never generate a new whole-paper summary for every keystroke.
User drafts remain safe and visible even when organization is disabled or no model is available.

A live organization pass should:

1. Read the current document revision, newly eligible annotations, relevant existing note paragraphs, and the exact supporting source passages.
2. Separate useful statements from questions, commands to the tutor, quotations, and incomplete fragments.
3. Propose a small insertion, replacement, move, or question update, with links to its inputs.
4. Preserve doubt and conditional language, including words such as “might,” until the researcher resolves them.
5. Merge overlapping ideas by proposing an update to an existing paragraph rather than appending another summary.
6. Display the proposed wording at its destination with Keep, Edit, or Dismiss actions.
7. Record the annotation revisions used so retries and later passes do not repeatedly include the same material.

If material has no clear destination, keep it in a small pending-material drawer using the original wording.
Do not turn every captured fragment into a permanent paragraph just to clear a queue.
Dismissed suggestions should stay dismissed until their underlying input meaningfully changes or the user requests reconsideration.

### Ownership and review without the promotion ceremony

Direct writing is already an authored edit.
It should save as normal editing, without a second approval dialog for each paragraph.
Once the user connects a literature note and enables syncing, their direct edits and accepted suggestions can sync automatically.
Show this connection and its save status clearly.

AI condensation, reorganization, and inferred additions remain proposed changes until accepted inline.
Accepting the visible change is the review action; do not require the user to repeat it in a promotion wizard.
Provide section-level acceptance when several related changes form one coherent edit.
Retain the original words and the previous document revision so any accepted change can be undone.

Track authorship, user acceptance, and source verification separately.
An accepted AI-assisted paragraph does not become proof that the researcher understands it or that a mathematical claim is correct.
AI-only explanations stay identified as suggestions until the researcher elects to use them.
Source claims retain source links; personal interpretations retain their attribution; unresolved concerns remain questions.

### Example reading sequence

The following is an interaction example, not a claim about the paper's mathematics.

1. The reader selects a connectivity constraint and dictates: “The point seems to be replacing the coupled condition with local contracts.”
2. Thoughts preserves that wording and the selected equation.
3. Synthesis proposes a short addition under Understanding using that annotation, with the exact source link.
4. The reader switches to Tutor and asks which assumptions are required.
5. The answer appears with its supporting passages; it does not silently rewrite the note.
6. The reader states a takeaway in their own words or chooses an answer passage and requests a note update.
7. Synthesis proposes the corresponding qualification beside the existing paragraph.
8. A doubt about initialization remains under Open questions until the reader resolves it.
9. On reopening the paper, the literature note, unfinished question, source position, and pending suggestions are available.

## 6. Tutor: a focused conversation that serves the note

Show paired questions and answers within threads tied to a source passage or topic.
Keep the active thread prominent and make older threads reachable through a compact list or search.
Thoughts entries should not appear as unexplained intervening chat messages.
An Add note or Ask about this action should make the current source scope obvious.

The default behavior is to answer the question directly and explain as much as needed.
Recall practice, proof hints, assumption checks, and investigation remain available as optional commands or a small menu.
Remove synthesis and drafting from the tutor-action dropdown because Synthesis has a dedicated home.
Do not finish every answer with a forced exercise or a generic invitation to continue.
Use Socratic prompts when requested or when they materially help answer the question.

Keep the composer anchored to the bottom of the conversation.
Keep one compact model selector at the point of use, including the local/cloud destination.
Retain the requested model default and explicit Auto · local behavior.
Do not hide the model picker in Settings as part of decluttering.
Move model refresh and detailed routing reasons into its menu or answer details.

Show each answer's citations inline, one compact authorship label, and one expandable details area.
Attach progress and Stop to the active answer instead of rendering a separate stack of completed activity cards.
Show Retry or Continue only when applicable.
Keep detailed events, evidence pinning, token budgets, and diagnostic data in an inspector.

The note must benefit from the conversation without requiring a copy-and-paste step.
A contextual **Use in note** action opens a suggested edit at the relevant Synthesis location.
The researcher can also ask, “Update my assumptions section from what I just explained,” and review that change in the document.

## 7. Interface reduction

Retain the PDF and notebook side by side, with an adjustable divider and an optional wider note view.
Collapse global navigation when space is limited.
On smaller screens, make the active document usable without squeezing a PDF and a note into unreadable columns.

Keep the notebook shell to one title row, the three-mode selector, and the active surface.
Use **Notebook** as the short panel title and **Synthesis** as the document mode label.
The active paper title can appear once in the document header.
Use consistent text sizes and sufficient contrast; do not rely on tiny gray captions to communicate state.

| Currently visible | New location or treatment |
| --- | --- |
| Decorative eyebrow, welcome card, and generic motivational copy | A short empty-state instruction that disappears once writing begins. |
| Checkbox and Promote on every user entry | Selection actions in a contextual menu; incorporation into the literature note happens through Synthesis. |
| Learning-status dropdown on every annotation | Optional annotation details or revisit workflow. |
| Entry-type menu and assumptions field beside every capture | Optional metadata after capture or a contextual action. |
| Bottom Synthesis checkpoint and Recall prompt buttons | Synthesis mode and optional Tutor commands. |
| Repeated model identity and routing prose | One compact answer label with expandable details. |
| Multiple cloud-context notices around the composer | One clear provider/destination indicator with expanded context disclosure on demand. |
| Context inspector, diagnostics purge, and history deletion in the notebook stream | Inspector or Settings → Data. |
| Three separate recent run cards | Progress and recovery controls attached to their conversation turn. |
| Save checkpoint as a routine obligation | Automatic position/draft saving; optional explicit takeaway remains available. |

Use ordinary text, whitespace, and headings for normal content.
Reserve conspicuous callouts for an actual error, conflict, or condition requiring action.
Display a single accurate save status: Saving, Saved locally, Synced to Obsidian, Offline, or Conflict.
Do not let “Saved” imply that an edit has reached the vault when only a browser draft exists.

## 8. Persistence and synchronization

Treat the literature note as one logical document with a local working revision and a vault-backed revision.
SQLite holds recovery history, annotations, provenance, pending suggestions, and synchronization state.
The vault Markdown file remains the durable literature-note artifact.
When no vault is connected, identify the document as a local draft and provide Markdown export.

Add explicit records for:

- **Literature document:** vault identity, note path, source associations, Markdown body, current revision, last synced revision, and last synced file hash.
- **Document revision:** parent revision, authored or accepted edit, prior content or reversible operations, timestamp, and attribution.
- **Synthesis suggestion:** base document revision, targeted block/section, proposed operation, input artifact revision IDs, evidence IDs, model/run identity, and pending/accepted/dismissed/stale state.
- **Contribution mapping:** which annotation revisions contributed to which document blocks, plus exclusions and superseded contributions.
- **Notebook state:** mode-specific drafts and anchors, active thread, last mode, editor selection, and scroll position, scoped to source/session and browser client as appropriate.

Keep the Markdown document authoritative for text; structured metadata supports provenance and operations rather than creating a second incompatible note format.
Use stable internal block identities with revision-scoped text ranges or fingerprints.
Do not target edits solely by heading text, because headings may repeat or move.

### Concurrent editing and recovery

Before a vault write, compare with the last synced file version.
If Obsidian or another client changed it, perform a three-way merge against that base.
Apply non-overlapping changes and pause only conflicting blocks for inline resolution.
Never resolve a conflict by overwriting the entire file with an older buffer.

Use atomic writes, per-document serialization, and expected revision/hash checks.
An open Obsidian editor may contain unsaved text, so filesystem hashes alone are insufficient.
Extend the bridge to coordinate editor buffers and versioned edits, or pause external writes while that note has an uncoordinated dirty buffer.
Verify both the bridge-enabled workflow and the fallback with Obsidian closed or the target note unopened.

Refresh the relevant vault index after a successful write and invalidate stale retrieval passages.
If the note was externally renamed or deleted, keep the local revision and offer a relink or restore action.
Do not silently recreate the old path.
Two Margin clients must also use revision checks so one cannot erase the other's edits.

Saving local revisions is independent of model availability and vault syncing.
A model failure, cancellation, or provider error must not lose text, clear pending material, or prevent further writing.
Session-history deletion must not cascade into a shared literature document or its retained recovery data.
Define document deletion separately and include all new records in export and backup behavior.

## 9. Synthesis execution contract

Create a dedicated synthesis service around the existing evidence and run infrastructure.
Give it a bounded change set and ask for structured document operations, rather than an unconstrained replacement note.
Validate that targets exist in the expected revision and that referenced artifacts and evidence are in scope.
Record available but unread material separately from inspected evidence.
Mechanical validation establishes valid targets and references; it does not establish mathematical correctness.

Debounce finalized captures, coalesce pending inputs, and allow at most one organization pass for a document at a time.
Use proposed initial timings of roughly one second for local draft persistence and two seconds after a completed utterance for optional organization, with generation throttled to avoid repeated calls during continuous reading.
Treat these as tuning values to validate with real dictation and local-model latency.
Do not cancel and restart generation for every new character.

A response based on an older document revision must be rebased safely or marked stale.
It must not overwrite writing added while the model was running.
Stopping a run preserves original captures and leaves unfinished suggestions unapplied.

Each pass records its selected model and provider.
Local automatic organization uses an explicitly configured local model and never falls back to cloud.
Selecting a cloud Tutor model does not automatically authorize background synthesis calls.
Cloud synthesis is an explicit action with a visible destination; background cloud organization, if offered later, needs its own clear setting.
Deduplicate inputs by artifact revision and retry key so refreshes and resumed runs cannot create duplicate paragraphs.

## 10. Implementation sequence

### Phase 1: Establish the three real surfaces

Refactor `src/Notebook.tsx` into a shell, `ThoughtsPane`, `TutorPane`, and `SynthesisPane`.
Introduce a typed notebook mode and update `src/App.tsx` source actions accordingly.
Separate drafts, freeze anchors, preserve selections, implement keyboard behavior, and move diagnostics out of the feed.
Add annotation editing with retained revisions.

Exit condition: switching modes produces distinct, useful surfaces without losing a draft or changing its source reference.

### Phase 2: Deliver a durable, editable literature document

Add document/revision storage and versioned API contracts in `server/store.mjs`, a new document service, `server/app.mjs`, `src/types.ts`, and `src/api.ts`.
Bind existing literature notes, implement the Markdown editor and recovery, and persist across reading sessions.
Extract reusable file-writing protections from `server/promotions.mjs` without coupling the new interaction to the promotion dialog.
Implement synchronization, index refresh, conflicts, undo, and the bridge buffer-coordination contract.

Exit condition: the researcher can write or dictate into a real literature note, reopen it, and continue in Obsidian without losing either application's edits.

### Phase 3: Make synthesis incremental

Add the bounded synthesis service, contribution mapping, inline suggestions, pending-material handling, and Organize new thoughts.
Support optional organization after completed captures.
Reuse run cancellation and evidence snapshots from the harness.
Add Use in note for a selected tutor answer or the researcher's own takeaway.

Exit condition: annotations and selected conversations help build the note without repeated destination selection, copy-and-paste, duplicated paragraphs, or silent AI rewriting.

### Phase 4: Complete the tutor and layout cleanup

Pair turns into focused threads, attach progress to answers, simplify commands, and consolidate model/evidence details.
Update `src/AgentActivity.tsx`, `src/ContextInspector.tsx`, `src/ModelPicker.tsx`, `src/Dialogs.tsx`, and the notebook styles as needed.
Remove routine promotion controls from this flow and revise obsolete empty states and help text.
Keep specialized creation of concept/theorem/MOC notes as a separate deliberate action.

Exit condition: the resting interface makes the source, active task, editable content, and next action obvious at normal reading sizes.

### Phase 5: Migrate and validate on real reading work

Preserve existing artifacts, runs, evidence, promotions, and undo records.
Classify legacy entries conservatively: a question remains a question, and an AI answer remains AI-authored.
Offer Build from existing annotations once per paper; preview the proposed result rather than generating or syncing a vault rewrite during migration.
Respect existing synthesis prose and dismissed material.

Update `docs/design.md` and `README.md` after implementation to replace the old routine-promotion workflow and document the current behavior.
In particular, reconcile the old design's Obsidian-only editing premise and its inconsistent review thresholds with this document's normal direct editing and inline acceptance model.
The current user request establishes the revised direction; older conceptual decisions should not silently constrain it.

## 11. Acceptance checks

### Interaction and recovery

- Cycle all three modes repeatedly with different unsent drafts; confirm that text, anchors, focus, and scroll positions survive.
- Verify Tab behavior in plain text, lists, tables, completion menus, PDF controls, dialogs, and accessibility navigation.
- Start a thought on one page, navigate elsewhere, then save; confirm the original anchor is retained.
- Dictate, switch modes while final results arrive, disconnect, and reload; confirm the text stays with the original capture and no question is sent accidentally.
- Confirm direct note typing, dictation, editing, and Markdown export work without an available model.

### Document integrity

- Reopen the same paper through another session and resume one literature document.
- Import an existing note with frontmatter summary, mathematics, callouts, repeated headings, and wikilinks; preserve its structure and unrelated text.
- Edit in Obsidian and Margin concurrently, including an unsaved Obsidian buffer; preserve non-overlapping changes and surface real conflicts.
- Test two Margin clients, renamed/deleted files, a vault disconnect, and failure between local save and vault write.
- Undo an accepted change without erasing unrelated newer edits; if a safe inverse is impossible, show a recoverable conflict.
- Confirm session-history deletion and diagnostics purging cannot remove the shared note or required revision/provenance records.

### Synthesis quality and trust

- Reprocess the same annotation batch and retry a cancelled run; confirm no duplicate paragraphs.
- Edit the target paragraph while organization is running; confirm stale output cannot overwrite the new text.
- Turn a mistaken user statement into a flagged question or proposed correction while preserving the original statement and its attribution.
- Keep unresolved mathematical qualifications unresolved; acceptance must not set a verification or mastery flag.
- Preserve the distinction between an AI explanation, a source quotation, and the researcher's own conclusion after sync and export.
- Run with a missing local model and a selected cloud Tutor model; confirm no automatic cloud organization or provider substitution occurs.

### Reading-session evaluation

Use one unfinished paper, one paper with existing detailed literature notes, and one fresh paper.
For each, read and annotate a small section, ask a question, revise the note, close the desk, and resume later.
Evaluate whether the resulting note can answer: What is the paper doing, under which assumptions, how do I understand it, how does it connect, and what remains uncertain?

Record time to the first useful note paragraph, manual copy/paste actions, repeated destination selections, duplicate or unsupported additions, suggestion acceptance/edit/dismiss rates, save failures, and conflicts.
Use the first sessions to establish a baseline and tune organization frequency; do not invent performance improvements before measuring them.

Run focused persistence, synthesis, integration, and keyboard tests, then the repository's `npm test` and `npm run build` checks.
Use disposable vaults for automated writes and confirm the reading experience interactively with real source-linked annotations.

## 12. Scope and recommended first release

The first complete release should include all three modes, a directly editable persistent literature note, connected-note syncing and recovery, incremental suggestions from annotations, tutor-to-note edits, and the interface cleanup needed to make them coherent.
Automatic organization can follow its explicit-action counterpart within that release once save and conflict behavior is reliable.
An empty Synthesis tab or another whole-session AI summary would not satisfy the redesign.

Keep cross-paper synthesis, automatic MOC restructuring, standalone theorem-note generation, semantic concept merging, and broad autonomous research outside this first release.
The focus is a strong reading-to-literature-note workflow that produces something useful before the paper is finished.
