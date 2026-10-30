import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import {
  Documents,
  artifactRevision,
  documentBlocks,
} from "../server/documents.mjs";
import { mergeMarkdown } from "../server/document-merge.mjs";
import { Synthesis } from "../server/synthesis.mjs";
import {
  nextNotebookMode,
  freezeDraft,
  synthesisTabAction,
  tutorThreads,
} from "../src/notebook-state.mjs";

function fixture(
  t,
  markdown = "---\nsummary: keep this\ntags: [literature_note]\n---\n# Paper\n\n## Understanding\n\nOriginal $x^2$.\n\n## Proof\n\n> [!note] Keep [[Other]].\n",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "margin-notebook-")));
  writeFileSync(join(root, "Paper.md"), markdown);
  const store = new Store(join(root, "records.sqlite"));
  const source = store.put("source", {
    title: "Paper",
    citekey: "paper-key",
    notePath: "Paper.md",
    kind: "pdf",
    pages: [
      "The result holds under Assumption A.",
      "Proof with an unresolved qualification.",
    ],
  });
  const workspace = store.put("workspace", {
    title: "Research",
    question: "Which assumptions?",
  });
  const session = store.put("session", {
    workspaceId: workspace.id,
    sourceId: source.id,
    page: 1,
  });
  const written = [];
  const documents = new Documents({
    store,
    getVault: () => ({ root }),
    onWritten: async (path) => written.push(path),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, source, session, workspace, documents, written };
}
async function connected(f) {
  const doc = await f.documents.forSource(f.source);
  return f.documents.bind(doc.id, {
    expectedRevision: doc.revision,
    path: "Paper.md",
    create: false,
    syncEnabled: true,
    syncMethod: "closed-note",
  });
}
function thought(f, text = "This might require Assumption A.") {
  return f.store.put("artifact", {
    sessionId: f.session.id,
    text,
    origin: "user",
    kind: "thought",
    status: "open",
    revision: 0,
    anchor: {
      sourceId: f.source.id,
      page: 1,
      quote: "The result holds under Assumption A.",
    },
    createdAt: new Date().toISOString(),
  });
}
function synthesis(f, answer) {
  const calls = [];
  const service = new Synthesis({
    documents: f.documents,
    store: f.store,
    getModels: () => [
      {
        name: "qwen3.8:27b-q4_K_M",
        cloud: false,
        capabilities: ["completion"],
      },
    ],
    getSource: (id) => f.store.get("source", id),
    port: 4318,
    apiKey: "test-secret",
    fetchImpl: async () => {
      throw new Error("unexpected cloud request");
    },
    ollama: {
      request: async (path, body, timeout, signal) => {
        calls.push(body);
        return answer(body, signal);
      },
    },
  });
  return { service, calls };
}
async function finished(service, store, run) {
  const deadline = Date.now() + 2000;
  while (store.get("synthesisRun", run.id).status === "running") {
    assert.ok(Date.now() < deadline, "organization should finish");
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.get("synthesisRun", run.id);
}
const request = (overrides = {}) => ({
  retryKey: crypto.randomUUID(),
  artifactIds: [],
  cloud: false,
  background: false,
  reconsider: false,
  ...overrides,
});
function proposed(body) {
  const context = JSON.parse(body.messages[1].content);
  const target =
    context.blocks.find((b) => b.text.includes("Original")) ||
    context.blocks.at(-1);
  return {
    message: {
      content: JSON.stringify({
        changes: [
          {
            blockId: target.id,
            operation: "replace",
            text: `This might require Assumption A. {{cite:${context.inspectedEvidence[0].id}}}`,
            artifactRevisionIds: [context.inputs[0].artifactRevisionId],
            evidenceIds: [context.inspectedEvidence[0].id],
            rationale:
              "Preserve the qualification next to the existing interpretation.",
          },
        ],
        pending: [],
      }),
    },
  };
}

test("keyboard cycle, frozen multi-region anchors, editor indentation and table navigation", () => {
  assert.equal(nextNotebookMode("thoughts"), "tutor");
  assert.equal(nextNotebookMode("tutor"), "synthesis");
  assert.equal(nextNotebookMode("synthesis"), "thoughts");
  assert.equal(nextNotebookMode("thoughts", true), "synthesis");
  const anchor = {
    sourceId: "paper",
    page: 1,
    quote: "first",
    regions: [
      {
        regionId: "r1",
        page: 1,
        quote: "first",
        revision: "v1",
        box: [0, 0, 0.5, 0.5],
      },
      { regionId: "r2", page: 2, quote: "second" },
    ],
  };
  const draft = freezeDraft(
    { text: "", anchor: null, start: 0, end: 0, scroll: 19, interim: "" },
    "My thought",
    anchor,
  );
  anchor.page = 2;
  anchor.regions[0].quote = "changed";
  const next = freezeDraft(draft, "My thought continues", {
    sourceId: "paper",
    page: 8,
    quote: "",
  });
  assert.equal(next.anchor.page, 1);
  assert.equal(next.anchor.regions[0].quote, "first");
  assert.equal(next.scroll, 19);
  assert.deepEqual(synthesisTabAction("- claim", 7, 7), {
    text: "  - claim",
    start: 9,
    end: 9,
  });
  assert.deepEqual(synthesisTabAction("  - claim", 9, 9, true), {
    text: "- claim",
    start: 7,
    end: 7,
  });
  assert.equal(synthesisTabAction("ordinary paragraph", 0, 0), null);
  assert.equal(synthesisTabAction("| a | b |", 2, 2).start, 5);
});
test("legacy questions and AI answers stay paired without intervening thoughts", () => {
  const threads = tutorThreads([
    { id: "q", origin: "user", kind: "question", text: "Why?" },
    { id: "t", origin: "user", kind: "thought", text: "Possibly A" },
    { id: "a", origin: "ai", kind: "tutor", text: "Because A" },
    {
      id: "qt",
      origin: "user",
      kind: "question",
      surface: "thoughts",
      text: "My open question",
    },
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].answers[0].id, "a");
});
test("three-way merge preserves independent changes, exact line endings, and reports overlapping blocks", () => {
  const base = "a\r\n\r\nb\r\n\r\nc\r\n";
  const merged = mergeMarkdown(
    base,
    base.replace("a", "local"),
    base.replace("c", "remote"),
  );
  assert.equal(merged.text, "local\r\n\r\nb\r\n\r\nremote\r\n");
  assert.deepEqual(merged.conflicts, []);
  const conflict = mergeMarkdown(
    base,
    base.replace("b", "local"),
    base.replace("b", "external").replace("c", "new elsewhere"),
  );
  assert.equal(conflict.conflicts.length, 1);
  assert.match(conflict.text, /new elsewhere/);
  const block = conflict.conflicts[0];
  assert.equal(conflict.text.slice(block.start, block.end), block.local);
  assert.equal(block.remote, "external\r\n");
});
test("parallel imports and another session resume one current note with frontmatter, math, callouts and repeated headings intact", async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, "Paper.md"), "utf8");
  const docs = await Promise.all([
    f.documents.forSource(f.source),
    f.documents.forSource(f.source),
  ]);
  assert.equal(docs[0].id, docs[1].id);
  assert.equal(docs[0].markdown, before);
  const duplicate = f.store.put("source", {
    ...f.source,
    id: "second-import",
    notePath: "Different-name.md",
    pages: ["a historical snapshot"],
  });
  const resumed = await f.documents.forSource(duplicate);
  assert.equal(resumed.id, docs[0].id);
  assert.equal(resumed.markdown, before);
  const blocks = documentBlocks("## Proof\n\nFirst\n\n## Proof\n\nSecond", 7);
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length);
});
test("local saves persist without a model and reject a second client overwriting a newer revision", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source);
  const saved = await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown + "\nMy own conclusion.\n",
  );
  assert.equal(saved.revision, 1);
  await assert.rejects(
    f.documents.save(doc.id, 0, "stale client"),
    (e) => e.status === 409 && e.current.revision === 1,
  );
  const reopened = new Store(f.store.filename);
  assert.equal(
    reopened.get("literatureDocument", doc.id).markdown,
    saved.markdown,
  );
  reopened.close();
  assert.equal(
    readFileSync(join(f.root, "Paper.md"), "utf8"),
    doc.markdown,
    "sync is opt-in",
  );
});
test("sync merges external changes, refreshes the note index, and protects a renamed or deleted note", async (t) => {
  const f = fixture(t);
  let doc = await connected(f);
  await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown.replace("Original", "My interpretation of the original"),
  );
  writeFileSync(
    join(f.root, "Paper.md"),
    doc.markdown.replace("Keep [[Other]]", "External [[Other]]"),
  );
  doc = await f.documents.sync(doc.id);
  assert.equal(doc.syncStatus, "synced");
  const text = readFileSync(join(f.root, "Paper.md"), "utf8");
  assert.match(text, /My interpretation/);
  assert.match(text, /External/);
  assert.deepEqual(f.written, ["Paper.md"]);
  renameSync(join(f.root, "Paper.md"), join(f.root, "Renamed.md"));
  doc = await f.documents.sync(doc.id);
  assert.notEqual(doc.syncStatus, "synced");
  assert.match(doc.syncError, /renamed|deleted|ENOENT/);
  assert.match(doc.markdown, /My interpretation/);
});
test("overlapping external edits resolve inline without losing unrelated remote changes", async (t) => {
  const f = fixture(t);
  let doc = await connected(f);
  await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown.replace("Original $x^2$.", "Local $x^2$."),
  );
  writeFileSync(
    join(f.root, "Paper.md"),
    doc.markdown
      .replace("Original $x^2$.", "Remote $x^2$.")
      .replace("Keep [[Other]]", "New unrelated text"),
  );
  doc = await f.documents.sync(doc.id);
  assert.equal(doc.syncStatus, "conflict");
  assert.equal(doc.conflict.conflicts.length, 1);
  assert.match(doc.markdown, /New unrelated/);
  const c = doc.conflict.conflicts[0];
  doc = await f.documents.resolve(doc.id, {
    expectedRevision: doc.revision,
    externalHash: doc.conflict.externalHash,
    markdown:
      doc.conflict.text.slice(0, c.start) +
      "Resolved qualification.\n" +
      doc.conflict.text.slice(c.end),
  });
  assert.equal(doc.syncStatus, "synced");
  assert.match(doc.markdown, /Resolved qualification/);
  assert.match(doc.markdown, /New unrelated/);
});
test("undo preserves unrelated newer edits and rejects an unsafe inverse", async (t) => {
  const f = fixture(t);
  let doc = await f.documents.forSource(f.source);
  doc = await f.documents.save(
    doc.id,
    0,
    doc.markdown.replace("Original", "First edit"),
  );
  const revision = f.documents.view(doc.id).revisions[0];
  doc = await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown.replace("Keep [[Other]]", "Newer separate edit"),
  );
  doc = await f.documents.undo(doc.id, revision.id, doc.revision);
  assert.match(doc.markdown, /Original/);
  assert.match(doc.markdown, /Newer separate edit/);
  doc = await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown.replace("Original", "Overlapping newer edit"),
  );
  await assert.rejects(
    f.documents.undo(doc.id, revision.id, doc.revision),
    /overlap/,
  );
});
test("bridge declines dirty buffers; a confirmed write alone marks synchronization complete", async (t) => {
  const f = fixture(t);
  let doc = await f.documents.forSource(f.source);
  doc = await f.documents.bind(doc.id, {
    expectedRevision: 0,
    path: "Paper.md",
    create: false,
    syncEnabled: true,
    syncMethod: "bridge",
  });
  await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown.replace("Original", "My edit"),
  );
  f.documents.bridgePoll("obsidian-client", f.root);
  const jobReady = async () => {
    for (let i = 0; i < 100; i++) {
      const job = f.documents.bridgePoll("obsidian-client", f.root)[0];
      if (job) return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("bridge job not queued");
  };
  const promise = f.documents.sync(doc.id);
  const job = await jobReady();
  assert.ok(job);
  f.documents.bridgeAck(job.id, "obsidian-client", {
    ok: false,
    error: "Unsaved Obsidian buffer",
  });
  doc = await promise;
  assert.equal(doc.syncStatus, "conflict");
  assert.match(readFileSync(join(f.root, "Paper.md"), "utf8"), /Original/);
  const retry = f.documents.sync(doc.id);
  const next = await jobReady();
  writeFileSync(join(f.root, "Paper.md"), next.after);
  f.documents.bridgeAck(next.id, "obsidian-client", { ok: true });
  doc = await retry;
  assert.equal(doc.syncStatus, "synced");
});
test("synthesis is bounded, source-linked, deduplicated and never changes a note before inline acceptance", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source),
    a = thought(f);
  const { service, calls } = synthesis(f, proposed);
  const input = request();
  const run = service.start(doc.id, input);
  assert.equal(service.start(doc.id, input).id, run.id);
  assert.equal((await finished(service, f.store, run)).status, "completed");
  assert.equal(f.documents.get(doc.id).markdown, doc.markdown);
  assert.equal(calls.length, 1);
  assert.throws(() => service.start(doc.id, request()), /No new material/);
  const [suggestion] = f.documents.view(doc.id).suggestions;
  assert.equal(suggestion.status, "pending");
  assert.equal(suggestion.inputs[0].text, a.text);
  let saved = await service.review(doc.id, suggestion.id, {
    action: "accept",
    expectedRevision: doc.revision,
  });
  assert.match(saved.markdown, /might require Assumption A/);
  assert.match(
    saved.markdown,
    /AI-assisted; accepted by researcher; unverified/,
  );
  assert.match(saved.markdown, /http:\/\/127\.0\.0\.1:4318\/\?session=/);
  assert.match(saved.markdown, /summary: keep this/);
  assert.match(saved.markdown, /Keep \[\[Other\]\]/);
  assert.equal(f.store.get("artifact", a.id).status, "open");
  await assert.rejects(
    service.review(doc.id, suggestion.id, {
      action: "accept",
      expectedRevision: saved.revision,
    }),
    /already reviewed/,
  );
  const recovery = f.documents.view(doc.id).revisions[0];
  saved = await f.documents.undo(doc.id, recovery.id, saved.revision);
  assert.equal(saved.markdown, doc.markdown);
  f.store.deleteSessionData(f.session.id);
  assert.ok(f.store.get("literatureDocument", doc.id));
  assert.equal(f.documents.view(doc.id).suggestions[0].inputs[0].text, a.text);
  assert.ok(
    f.store.get("evidenceSnapshot", suggestion.evidenceIds[0]),
    "shared note evidence survives session deletion",
  );
});
test("dismissed input stays dismissed until its wording changes; stale model output cannot overwrite writing", async (t) => {
  const f = fixture(t);
  let doc = await f.documents.forSource(f.source);
  const a = thought(f);
  let release;
  const { service } = synthesis(
    f,
    (body) =>
      new Promise((resolve) => (release = () => resolve(proposed(body)))),
  );
  const run = service.start(doc.id, request());
  doc = await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown + "\nA newer paragraph.\n",
  );
  release();
  assert.equal((await finished(service, f.store, run)).status, "stale");
  assert.match(f.documents.get(doc.id).markdown, /newer paragraph/);
  const again = service.start(doc.id, request());
  release();
  await finished(service, f.store, again);
  const suggestion = f.documents
    .view(doc.id)
    .suggestions.find((s) => s.status === "pending");
  await service.review(doc.id, suggestion.id, {
    action: "dismiss",
    expectedRevision: doc.revision,
  });
  assert.throws(() => service.start(doc.id, request()), /No new material/);
  f.store.put("artifact", {
    ...a,
    text: "This might need a different assumption.",
    revision: 1,
  });
  assert.notEqual(
    artifactRevision(a),
    artifactRevision(f.store.get("artifact", a.id)),
  );
  const edited = service.start(doc.id, request());
  release();
  assert.equal((await finished(service, f.store, edited)).status, "completed");
});
test("cancellation and invalid model operations retain captures and leave the document untouched", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source);
  const a = thought(f);
  let release;
  const { service } = synthesis(
    f,
    (body) =>
      new Promise((resolve) => (release = () => resolve(proposed(body)))),
  );
  const run = service.start(doc.id, request());
  service.cancel(doc.id);
  release();
  assert.equal((await finished(service, f.store, run)).status, "cancelled");
  assert.equal(f.documents.view(doc.id).suggestions.length, 0);
  assert.equal(f.store.get("artifact", a.id).text, a.text);
  const invalid = synthesis(f, (body) => {
    const result = proposed(body);
    const parsed = JSON.parse(result.message.content);
    parsed.changes[0].blockId = "forged-target";
    result.message.content = JSON.stringify(parsed);
    return result;
  }).service;
  const bad = invalid.start(doc.id, request());
  assert.equal((await finished(invalid, f.store, bad)).status, "failed");
  assert.equal(f.documents.get(doc.id).markdown, doc.markdown);
});
test("automatic organization is explicitly local despite a cloud tutor selection; missing models never substitute providers", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source);
  thought(f);
  const { service, calls } = synthesis(f, proposed);
  assert.throws(
    () => service.start(doc.id, request({ background: true, cloud: true })),
    /local only/,
  );
  service.getModels = () => [];
  assert.throws(
    () => service.start(doc.id, request({ background: true })),
    /unavailable/,
  );
  assert.equal(calls.length, 0);
  service.getModels = () => [
    { name: "qwen3.8:27b-q4_K_M", cloud: false, capabilities: ["completion"] },
  ];
  const run = service.start(doc.id, request({ background: true }));
  await finished(service, f.store, run);
  assert.equal(run.selection.provider, "ollama");
  assert.equal(run.selection.cloud, false);
  assert.equal(calls[0].model, "qwen3.8:27b-q4_K_M");
});

test("organization updates an existing summary property without adding a competing section", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source);
  thought(f, "My tentative paper summary.");
  const { service } = synthesis(f, (body) => {
    const context = JSON.parse(body.messages[1].content),
      block = context.blocks.find((b) => b.summaryProperty);
    return {
      message: {
        content: JSON.stringify({
          changes: [
            {
              blockId: block.id,
              operation: "replace",
              text: "A tentative summary with its qualification.",
              artifactRevisionIds: [context.inputs[0].artifactRevisionId],
              evidenceIds: [],
              rationale: "Use the existing summary property.",
            },
          ],
          pending: [],
        }),
      },
    };
  });
  const run = service.start(doc.id, request());
  assert.equal((await finished(service, f.store, run)).status, "completed");
  const suggestion = f.documents.view(doc.id).suggestions[0];
  const saved = await service.review(doc.id, suggestion.id, {
    action: "accept",
    expectedRevision: doc.revision,
  });
  assert.match(
    saved.markdown,
    /summary: A tentative summary with its qualification/,
  );
  assert.doesNotMatch(saved.markdown, /## Summary/);
  assert.match(saved.markdown, /Original \$x\^2\$/);
  assert.match(saved.markdown, /tags: \[literature_note\]/);
});
test("reopening refreshes current external note text without writing the vault", async (t) => {
  const f = fixture(t);
  const doc = await f.documents.forSource(f.source);
  writeFileSync(
    join(f.root, "Paper.md"),
    doc.markdown.replace("Original", "External edit made after closing Margin"),
  );
  const reopened = await f.documents.forSource(f.source);
  assert.equal(reopened.id, doc.id);
  assert.match(reopened.markdown, /External edit made after closing Margin/);
  assert.deepEqual(f.written, []);
});
test("section acceptance commits all related changes atomically and rolls back unsafe targets", async (t) => {
  const f = fixture(
    t,
    "# Paper\n\n## Understanding\n\nFirst paragraph.\n\nSecond paragraph.\n",
  );
  const doc = await f.documents.forSource(f.source);
  const a = thought(f);
  const { service } = synthesis(f, (body) => {
    const context = JSON.parse(body.messages[1].content);
    return {
      message: {
        content: JSON.stringify({
          changes: context.blocks
            .filter((b) => b.text.includes("paragraph."))
            .map((b, i) => ({
              blockId: b.id,
              operation: "replace",
              text: `Proposed paragraph ${i + 1}.`,
              artifactRevisionIds: [context.inputs[0].artifactRevisionId],
              evidenceIds: [],
              rationale: "Two related ideas.",
            })),
          pending: [],
        }),
      },
    };
  });
  const run = service.start(doc.id, request());
  await finished(service, f.store, run);
  const suggestions = f.documents.view(doc.id).suggestions;
  const saved = await service.reviewSection(
    doc.id,
    suggestions.map((s) => s.id),
    0,
  );
  assert.match(saved.markdown, /Proposed paragraph 1/);
  assert.match(saved.markdown, /Proposed paragraph 2/);
  assert.equal(
    f.documents.view(doc.id).suggestions.filter((s) => s.status === "accepted")
      .length,
    2,
  );
  assert.equal(f.store.get("artifact", a.id).status, "open");
  const before = f.documents.get(doc.id),
    target = documentBlocks(before.markdown, before.revision).find(
      (b) => b.text === "Proposed paragraph 1.",
    );
  const template = {
    documentId: doc.id,
    baseRevision: before.revision,
    operation: "replace",
    text: "Reviewed replacement.",
    artifactRevisionIds: [artifactRevision(a)],
    evidenceIds: [],
    inspectedEvidence: [],
    inputs: [a],
    status: "pending",
    selection: { provider: "ollama", model: "local", cloud: false },
  };
  const good = f.store.put("synthesisSuggestion", {
      ...template,
      target: { ...target, section: "Understanding" },
    }),
    bad = f.store.put("synthesisSuggestion", {
      ...template,
      target: {
        id: "invalid",
        start: 0,
        end: 7,
        text: "missing",
        section: "Understanding",
      },
    });
  await assert.rejects(
    service.reviewSection(doc.id, [good.id, bad.id], before.revision),
    /target changed/i,
  );
  assert.equal(f.documents.get(doc.id).markdown, before.markdown);
  assert.equal(f.documents.get(doc.id).revision, before.revision);
  assert.equal(f.store.get("synthesisSuggestion", good.id).status, "pending");
});

test("Tutor-to-note requires explicit selection and retains the chosen AI excerpt and authorship", async (t) => {
  const f = fixture(t),
    doc = await f.documents.forSource(f.source);
  const answer = f.store.put("artifact", {
    sessionId: f.session.id,
    origin: "ai",
    kind: "tutor",
    status: "unverified",
    text: "A source-grounded explanation.\n\nAn unrelated aside.",
    anchor: { sourceId: f.source.id, page: 1, quote: "" },
    createdAt: new Date().toISOString(),
  });
  const { service } = synthesis(f, (body) => {
    const input = JSON.parse(body.messages[1].content).inputs[0];
    assert.equal(input.origin, "ai");
    assert.equal(input.text, "A source-grounded explanation.");
    return proposed(body);
  });
  assert.throws(() => service.start(doc.id, request()), /No new material/);
  const run = service.start(
    doc.id,
    request({
      artifactIds: [answer.id],
      excerpt: {
        artifactId: answer.id,
        text: "A source-grounded explanation.",
      },
    }),
  );
  await finished(service, f.store, run);
  const suggestion = f.documents.view(doc.id).suggestions[0];
  assert.equal(suggestion.inputs[0].origin, "ai");
  assert.equal(
    suggestion.inputs[0].selectedText,
    "A source-grounded explanation.",
  );
  assert.equal(f.store.get("artifact", answer.id).status, "unverified");
});

test("document operation targets retain whole code and display-math blocks across blank lines", () => {
  const text =
    "## Understanding\n\n```text\nfirst\n\n# literal heading\n```\n\n$$\na_i = b_i\n\n+ c_i\n$$\n\nLast paragraph.\n";
  const blocks = documentBlocks(text, 4),
    code = blocks.find((b) => b.text.startsWith("```")),
    math = blocks.find((b) => b.text.startsWith("$$"));
  assert.match(code.text, /# literal heading\n```$/);
  assert.equal(code.section, "Understanding");
  assert.match(math.text, /\n\n\+ c_i\n\$\$$/);
  assert.equal(blocks.at(-1).section, "Understanding");
  for (const block of blocks)
    assert.equal(text.slice(block.start, block.end), block.text);
});

test("disconnecting a vault keeps the same shared document available for local editing", async (t) => {
  const f = fixture(t);
  let doc = await connected(f);
  f.documents.getVault = () => ({ root: "" });
  const resumed = await f.documents.forSource(f.source);
  assert.equal(resumed.id, doc.id);
  doc = await f.documents.save(
    doc.id,
    doc.revision,
    doc.markdown + "\nOffline writing.\n",
  );
  doc = await f.documents.sync(doc.id);
  assert.equal(doc.syncStatus, "offline");
  assert.match(doc.markdown, /Offline writing/);
  assert.doesNotMatch(
    readFileSync(join(f.root, "Paper.md"), "utf8"),
    /Offline writing/,
  );
});

test("structured organization selects the requested GGUF model without changing the MLX Tutor default", async (t) => {
  const { DEFAULT_LOCAL_MODEL } = await import("../server/models.mjs");
  const f = fixture(t),
    doc = await f.documents.forSource(f.source);
  thought(f);
  const { service, calls } = synthesis(f, proposed);
  const installed = {
    name: "qwen3.8:27b-mlx",
    cloud: false,
    capabilities: ["completion"],
  };
  service.getModels = () => [installed];
  assert.throws(
    () => service.start(doc.id, request()),
    /qwen3\.8:27b-q4_K_M is unavailable/,
  );
  assert.equal(
    calls.length,
    0,
    "an available MLX model must not be substituted",
  );
  service.getModels = () => [
    installed,
    { name: "qwen3.8:27b-q4_K_M", cloud: false, capabilities: ["completion"] },
  ];
  const run = service.start(doc.id, request());
  assert.equal((await finished(service, f.store, run)).status, "completed");
  assert.equal(calls[0].model, "qwen3.8:27b-q4_K_M");
  assert.equal(calls[0].format, "json");
  assert.equal(run.selection.model, "qwen3.8:27b-q4_K_M");
  assert.equal(DEFAULT_LOCAL_MODEL, "qwen3.8:27b-mlx");
});
