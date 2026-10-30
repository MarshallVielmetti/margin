import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { parseNote } from "../server/vault.mjs";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

async function fixture(
  t,
  fetchImpl = async () => {
    throw new Error("offline");
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "margin-agent-api-"));
  const store = new Store(join(dir, "test.sqlite"));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const app = await createApp({ store, dataDir: dir, port, fetchImpl });
  server.on("request", app);
  const base = `http://127.0.0.1:${port}/api`;
  const boot = await (await fetch(`${base}/bootstrap`)).json();
  const raw = (path, body, extra = {}) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-Margin-Token": boot.token,
            }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = async (path, body) => {
    const response = await raw(path, body);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const source = store.put("source", {
    title: "Controlled reference paper",
    kind: "pdf",
    pages: [
      "Introduction: the relevant citations are [11], [12], and [26].",
      "References\n[11] A. Author. First controlled title. Journal, 2021.\n[12] B. Writer. Second title.",
      "Conference, 2022.\n[26] C. Scholar. Third controlled title. Journal, 2023.",
    ],
  });
  const session = await call("/sessions", {
    workspaceId: boot.workspaces[0].id,
    sourceId: source.id,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, store, base, boot, raw, call, source, session, dir };
}

test("reference run reads all pages offline, persists one input and answer, replays SSE, exports named citations", async (t) => {
  const { app, store, boot, raw, call, session, source } = await fixture(t);
  const input = {
    text: "What are these citations 11,12,26",
    idempotencyKey: "same-input",
    anchor: { sourceId: source.id, page: 1, quote: "" },
  };
  const first = await call(`/sessions/${session.id}/runs`, input);
  const repeated = await call(`/sessions/${session.id}/runs`, input);
  assert.equal(repeated.id, first.id);
  const finished = await app.locals.agentHarness.wait(first.id);
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  const artifacts = store.list("artifact").filter((a) => a.runId === first.id);
  assert.equal(artifacts.filter((a) => a.origin === "user").length, 1);
  assert.equal(
    artifacts.filter((a) => a.kind === "reference-lookup").length,
    1,
  );
  const answer = artifacts.find((a) => a.kind === "reference-lookup");
  for (const label of [11, 12, 26])
    assert.ok(answer.text.includes(`[${label}]`));
  assert.equal(answer.evidence.length, 3);
  assert.ok(
    answer.evidence.every(
      (item) => item.page >= 2 && item.id.startsWith("ev_"),
    ),
  );
  assert.match(answer.text, /Conference, 2022/);
  const events = app.locals.agentHarness.events(first.id);
  assert.ok(events.some((event) => event.type === "validation.completed"));
  const streamDenied = await raw(`/runs/${first.id}/events`);
  assert.equal(streamDenied.status, 403);
  const response = await raw(`/runs/${first.id}/events`, undefined, {
    "X-Margin-Token": boot.token,
    "Last-Event-ID": "1",
  });
  const stream = await response.text();
  assert.match(stream, /event: run.completed/);
  assert.ok(!stream.includes("id: 1\n"));
  const exported = await call("/export");
  assert.ok(exported.agentEvents.length);
  const exportedAnswer = exported.artifacts.find((a) => a.id === answer.id);
  assert.match(exportedAnswer.readableMarkdown, /Controlled reference paper/);
  assert.doesNotMatch(exportedAnswer.readableMarkdown, /\{\{cite:/);
  assert.equal((await raw(`/runs/${first.id}/cancel`, {})).status, 200);
  assert.equal((await call(`/runs/${first.id}`)).status, "completed");
});

test("run API rejects foreign mutation/origin, cross-session evidence, invalid model and malformed budget", async (t) => {
  const { raw, call, session, source, boot, app } = await fixture(t);
  const path = `/sessions/${session.id}/runs`;
  const body = { text: "What is reference 11?", idempotencyKey: "scope" };
  assert.equal(
    (await raw(path, body, { "X-Margin-Token": "wrong" })).status,
    403,
  );
  assert.equal(
    (await raw(path, body, { Origin: "https://foreign.example" })).status,
    403,
  );
  assert.equal(
    (await raw(path, { ...body, budgets: { maxToolCalls: 999 } })).status,
    400,
  );
  assert.equal(
    (
      await raw(path, {
        ...body,
        selection: { provider: "openai", model: "invented" },
      })
    ).status,
    400,
  );
  const run = await call(path, body);
  const done = await app.locals.agentHarness.wait(run.id);
  const other = await call("/sessions", {
    workspaceId: boot.workspaces[0].id,
    sourceId: source.id,
  });
  assert.equal(
    (
      await raw(`/sessions/${other.id}/runs`, {
        ...body,
        contextOverrides: {
          pinnedEvidenceIds: done.evidenceIds,
          excludedEvidenceIds: [],
        },
      })
    ).status,
    403,
  );
});

test("unresolved references remain partial and explicit continuation creates a new bounded run", async (t) => {
  const { app, call, session } = await fixture(t);
  const run = await call(`/sessions/${session.id}/runs`, {
    text: "What are references 11 and 99?",
    idempotencyKey: "missing",
  });
  const done = await app.locals.agentHarness.wait(run.id);
  assert.equal(done.status, "partial");
  const continuation = await call(`/runs/${run.id}/continue`, {
    idempotencyKey: "continue",
    budgets: { maxSeconds: 120, maxToolCalls: 10, maxModelCalls: 4 },
  });
  assert.equal(continuation.continuationOf, run.id);
  assert.notEqual(continuation.id, run.id);
  await app.locals.agentHarness.wait(continuation.id);
});

test("research state preserves explicit user attribution and cannot record accepted AI mastery", async (t) => {
  const { call, raw, session } = await fixture(t);
  const path = `/sessions/${session.id}/research`;
  await call(path, {
    kind: "claim",
    record: {
      claim: "The graph is undirected.",
      status: "accepted",
      assumptions: ["Finite graph"],
    },
  });
  const result = await call(path);
  assert.equal(result.claims[0].attribution.origin, "user");
  assert.equal(result.claims[0].status, "accepted");
  assert.equal(
    (
      await raw(path, {
        kind: "learningEvidence",
        record: {
          evidenceType: "ai-provisional-assessment",
          description: "Understood",
          status: "observed",
        },
      })
    ).status,
    400,
  );
});

test("a run cannot read another workspace's source even when its id appears in a prompt", async (t) => {
  let targetId,
    generation = 0,
    toolOutput;
  const fetchImpl = async (url, request) => {
    if (url.endsWith("/api/tags"))
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "test-model", capabilities: ["completion"] }],
        }),
      };
    if (url.endsWith("/api/chat")) {
      const input = JSON.parse(request.body);
      generation++;
      if (generation === 1)
        return {
          ok: true,
          json: async () => ({
            message: {
              tool_calls: [
                {
                  id: "outside",
                  function: {
                    name: "source.read",
                    arguments: { sourceId: targetId, page: 1 },
                  },
                },
              ],
            },
            done: true,
          }),
        };
      toolOutput = input.messages.find(
        (message) => message.role === "tool",
      )?.content;
      return {
        ok: true,
        json: async () => ({
          message: { content: "The source is outside this workspace." },
          done: true,
        }),
      };
    }
    throw new Error("Unexpected endpoint");
  };
  const { app, store, call, session } = await fixture(t, fetchImpl);
  targetId = store.put("source", {
    title: "Outside source",
    kind: "source-excerpt",
    pages: ["A private outside passage."],
  }).id;
  const run = await call(`/sessions/${session.id}/runs`, {
    text: `Read source ${targetId}`,
    idempotencyKey: "outside",
    selection: { provider: "ollama", model: "test-model" },
  });
  const completed = await app.locals.agentHarness.wait(run.id);
  assert.equal(completed.budgetUsage.modelCalls, 2);
  assert.equal(completed.usage.modelCalls, 2);
  assert.match(toolOutput, /outside the run's workspace scope/);
  assert.doesNotMatch(toolOutput, /private outside passage/);
  assert.ok(
    !store.list("evidenceSnapshot").some((item) => item.sourceId === targetId),
  );
});

test("excluding a page blocks an entry that continues onto that page", async (t) => {
  const { app, store, call, session } = await fixture(t);
  const first = await call(`/sessions/${session.id}/runs`, {
    text: "Identify reference 26",
    idempotencyKey: "page-three",
  });
  const done = await app.locals.agentHarness.wait(first.id);
  const pageThree = store.get("evidenceSnapshot", done.evidenceIds[0]);
  assert.equal(pageThree.page, 3);
  const second = await call(`/sessions/${session.id}/runs`, {
    text: "Identify reference 12",
    idempotencyKey: "excluded-continuation",
    contextOverrides: { excludedEvidenceIds: [pageThree.id] },
  });
  const blocked = await app.locals.agentHarness.wait(second.id);
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error.message, /excluded/);
  assert.ok(
    !store
      .list("evidenceSnapshot")
      .some((item) => item.referenceLabel === "12"),
  );
});

test("disabling source expansion removes source and library tools from the provider catalog", async (t) => {
  let catalog;
  const fetchImpl = async (url, request) => {
    if (url.endsWith("/api/tags"))
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "test-model", capabilities: ["completion"] }],
        }),
      };
    if (url.endsWith("/api/chat")) {
      catalog = JSON.parse(request.body).tools;
      return {
        ok: true,
        json: async () => ({
          message: { content: "Source expansion is disabled." },
          done: true,
        }),
      };
    }
    throw new Error("Unexpected endpoint");
  };
  const { app, store, call, session } = await fixture(t, fetchImpl);
  store.setting("sourceExpansion", false);
  const run = await call(`/sessions/${session.id}/runs`, {
    text: "Find the DOI for this reference",
    idempotencyKey: "no-expansion",
    selection: { provider: "ollama", model: "test-model" },
  });
  assert.equal(
    (await app.locals.agentHarness.wait(run.id)).status,
    "completed",
  );
  assert.ok(
    catalog.every(
      (tool) => !/^(source\.|library\.|reference\.)/.test(tool.function.name),
    ),
  );
});

test("diagnostic cleanup preserves answers and evidence; explicit history deletion removes only session data", async (t) => {
  const { app, store, call, raw, session, source } = await fixture(t);
  const run = await call(`/sessions/${session.id}/runs`, {
    text: "Identify reference 11",
    idempotencyKey: "retention",
  });
  const done = await app.locals.agentHarness.wait(run.id);
  const before = store.list("artifact").length;
  await call(`/sessions/${session.id}/diagnostics/purge`, {});
  assert.equal(store.list("artifact").length, before);
  assert.ok(store.get("evidenceSnapshot", done.evidenceIds[0]));
  assert.ok(
    app.locals.agentHarness
      .events(run.id)
      .some((event) => event.type === "run.completed"),
  );
  assert.equal(
    (
      await raw(
        `/sessions/${session.id}/research-history/delete`,
        {},
        { "X-Margin-Token": "wrong" },
      )
    ).status,
    403,
  );
  await call(`/sessions/${session.id}/research-history/delete`, {});
  assert.equal(
    store.list("artifact").filter((item) => item.sessionId === session.id)
      .length,
    0,
  );
  assert.ok(store.get("session", session.id));
  assert.ok(store.get("source", source.id));
  assert.equal(store.get("agentRun", run.id), undefined);
});

test("evidence freshness resolves only a unique exact-hash rename and preserves its snapshot", async (t) => {
  const { store, call, dir } = await fixture(t);
  const root = join(dir, "vault");
  await mkdir(root);
  const content = "# Exact note\nThe graph is undirected.\n";
  await writeFile(join(root, "Original.md"), content);
  const settings = await call("/settings", { vaultRoot: root });
  store.put("evidenceSnapshot", {
    id: "ev_freshness",
    title: "Exact note",
    path: "Original.md",
    vaultRoot: settings.vault.root,
    kind: "vault-note",
    text: content,
    revision: parseNote("Original.md", content).hash,
  });
  assert.equal((await call("/evidence/ev_freshness")).freshness, "current");
  await rename(join(root, "Original.md"), join(root, "Renamed.md"));
  await call("/reindex", {});
  const renamed = await call("/evidence/ev_freshness");
  assert.equal(renamed.freshness, "renamed");
  assert.equal(renamed.currentPath, "Renamed.md");
  assert.equal(renamed.path, "Original.md");
  assert.equal(renamed.text, content);
  await writeFile(join(root, "Duplicate.md"), content);
  await call("/reindex", {});
  const ambiguous = await call("/evidence/ev_freshness");
  assert.equal(ambiguous.freshness, "ambiguous");
  assert.equal(ambiguous.currentPath, undefined);
  assert.equal(
    store.get("evidenceSnapshot", "ev_freshness").path,
    "Original.md",
  );
});

test("linked literature note is refreshed and supplied alongside PDF context and chat history", async (t) => {
  const prompts = [];
  const fetchImpl = async (url, request) => {
    if (url.endsWith("/api/tags"))
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "test-model", capabilities: ["completion"] }],
        }),
      };
    if (url.endsWith("/api/chat")) {
      const messages = JSON.parse(request.body).messages;
      prompts.push(
        JSON.parse(messages.find((message) => message.role === "user").content),
      );
      return {
        ok: true,
        json: async () => ({
          message: { content: "A saved discussion of the supplied context." },
          done: true,
        }),
      };
    }
    throw new Error("Unexpected endpoint");
  };
  const { app, store, call, dir, source, session } = await fixture(
    t,
    fetchImpl,
  );
  const root = join(dir, "vault");
  await mkdir(root);
  await writeFile(
    join(root, "Paper.md"),
    "# Personal literature note\nMy initial interpretation: bounded delays.\n",
  );
  await call("/settings", { vaultRoot: root });
  store.put("source", { ...source, notePath: "Paper.md" });
  const ask = async (key, contextOverrides) => {
    const run = await call(`/sessions/${session.id}/runs`, {
      text:
        key === "first"
          ? "Explain the paper"
          : "Compare that with my revised interpretation",
      idempotencyKey: key,
      selection: { provider: "ollama", model: "test-model" },
      budgets: { contextTokens: 32768 },
      ...(contextOverrides ? { contextOverrides } : {}),
    });
    return app.locals.agentHarness.wait(run.id);
  };
  const first = await ask("first");
  assert.equal(first.status, "completed");
  assert.ok(
    prompts[0].evidence.some((item) =>
      item.text.includes("My initial interpretation"),
    ),
  );
  assert.ok(
    prompts[0].evidence.some((item) =>
      item.text.includes("Introduction: the relevant citations"),
    ),
  );
  const noteEvidence = store
    .list("evidenceSnapshot")
    .find((item) => item.path === "Paper.md");
  assert.equal(noteEvidence.provenance.origin, "vault-note");
  assert.equal(noteEvidence.provenance.authorship, "not-inferred");
  await writeFile(
    join(root, "Paper.md"),
    "# Personal literature note\nRevised interpretation: arbitrary delays.\n",
  );
  const second = await ask("second");
  assert.equal(second.status, "completed");
  assert.ok(
    prompts[1].evidence.some((item) =>
      item.text.includes("Revised interpretation"),
    ),
  );
  assert.ok(
    !prompts[1].evidence.some((item) =>
      item.text.includes("My initial interpretation"),
    ),
  );
  assert.ok(
    prompts[1].history.some((item) => item.text.includes("Explain the paper")),
  );
  assert.ok(
    prompts[1].history.some((item) => item.text.includes("saved discussion")),
  );
  const excluded = await ask("excluded", {
    excludedEvidenceIds: [noteEvidence.id],
  });
  assert.equal(excluded.status, "completed");
  assert.ok(
    !prompts[2].evidence.some((item) =>
      item.text.includes("Revised interpretation"),
    ),
  );
  store.put("source", {
    ...source,
    kind: "reading-note",
    notePath: "Paper.md",
    pages: ["Stale original import"],
  });
  const noteOnly = await ask("note-only");
  assert.equal(noteOnly.status, "completed");
  assert.ok(
    prompts[3].evidence.some((item) =>
      item.text.includes("Revised interpretation"),
    ),
  );
  assert.ok(
    !prompts[3].evidence.some((item) =>
      item.text.includes("Stale original import"),
    ),
  );
});

test("Obsidian progress polling authenticates and replays bounded event batches without duplicates", async (t) => {
  const { app, store, boot, raw, call, session } = await fixture(t);
  const run = await call(`/sessions/${session.id}/runs`, {
    text: "Identify reference 11",
    idempotencyKey: "poll",
  });
  await app.locals.agentHarness.wait(run.id);
  assert.equal((await raw(`/runs/${run.id}/progress`)).status, 403);
  assert.equal(
    (
      await raw(`/runs/${run.id}/progress?after=-1`, undefined, {
        "X-Margin-Token": boot.token,
      })
    ).status,
    400,
  );
  for (let index = 0; index < 205; index++)
    store.appendAgentEvent(run.id, { type: "test.activity", index });
  const poll = async (after) => {
    const response = await raw(
      `/runs/${run.id}/progress?after=${after}`,
      undefined,
      { "X-Margin-Token": boot.token },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await poll(0);
  assert.equal(first.events.length, 200);
  assert.equal(first.more, true);
  const second = await poll(first.cursor);
  assert.equal(second.more, false);
  assert.ok(second.events.every((event) => event.seq > first.cursor));
  const last = await poll(second.cursor);
  assert.equal(last.events.length, 0);
  assert.equal(last.cursor, second.cursor);
  assert.equal(last.run.status, "completed");
});
