import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { Store } from "../server/store.mjs";
import { digest } from "../server/vault.mjs";
import { makeLayout } from "../server/regions.mjs";

const theorem =
  "Theorem 1. A contraction on a complete metric space has a unique fixed point.";
const humanNote =
  "# Contraction interpretation\n## Conditions\nI still need to check completeness of the MPC formulation.\n";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "margin-knowledge-api-")),
    vaultDir = join(dir, "vault");
  await mkdir(vaultDir);
  await mkdir(join(dir, "sources"));
  await writeFile(join(vaultDir, "Conditions.md"), humanNote);
  const store = new Store(join(dir, "research.sqlite")),
    server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let preparedId,
    regionId,
    layoutRevision,
    step = 0,
    sourceEvidence,
    noteEvidence;
  const toolOutputs = [];
  const toolCall = (name, args) => ({
    message: {
      tool_calls: [{ id: `step-${step}`, function: { name, arguments: args } }],
    },
    done: true,
  });
  const app = await createApp({
    store,
    dataDir: dir,
    vaultRoot: vaultDir,
    port: server.address().port,
    fetchImpl: async (url, request) => {
      if (url.endsWith("/api/tags"))
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "local", capabilities: ["completion"] }],
          }),
        };
      if (!url.endsWith("/api/chat")) throw new Error("Unexpected endpoint");
      const input = JSON.parse(request.body),
        payload =
          input.messages.at(-1).role === "user"
            ? JSON.parse(input.messages.at(-1).content)
            : null;
      if (payload?.task) {
        const value =
          payload.task === "unit"
            ? {
                description: "Contraction and completeness",
                account: "The conclusion requires completeness.",
                assumptions: ["Complete metric space"],
                notation: [],
                limitations: [],
                questions: ["Does the MPC space satisfy completeness?"],
              }
            : payload.task === "comparison"
              ? {
                  relation: "incompatible-assumptions",
                  leftQuote: payload.left.slice(0, 40),
                  rightQuote: payload.right.slice(0, 40),
                  reasoning: "The target note leaves completeness unresolved.",
                  qualifications: ["A mismatch is pending inspection"],
                  checks: [
                    "Establish completeness before applying this argument",
                  ],
                }
              : {
                  description:
                    "Contraction result with a completeness condition",
                  problem: "Fixed point existence",
                  approach: "Contraction argument",
                  contributions: ["Uniqueness under the supplied assumptions"],
                  limitations: [
                    "The target MPC conditions are not established",
                  ],
                };
        return {
          ok: true,
          json: async () => ({
            message: { content: JSON.stringify(value) },
            done: true,
          }),
        };
      }
      const tool = [...input.messages].reverse().find((m) => m.role === "tool");
      if (tool) {
        const parsed = JSON.parse(tool.content);
        toolOutputs.push(parsed.result || parsed);
      }
      step++;
      let response;
      if (step === 1)
        response = toolCall("knowledge.search", {
          query: "contraction completeness",
        });
      else if (step === 2)
        response = toolCall("knowledge.load", { entityId: preparedId });
      else if (step === 3)
        response = toolCall("knowledge.connections", { entityId: preparedId });
      else if (step === 4)
        response = toolCall("source.read", {
          sourceId: "earlier",
          page: 1,
          regionId,
          revision: layoutRevision,
        });
      else if (step === 5) {
        assert.ok(
          toolOutputs.at(-1).evidence?.length,
          JSON.stringify(toolOutputs.at(-1)),
        );
        sourceEvidence = toolOutputs.at(-1).evidence[0];
        response = toolCall("vault.read", { path: "Conditions.md", line: 1 });
      } else {
        noteEvidence = toolOutputs.at(-1).evidence[0];
        response = {
          message: {
            content: `The source requires a complete metric space. {{cite:${sourceEvidence.id}}} The note leaves that condition open. {{cite:${noteEvidence.id}}} Applying the earlier argument is a proposed inference; check completeness first. The retained correction says the MPC formulation has not established it.`,
          },
          done: true,
        };
      }
      return { ok: true, json: async () => response };
    },
  });
  server.on("request", app);
  const base = `http://127.0.0.1:${server.address().port}/api`,
    boot = await (await fetch(`${base}/bootstrap`)).json();
  const raw = (path, body, token = boot.token) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Margin-Token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (path, body) => {
    const response = await raw(path, body),
      value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  store.put("source", {
    id: "earlier",
    title: "Earlier contraction paper",
    kind: "pdf",
    file: "earlier.pdf",
    pages: ["Native extraction lacks the theorem; OCR supplied the region."],
  });
  await writeFile(join(dir, "sources", "earlier.pdf"), "fixture source bytes");
  const layout = makeLayout(
    "earlier",
    digest("fixture source bytes"),
    [[{ kind: "theorem", text: theorem, box: [0.1, 0.1, 0.9, 0.3] }]],
    "paddle",
  );
  store.put("documentLayout", layout);
  regionId = layout.regions.find((r) => r.kind === "theorem").id;
  layoutRevision = layout.revision;
  const finish = async (job) => {
    for (let i = 0; i < 200; i++) {
      const current = store.get("knowledgeJob", job.id);
      if (!["queued", "running", "cancelling"].includes(current.status))
        return current;
      await delay(5);
    }
    throw new Error("Job did not stop");
  };
  t.after(async () => {
    await app.locals.closeKnowledge();
    await app.locals.closeIntake();
    await app.locals.agentHarness.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    store,
    boot,
    dir,
    vaultDir,
    call,
    raw,
    finish,
    toolOutputs,
    setPreparedId: (id) => {
      preparedId = id;
    },
  };
}

test("a conversation in another workspace discovers preparation, checks exact OCR and note evidence, and retains a correction", async (t) => {
  const f = await fixture(t);
  const job = await f.finish(
    await f.call("/sources/earlier/knowledge/prepare", {
      model: "local",
      maxComparisons: 1,
    }),
  );
  assert.equal(job.errors, 0, job.message);
  f.setPreparedId(job.entityId);
  const prepared = await f.call("/sources/earlier/knowledge");
  assert.equal(prepared.snapshot.connections.length, 1);
  await f.call(
    `/knowledge/connections/${prepared.snapshot.connections[0].id}/review`,
    {
      state: "corrected",
      correction: "The MPC formulation has not established completeness.",
    },
  );
  const workspace = await f.call("/workspaces", {
    title: "A separate MPC project",
  });
  const source = await f.call("/sources/text", {
    title: "New MPC formulation",
    text: "A distributed update is proposed. Its metric and completeness assumptions remain open.",
  });
  const session = await f.call("/sessions", {
    workspaceId: workspace.id,
    sourceId: source.id,
  });
  assert.equal(
    f.store.list("artifact").length,
    0,
    "preparation did not create accepted notebook content",
  );
  const run = await f.call(`/sessions/${session.id}/runs`, {
    text: "Can the earlier contraction argument help this MPC formulation?",
    mode: "connect",
    selection: { provider: "ollama", model: "local" },
    idempotencyKey: "new-research-loop",
  });
  const finished = await f.app.locals.agentHarness.wait(run.id);
  assert.equal(
    finished.status,
    "completed",
    JSON.stringify({ failure: finished.failure, toolOutputs: f.toolOutputs }),
  );
  const answer = f.store.getAgentArtifact(run.id);
  assert.match(answer.text, /check completeness first/);
  const sourceEvidence = answer.evidence.find(
    (e) => e.kind === "source-region",
  );
  assert.equal(sourceEvidence.text, theorem);
  assert.equal(sourceEvidence.provenance.origin, "source");
  assert.ok(sourceEvidence.locator.regionId);
  const noteEvidence = answer.evidence.find((e) => e.path === "Conditions.md");
  assert.match(noteEvidence.text, /still need to check/);
  assert.equal(noteEvidence.provenance.authorship, "not-inferred");
  assert.ok(
    !answer.evidence.some((e) => e.kind.startsWith("knowledge")),
    "AI cards did not become original evidence",
  );
  assert.ok(
    f.toolOutputs.some((o) =>
      o.connections?.some(
        (c) =>
          c.review.state === "corrected" && c.review.correction.includes("MPC"),
      ),
    ),
  );
  assert.equal(
    await readFile(join(f.vaultDir, "Conditions.md"), "utf8"),
    humanNote,
  );
  assert.equal(f.store.list("learningEvidence").length, 0);
});

test("preparation API enforces local model, budgets and mutation token; export includes authoritative Markdown and review history", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.raw("/sources/earlier/knowledge/prepare", {}, "wrong")).status,
    403,
  );
  assert.equal(
    (await f.raw("/sources/earlier/knowledge/prepare", { model: "cloud" }))
      .status,
    400,
  );
  assert.equal(
    (await f.raw("/sources/earlier/knowledge/prepare", { maxUnits: 900 }))
      .status,
    400,
  );
  assert.equal(
    (await f.raw("/knowledge/settings", { enabled: true, model: "" })).status,
    400,
  );
  const job = await f.finish(
    await f.call("/sources/earlier/knowledge/prepare", {
      model: "local",
      maxComparisons: 1,
    }),
  );
  const card = (await f.call("/sources/earlier/knowledge")).snapshot
    .connections[0];
  await f.call(`/knowledge/connections/${card.id}/review`, {
    state: "rejected",
    correction: "Missing hypothesis",
  });
  const exported = await f.call(`/knowledge/entities/${job.entityId}/export`);
  assert.ok(exported.files.some((f) => f.path.endsWith("manifest.md")));
  assert.ok(exported.files.some((f) => f.path.includes("/connections/")));
  assert.equal(exported.reviews[0].state, "rejected");
  const history = await f.call("/export");
  assert.ok(history.knowledgeSnapshots.length);
  assert.ok(history.knowledgeReviewEvents.length);
  assert.ok((await f.call("/knowledge/recover", {})).recovered > 0);
});
