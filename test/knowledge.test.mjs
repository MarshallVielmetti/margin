import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rename,
  rm,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.mjs";
import { Knowledge } from "../server/knowledge.mjs";
import { makeLayout } from "../server/regions.mjs";
import { digest, scanVault } from "../server/vault.mjs";
import { createKnowledgeTools } from "../server/agent/tools/knowledge.mjs";
import { meaningfulUnits } from "../server/knowledge-units.mjs";

const claim =
  "Theorem 1. Every contraction on a complete metric space has a unique fixed point.";
const noteText =
  "# Fixed point\n## Conditions\nA contraction on a complete metric space has a unique fixed point.\n";
async function fixture(t, request) {
  const dir = await mkdtemp(join(tmpdir(), "margin-knowledge-")),
    vaultDir = join(dir, "vault");
  await mkdir(vaultDir);
  await writeFile(join(vaultDir, "Fixed point.md"), noteText);
  await writeFile(
    join(vaultDir, "Topics.md"),
    "---\ntags: [MOC]\n---\n# Topics\n[[Fixed point]]\n[[Other MOC]]\n",
  );
  await writeFile(
    join(vaultDir, "Other MOC.md"),
    "---\ntags: [MOC]\n---\n# Other MOC\n[[Topics]]\n",
  );
  await writeFile(
    join(vaultDir, "Unlinked.md"),
    "# Unlinked compactness\nSequential compactness needs an appropriate topology.\n",
  );
  const store = new Store(join(dir, "research.sqlite"));
  let vault = await scanVault(vaultDir),
    calls = [];
  const source = store.put("source", {
    id: "paper",
    title: "Contraction paper",
    kind: "pdf",
    file: "paper.pdf",
    pages: [claim, ""],
  });
  await writeFile(join(dir, "paper.pdf"), "fixture PDF bytes");
  const layout = makeLayout(source.id, digest("fixture PDF bytes"), [
    [{ kind: "theorem", text: claim, box: [0.1, 0.1, 0.9, 0.3] }],
    [],
  ]);
  store.put("documentLayout", layout);
  store.put("layoutSnapshot", {
    ...layout,
    id: `layout-version:${source.id}:${layout.revision}`,
  });
  const ollama = {
    request: async (...args) => {
      const payload = JSON.parse(args[1].messages[1].content);
      calls.push(payload.task);
      if (request) return request(payload, ...args);
      const answer =
        payload.task === "unit"
          ? {
              description: "Contraction theorem with completeness",
              account:
                "The stated contraction conclusion requires a complete metric space.",
              assumptions: ["Completeness", "Contraction"],
              notation: [],
              limitations: ["No claim about incomplete spaces"],
              questions: [],
            }
          : payload.task === "comparison"
            ? {
                relation: "possible-application",
                leftQuote: payload.left.slice(0, 45),
                rightQuote: payload.right.slice(0, 40),
                reasoning:
                  "Both passages discuss contraction, but a transfer needs matching completeness hypotheses.",
                qualifications: ["Similarity alone is not proof"],
                checks: ["Check completeness in the target formulation"],
              }
            : {
                description: "A fixed point argument for contractions",
                problem: "Existence of fixed points",
                approach: "A contraction argument",
                contributions: [
                  "A uniqueness claim within the inspected theorem",
                ],
                limitations: ["Only selected extracted material was inspected"],
              };
      return { message: { content: JSON.stringify(answer) } };
    },
  };
  const create = () =>
    new Knowledge({
      store,
      dataDir: dir,
      getVault: () => vault,
      getFile: async (s) => join(dir, s.file),
      getModels: () => [
        { name: "local", cloud: false, capabilities: ["completion"] },
        { name: "remote", cloud: true, capabilities: ["completion"] },
      ],
      ollama,
    });
  let knowledge = create();
  knowledge.sync();
  t.after(async () => {
    await knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const finish = async (job) => {
    for (let i = 0; i < 500; i++) {
      const saved = store.get("knowledgeJob", job.id);
      if (!["queued", "running", "cancelling"].includes(saved.status))
        return saved;
      await delay(5);
    }
    throw new Error("Preparation did not stop");
  };
  return {
    dir,
    vaultDir,
    store,
    source,
    layout,
    calls,
    finish,
    get knowledge() {
      return knowledge;
    },
    restart: async () => {
      await knowledge.close();
      knowledge = create();
      knowledge.sync();
    },
    setVault: (next) => {
      vault = next;
    },
  };
}

test("every note gets a stable manifest; cyclic MOCs terminate and global search finds an unlinked note", async (t) => {
  const f = await fixture(t);
  assert.equal(f.knowledge.entities().filter((e) => e.notePath).length, 4);
  const moc = f.knowledge.entities().find((e) => e.notePath === "Topics.md");
  const graph = f.knowledge.children(moc.id, {
    depth: 3,
    maxNodes: 3,
    fanOut: 4,
    maxChars: 2000,
  });
  assert.ok(graph.nodes.length <= 3);
  assert.equal(new Set(graph.visited).size, graph.visited.length);
  assert.ok(graph.links.some((l) => l.to === moc.id));
  assert.equal(
    (await f.knowledge.search("compactness")).entries[0].notePath,
    "Unlinked.md",
  );
  assert.equal(f.calls.length, 0);
  const original = f.knowledge
    .entities()
    .find((e) => e.notePath === "Fixed point.md");
  await rename(
    join(f.vaultDir, "Fixed point.md"),
    join(f.vaultDir, "Renamed.md"),
  );
  await f.knowledge.refresh();
  assert.equal(
    f.knowledge.entities().find((e) => e.notePath === "Renamed.md").id,
    original.id,
  );
  await rm(join(f.vaultDir, "Renamed.md"));
  await f.knowledge.refresh();
  assert.equal(f.knowledge.entity(original.id).availability, "unavailable");
});

test("meaningful units attach equations to arguments and do not duplicate grouped regions", () => {
  const layout = makeLayout("paper", "hash", [
    [
      { kind: "theorem", text: claim, box: [0.1, 0.1, 0.9, 0.2] },
      {
        kind: "equation",
        text: "d(Tx,Ty) ≤ q d(x,y)",
        box: [0.1, 0.21, 0.9, 0.24],
      },
      {
        kind: "paragraph",
        text: "Here q is smaller than one.",
        box: [0.1, 0.25, 0.9, 0.28],
      },
    ],
  ]);
  const result = meaningfulUnits(layout);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].text.split("d(Tx,Ty)").length - 1, 1);
  assert.equal(result.units[0].kind, "theorem");
});

test("model-free preparation publishes partial coverage without claiming paper-wide AI analysis", async (t) => {
  const f = await fixture(t),
    job = await f.finish(f.knowledge.start("paper"));
  assert.equal(job.status, "partial");
  assert.equal(f.calls.length, 0);
  const view = await f.knowledge.view(job.entityId);
  assert.equal(view.snapshot.generation, "not-generated");
  assert.equal(view.snapshot.coverage.wholePaperVerified, false);
  assert.deepEqual(view.snapshot.coverage.missingPages, [2]);
  assert.equal(view.snapshot.units[0].origin, "extraction");
  const repeated = f.knowledge.start("paper");
  assert.equal(repeated.id, job.id);
  assert.equal(f.store.list("knowledgeJob").length, 1);
  const exported = f.knowledge.files.export(f.knowledge.scope(), job.entityId);
  assert.ok(exported.some((r) => r.path.endsWith("overview.md")));
  assert.match(exported[0].markdown, /currentRevision/);
  assert.equal(
    await readFile(join(f.vaultDir, "Fixed point.md"), "utf8"),
    noteText,
  );
});

test("new tool instances reuse retained preparation without evidence registration or a prior transcript", async (t) => {
  const f = await fixture(t),
    job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
    );
  assert.equal(job.errors, 0, job.message);
  await f.restart();
  const tools = createKnowledgeTools({
    knowledge: f.knowledge,
    sourceIds: new Set(["paper"]),
  });
  const search = await tools
    .find((t) => t.name === "knowledge.search")
    .execute({ query: "contraction" }, { runId: "new-conversation" });
  const hit = search.entries.find((e) => e.entityId === job.entityId);
  assert.ok(hit);
  assert.equal(hit.inspected, false);
  const overview = await tools
    .find((t) => t.name === "knowledge.load")
    .execute({ entityId: hit.entityId });
  assert.equal(overview.origin, "ai");
  assert.equal(overview.inspectedEvidence, false);
  assert.ok(
    overview.anchors.every(
      (a) => a.inspected === false && !Object.hasOwn(a, "text"),
    ),
  );
  const card = await tools
    .find((t) => t.name === "knowledge.load")
    .execute({ entityId: hit.entityId, unitId: overview.units[0].id });
  assert.match(card.markdown, /complete metric space/);
  assert.equal(f.store.list("evidenceSnapshot").length, 0);
});

test("note edits invalidate only dependent comparisons; unrelated paper cards and current note search survive", async (t) => {
  const f = await fixture(t),
    job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
    );
  let view = await f.knowledge.view(job.entityId);
  assert.equal(view.snapshot.connections.length, 1);
  assert.equal(view.snapshot.connections[0].freshness, "current");
  const path = view.snapshot.connections[0].anchors.find(
    (a) => a.origin === "note",
  ).path;
  await writeFile(
    join(f.vaultDir, path),
    "# Changed interpretation\nCompleteness is an unresolved hypothesis for the target.\n",
  );
  await f.knowledge.refresh();
  view = await f.knowledge.view(job.entityId);
  assert.equal(view.snapshot.freshness, "current");
  assert.equal(view.snapshot.units[0].freshness, "current");
  assert.equal(view.snapshot.connections[0].freshness, "stale");
  assert.equal(
    (await f.knowledge.connections(job.entityId)).connections[0].markdown,
    null,
  );
  assert.ok(
    (await f.knowledge.search("unresolved hypothesis")).entries.some(
      (e) => e.notePath === path,
    ),
  );
  assert.equal(view.snapshot.revisionId, job.revisionId);
});

test("lightweight note inspectors expose incoming comparison proposals without creating a second note document", async (t) => {
  const f = await fixture(t);
  const job = await f.finish(
    f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
  );
  const connection = (await f.knowledge.view(job.entityId)).snapshot
    .connections[0];
  const noteView = await f.knowledge.view(connection.rightEntityId);
  assert.equal(noteView.snapshot, null);
  assert.equal(noteView.comparisons[0].id, connection.id);
  assert.equal(f.store.list("literatureDocument").length, 0);
});

test("PDF and extraction revisions stale generated support while keeping the old snapshot intact", async (t) => {
  const f = await fixture(t),
    job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 0 }),
    );
  await writeFile(join(f.dir, "paper.pdf"), "changed PDF bytes");
  const view = await f.knowledge.view(job.entityId);
  assert.equal(view.snapshot.freshness, "stale");
  const loaded = await f.knowledge.load(job.entityId);
  assert.equal(loaded.markdown, null);
  assert.equal(loaded.freshness, "stale");
  assert.match(view.snapshot.markdown, /Contraction paper/);
  assert.equal(
    (await f.knowledge.search("contraction")).entries.find(
      (e) => e.entityId === job.entityId,
    ).freshness,
    "stale",
  );
});

test("rejection and human correction persist across retries and restart, without changing verification", async (t) => {
  const f = await fixture(t),
    job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
    );
  const card = (await f.knowledge.view(job.entityId)).snapshot.connections[0];
  f.knowledge.review(card.id, {
    state: "rejected",
    correction: "The target does not establish completeness.",
  });
  const calls = f.calls.filter((c) => c === "comparison").length;
  await writeFile(
    join(f.vaultDir, "Unlinked.md"),
    "# An unrelated edited note\nCompactness remains a separate question.\n",
  );
  await f.knowledge.refresh();
  await f.finish(
    f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
  );
  assert.equal(f.calls.filter((c) => c === "comparison").length, calls);
  await f.restart();
  const relations = await f.knowledge.connections(job.entityId);
  assert.equal(relations.connections[0].review.state, "rejected");
  assert.match(
    relations.connections[0].review.correction,
    /does not establish/,
  );
  assert.equal(relations.connections[0].markdown, null);
  assert.equal(relations.connections[0].verification, "unverified");
  f.knowledge.review(card.id, {
    state: "accepted",
    correction: "Accept as a question only.",
  });
  assert.equal(
    (await f.knowledge.connections(job.entityId)).connections[0].review
      .verification,
    "unverified",
  );
  assert.equal(f.store.list("knowledgeReviewEvent").length, 2);
});

test("invalid comparison quotes never publish a relation; failed units remain explicit and resumable", async (t) => {
  const f = await fixture(t, async (payload) => ({
    message: {
      content: JSON.stringify(
        payload.task === "unit"
          ? {
              description: "bounded",
              account: "bounded",
              assumptions: [],
              notation: [],
              limitations: [],
              questions: [],
            }
          : payload.task === "comparison"
            ? {
                relation: "generalizes",
                leftQuote: "Invented quotation",
                rightQuote: "Invented target quote",
                reasoning: "asserted",
                qualifications: [],
                checks: [],
              }
            : {
                description: "bounded",
                problem: "bounded",
                approach: "bounded",
                contributions: [],
                limitations: [],
              },
      ),
    },
  }));
  const job = await f.finish(
    f.knowledge.start("paper", {
      model: "local",
      maxComparisons: 1,
      maxCalls: 3,
    }),
  );
  assert.ok(job.errors > 0);
  assert.equal(
    (await f.knowledge.view(job.entityId)).snapshot.connections.length,
    0,
  );
  assert.match(
    (await f.knowledge.view(job.entityId)).snapshot.issues.join(" "),
    /quotations/,
  );
});

test("cancellation preserves the last published revision and reuses saved unit work", async (t) => {
  let hanging = false,
    entered = false;
  const f = await fixture(t, async (payload, kind, input, timeout, signal) => {
    if (hanging) {
      entered = true;
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    }
    return {
      message: {
        content: JSON.stringify({
          description: "x",
          account: "x",
          assumptions: [],
          notation: [],
          limitations: [],
          questions: [],
        }),
      },
    };
  });
  const old = await f.finish(f.knowledge.start("paper"));
  hanging = true;
  const next = f.knowledge.start("paper", { model: "local" });
  for (let i = 0; i < 100 && !entered; i++) await delay(5);
  assert.ok(entered);
  f.knowledge.cancel(next.id);
  assert.equal((await f.finish(next)).status, "cancelled");
  assert.equal(
    (await f.knowledge.view(old.entityId)).snapshot.revisionId,
    old.revisionId,
  );
  assert.ok(
    f.knowledge.files.export(f.knowledge.scope(), old.entityId).length > 1,
  );
});

test("explicit local preparation budgets and scope boundaries cannot inherit a cloud Tutor selection", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.knowledge.configure({ enabled: true, model: "remote" }),
    /local chat model/,
  );
  assert.throws(
    () => f.knowledge.start("paper", { model: "remote" }),
    /local chat model/,
  );
  const job = await f.finish(
    f.knowledge.start("paper", { model: "local", maxCalls: 1 }),
  );
  assert.equal(job.modelCalls, 1);
  assert.equal(f.calls.length, 1);
  const scoped = createKnowledgeTools({
    knowledge: f.knowledge,
    sourceIds: new Set(),
  });
  assert.ok(
    !(
      await scoped
        .find((t) => t.name === "knowledge.search")
        .execute({ query: "contraction" })
    ).entries.some((e) => e.entityId === job.entityId),
  );
  await assert.rejects(
    () =>
      scoped
        .find((t) => t.name === "knowledge.load")
        .execute({ entityId: job.entityId }),
    /outside the run scope/,
  );
  f.setVault({ root: "", notes: [] });
  assert.throws(() => f.knowledge.entity(job.entityId), /not found/);
});

test("atomic pointer and Markdown recover the search index after an interrupted publication/index update", async (t) => {
  const f = await fixture(t),
    job = await f.finish(f.knowledge.start("paper"));
  const manifest = f.knowledge.files.manifest(
    f.knowledge.scope(),
    job.entityId,
  );
  f.store.put("knowledgeEntity", { ...manifest, currentRevision: null });
  f.knowledge.recover();
  assert.equal(
    f.knowledge.entity(job.entityId).currentRevision,
    job.revisionId,
  );
  assert.equal(
    f.store.get("knowledgeIndex", `ki:${job.entityId}`).revision,
    job.revisionId,
  );
  // A process killed while writing a staging directory cannot redirect the pointer.
  await mkdir(
    join(
      f.knowledge.files.entityPath(f.knowledge.scope(), job.entityId),
      "revisions",
      ".pending-incomplete",
    ),
  );
  await f.restart();
  assert.equal(
    (await f.knowledge.view(job.entityId)).snapshot.revisionId,
    job.revisionId,
  );
});

test("comparison note anchors follow a uniquely reconciled rename without losing original provenance", async (t) => {
  const f = await fixture(t),
    job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 1 }),
    );
  const before = (
    await f.knowledge.connections(job.entityId)
  ).connections[0].anchors.find((a) => a.origin === "note");
  await rename(join(f.vaultDir, before.path), join(f.vaultDir, "New path.md"));
  await f.knowledge.refresh();
  const after = (await f.knowledge.connections(job.entityId)).connections[0];
  assert.equal(after.freshness, "current");
  const note = after.anchors.find((a) => a.origin === "note");
  assert.equal(note.path, "New path.md");
  assert.equal(note.originalPath, before.path);
});

test("local background discovery is opt-in, incremental, and does not regenerate itself indefinitely", async (t) => {
  const f = await fixture(t);
  await f.knowledge.maintain();
  assert.equal(f.store.list("knowledgeJob").length, 0);
  f.knowledge.configure({
    enabled: true,
    model: "local",
    maxUnits: 2,
    maxCalls: 3,
    maxComparisons: 0,
  });
  await f.knowledge.maintain();
  await f.finish(f.store.list("knowledgeJob")[0]);
  const before = f.store.list("knowledgeJob").length;
  await f.knowledge.maintain();
  await f.knowledge.maintain();
  assert.equal(f.store.list("knowledgeJob").length, before);
  await writeFile(
    join(f.vaultDir, "Topics.md"),
    "---\ntags: [MOC]\n---\n# Topics\n[[Unlinked]]\n",
  );
  await f.knowledge.maintain();
  const next = f.store
    .list("knowledgeJob")
    .find((j) => ["queued", "running"].includes(j.status));
  assert.ok(next);
  await f.finish(next);
  assert.equal(
    f.calls.filter((c) => c === "unit").length,
    1,
    "MOC edit does not reanalyze unchanged source units",
  );
  assert.equal(
    f.calls.filter((c) => c === "paper-overview").length,
    1,
    "MOC edit does not regenerate unrelated paper synthesis",
  );
  assert.ok(
    f.store.list("knowledgeDiscovery").every((r) => r.exhaustive === false),
  );
});

test("unchanged failed unit inputs stop at a durable retry limit", async (t) => {
  const f = await fixture(t, async (payload) => {
    if (payload.task === "unit")
      throw new Error("Controlled local model failure");
    return {
      message: {
        content: JSON.stringify({
          description: "partial",
          problem: "unknown",
          approach: "unknown",
          contributions: [],
          limitations: ["Unit generation failed"],
        }),
      },
    };
  });
  for (let i = 0; i < 4; i++) {
    const job = await f.finish(
      f.knowledge.start("paper", { model: "local", maxComparisons: 0 }),
    );
    assert.equal(job.status, "partial");
  }
  assert.equal(f.calls.filter((c) => c === "unit").length, 3);
  const entity = f.knowledge.forSource("paper");
  assert.equal(
    (await f.knowledge.view(entity.id)).snapshot.units[0].generation,
    "failed",
  );
  assert.match(
    (await f.knowledge.view(entity.id)).snapshot.units[0].issues.join(" "),
    /Retry limit/,
  );
});

test("a source-only prepared identity survives deliberate association with an existing literature note", async (t) => {
  const f = await fixture(t),
    job = await f.finish(f.knowledge.start("paper"));
  const oldNote = f.knowledge
    .entities()
    .find((e) => e.notePath === "Fixed point.md");
  f.store.put("source", { ...f.source, notePath: "Fixed point.md" });
  await f.knowledge.refresh();
  const linked = f.knowledge.forSource("paper");
  assert.equal(linked.id, job.entityId);
  assert.equal(linked.notePath, "Fixed point.md");
  assert.equal(f.knowledge.entity(oldNote.id).id, linked.id);
  assert.equal(
    (await f.knowledge.search("fixed point")).entries.filter(
      (e) => e.notePath === "Fixed point.md",
    ).length,
    1,
  );
  assert.equal(
    (await f.knowledge.view(linked.id)).snapshot.revisionId,
    job.revisionId,
  );
});
