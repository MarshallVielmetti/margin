import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.mjs";
import { Retrieval } from "../server/retrieval.mjs";
import { parseNote } from "../server/vault.mjs";
import { makeLayout } from "../server/regions.mjs";
import { Intake, validateAnalysis } from "../server/intake.mjs";

const layout = () =>
  makeLayout("s", "hash", [
    [
      {
        text: "Definition 1. A contraction shrinks distances.",
        kind: "definition",
        box: [0.1, 0.1, 0.8, 0.2],
      },
      {
        text: "A complete metric space has a fixed point.",
        kind: "paragraph",
        box: [0.1, 0.22, 0.8, 0.3],
      },
    ],
  ]);
const analysis = () => ({
  summary: "A contraction shrinks distances.",
  concepts: ["contraction"],
  assumptions: ["Completeness"],
  questions: ["Where is completeness used?"],
  noteLinks: [],
  connections: [],
});
function fixture(
  t,
  request = async () => ({ message: { content: JSON.stringify(analysis()) } }),
) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  let notes = [
      parseNote(
        "Contraction.md",
        "# Contraction\n## Statement\nA contraction shrinks distances in a complete metric space.",
      ),
    ],
    calls = 0;
  const ollama = {
    request: async (...args) => {
      calls++;
      return request(...args);
    },
  };
  const intake = new Intake({
    store,
    retrieval: new Retrieval(store, ollama),
    ollama,
    getSource: () => ({ id: "s", kind: "pdf", pages: ["text"] }),
    getFile: async () => "/fixture.pdf",
    getNotes: async () => notes,
    getModels: () => [
      { name: "local", cloud: false, capabilities: ["completion"] },
      { name: "cloud", cloud: true, capabilities: ["completion"] },
    ],
    extractors: { native: async () => layout() },
  });
  return {
    store,
    intake,
    calls: () => calls,
    changeNotes: () =>
      (notes = [
        parseNote("Contraction.md", "# Contraction\nCompletely new content."),
      ]),
    notes: () => notes,
  };
}
async function finish(f, job) {
  for (let i = 0; i < 300; i++) {
    const current = f.store.get("intakeJob", job.id);
    if (!["queued", "running", "cancelling"].includes(current.status))
      return current;
    await delay(5);
  }
  throw new Error("Intake did not terminate");
}
test("default intake saves vault passages and region candidates without a model call; reruns reuse chunks", async (t) => {
  const f = fixture(t);
  const job = f.intake.start("s");
  assert.equal(f.intake.start("s").id, job.id);
  assert.equal((await finish(f, job)).status, "complete");
  assert.equal(f.calls(), 0);
  const contexts = f.intake.contexts("s", "", f.notes());
  assert.ok(contexts.length >= 2);
  assert.ok(
    contexts.some((c) => c.notes.some((n) => n.path === "Contraction.md")),
  );
  assert.ok(contexts.some((c) => c.candidates.length));
  assert.ok(contexts.every((c) => c.verification === "unverified" && !c.stale));
  const count = f.store.list("chunkContext").length;
  await finish(f, f.intake.start("s"));
  assert.equal(f.store.list("chunkContext").length, count);
  f.changeNotes();
  assert.ok(f.intake.contexts("s", "", f.notes()).every((c) => c.stale));
});
test("local intake creates validated analysis and never permits a cloud processor", async (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.intake.start("s", { model: "cloud" }),
    /Cloud models are not allowed/,
  );
  const job = await finish(f, f.intake.start("s", { model: "local" }));
  assert.equal(job.status, "complete");
  assert.equal(f.calls(), job.total);
  assert.ok(
    f.store
      .list("chunkContext")
      .every((c) => c.analysis.summary && c.model === "local"),
  );
  await finish(f, f.intake.start("s", { model: "local" }));
  assert.equal(f.calls(), job.total);
});
test("unmatched or invented agent links are rejected, preserving partial retrieval context for retry", async (t) => {
  const a = analysis();
  a.noteLinks = [
    {
      path: "invented.md",
      reason: "asserted",
      sourceQuote: "contraction",
      targetQuote: "contraction",
    },
  ];
  const f = fixture(t, async () => ({
    message: { content: JSON.stringify(a) },
  }));
  const job = await finish(f, f.intake.start("s", { model: "local" }));
  assert.equal(job.status, "partial");
  assert.equal(job.errors, job.total);
  assert.ok(
    f.store
      .list("chunkContext")
      .every(
        (c) => c.status === "partial" && c.analysis === null && c.notes.length,
      ),
  );
  assert.throws(
    () => validateAnalysis(a, { text: "contraction" }, [], []),
    /lacks matching/,
  );
});
test("quoted links must match both supplied excerpts exactly", () => {
  const a = analysis();
  a.noteLinks = [
    {
      path: "A.md",
      reason: "definition",
      sourceQuote: "shrinks distances",
      targetQuote: "contraction shrinks",
    },
  ];
  assert.equal(
    validateAnalysis(
      a,
      { text: "A contraction shrinks distances." },
      [{ path: "A.md", excerpt: "A contraction shrinks distances." }],
      [],
    ).noteLinks.length,
    1,
  );
  a.noteLinks[0].targetQuote = "invented evidence";
  assert.throws(
    () =>
      validateAnalysis(
        a,
        { text: "A contraction shrinks distances." },
        [{ path: "A.md", excerpt: "A contraction shrinks distances." }],
        [],
      ),
    /quotations/,
  );
});
test("cancellation aborts the active model request and retains completed chunks", async (t) => {
  let entered;
  const started = new Promise((r) => (entered = r));
  const f = fixture(t, async (_path, _body, _timeout, signal) => {
    entered();
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  });
  const job = f.intake.start("s", { model: "local" });
  await started;
  f.intake.cancel("s");
  assert.equal((await finish(f, job)).status, "cancelled");
  assert.equal(f.store.list("chunkContext").length, 0);
});
test("unfinished jobs are marked interrupted after restart", (t) => {
  const f = fixture(t);
  f.store.put("intakeJob", { id: "old", sourceId: "s", status: "running" });
  new Intake({ store: f.store });
  assert.equal(f.store.get("intakeJob", "old").status, "interrupted");
});

test("retrieval-only intake yields to cancellation between chunks", async (t) => {
  const f = fixture(t);
  f.intake.extractors.native = async () =>
    makeLayout("s", "many", [
      Array.from({ length: 400 }, (_, i) => ({
        text: `Unique region ${i} with contraction evidence.`,
        kind: "paragraph",
        box: [0.1, 0.1, 0.5, 0.2],
      })),
    ]);
  let reads = 0;
  f.intake.retrieval.retrieve = async () => {
    if (++reads === 1) setTimeout(() => f.intake.cancel("s"), 0);
    return { notes: [] };
  };
  const result = await finish(f, f.intake.start("s"));
  assert.equal(result.status, "cancelled");
  assert.ok(result.done < result.total);
});
