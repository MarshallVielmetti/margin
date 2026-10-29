import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { askTutor, recallPrompt } from "../server/tutor.mjs";

test("full local workflow: index, import, capture, checkpoint, promotion, undo, persistence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "Paper.md");
  await writeFile(
    file,
    "---\ntags: [literature_note]\n---\n# Paper\n## Summary\nOriginal\n## Proof\nKeep this.\n",
  );
  const dbPath = join(dir, "test.sqlite"),
    store = new Store(dbPath);
  // Select an available loopback port first, then retain the same server for the application.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const app = await createApp({
    store,
    dataDir: dir,
    vaultRoot: dir,
    port,
    fetchImpl: async () => {
      throw new Error("offline test");
    },
  });
  server.on("request", app);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${port}`;
  const raw = async (path, body, headers = {}) =>
    fetch(url + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const boot = await (await raw("/bootstrap")).json();
  assert.equal(boot.config.vault.count, 1);
  assert.equal(boot.config.aiConfigured, false);
  assert.equal((await raw("/workspaces", { title: "No token" })).status, 403);
  assert.equal(
    (await raw("/bootstrap", undefined, { Origin: "https://foreign.example" }))
      .status,
    403,
  );
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      url + "/api/bootstrap",
      { headers: { Host: "foreign.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
  const post = async (path, body) => {
    const response = await raw(path, body, { "X-Margin-Token": boot.token });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const source = await post("/sources/from-note", { path: "Paper.md" });
  assert.equal(source.kind, "reading-note");
  const duplicate = await post("/sources/from-note", { path: "Paper.md" });
  assert.equal(duplicate.id, source.id);
  const session = await post("/sessions", {
    workspaceId: boot.workspaces[0].id,
    sourceId: source.id,
  });
  const anchor = {
    sourceId: source.id,
    page: 1,
    quote: "Original",
    section: "Summary",
  };
  const artifact = await post(`/sessions/${session.id}/artifacts`, {
    text: "My interpretation.",
    kind: "claim",
    assumptions: "A complete metric space.",
    anchor,
  });
  assert.equal(artifact.origin, "user");
  const prompt = await post(`/sessions/${session.id}/prompt`, {
    mode: "recall",
    anchor,
  });
  assert.equal(prompt.origin, "prompt");
  const draft = await post("/promotions", {
    sessionId: session.id,
    artifactIds: [artifact.id],
    path: "Paper.md",
    mode: "summary",
    text: artifact.text,
    heading: "Summary",
    links: [],
  });
  assert.match(await readFile(file, "utf8"), /Original/);
  assert.match(draft.after, /My interpretation/);
  assert.match(draft.after, /Keep this/);
  assert.match(draft.after, /not checked against the original/);
  const applied = await post(`/promotions/${draft.id}/apply`, {});
  assert.equal(applied.status, "applied");
  const repeat = await raw(
    `/promotions/${draft.id}/apply`,
    {},
    { "X-Margin-Token": boot.token },
  );
  assert.equal(repeat.status, 400);
  await post(`/promotions/${draft.id}/undo`, {});
  assert.match(await readFile(file, "utf8"), /Original/);
  const forged = await raw(
    "/promotions",
    {
      sessionId: session.id,
      artifactIds: [prompt.id],
      path: "Paper.md",
      mode: "append",
      text: "AI text as mine",
    },
    { "X-Margin-Token": boot.token },
  );
  assert.equal(forged.status, 400);
  const invalidAnchor = await raw(
    `/sessions/${session.id}/artifacts`,
    { text: "Wrong source", anchor: { ...anchor, page: 99 } },
    { "X-Margin-Token": boot.token },
  );
  assert.equal(invalidAnchor.status, 400);
  const disabledTutor = await raw(
    `/sessions/${session.id}/tutor`,
    { text: "Explain it" },
    { "X-Margin-Token": boot.token },
  );
  assert.equal(disabledTutor.status, 400);
  const exportData = await (await raw("/export")).json();
  assert.equal(exportData.artifacts.length, 2);
  assert.equal(exportData.promotions[0].before.includes("Original"), true);
  const otherStore = new Store(dbPath);
  assert.equal(
    otherStore.get("artifact", artifact.id).assumptions,
    "A complete metric space.",
  );
  otherStore.close();
});

test("tutor uses explicit provenance, bounded context, and storage opt-out without leaking its key", async () => {
  let submitted;
  const result = await askTutor({
    question: "Why is completeness needed?",
    source: {
      title: "Personal proof",
      kind: "reading-note",
      pages: ["Proof attempt."],
    },
    anchor: { page: 1, quote: "Proof attempt." },
    notes: [
      {
        title: "Banach",
        path: "Banach.md",
        line: 4,
        excerpt: "Complete metric space.",
      },
    ],
    history: [{ origin: "user", kind: "thought", text: "I am not sure." }],
    model: "test-model",
    key: "test-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      submitted = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Where does your sequence converge? [N1]",
                },
              ],
            },
          ],
        }),
      };
    },
  });
  assert.equal(submitted.store, false);
  assert.match(submitted.instructions, /untrusted data/);
  assert.match(submitted.input[0].content, /reading-note/);
  assert.doesNotMatch(submitted.input[0].content, /test-secret/);
  assert.equal(result.origin, "ai");
  assert.equal(result.status, "unverified");
  assert.equal(result.evidence[1].id, "N1");
});

test("tutor failures are reported as failures instead of fabricated answers", async () => {
  await assert.rejects(
    askTutor({
      question: "Test",
      source: { title: "Test", kind: "pdf", pages: ["Text"] },
      notes: [],
      history: [],
      key: "x",
      model: "x",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: "rate_limit_exceeded" } }),
      }),
    }),
    /429, rate_limit_exceeded/,
  );
});

test("offline prompts never masquerade as a model response or assessment of mastery", () => {
  const prompt = recallPrompt(
    { title: "Source" },
    { page: 3, section: "Lemma 1" },
    "recall",
  );
  assert.equal(prompt.origin, "prompt");
  assert.equal(prompt.status, "unverified");
  assert.match(prompt.text, /Lemma 1/);
  assert.match(prompt.text, /compare your answer/);
});

test("SQLite transaction rolls back incomplete record updates", () => {
  const store = new Store(":memory:");
  assert.throws(() =>
    store.transaction(() => {
      store.put("artifact", { id: "a", text: "temporary" });
      throw new Error("fail");
    }),
  );
  assert.equal(store.get("artifact", "a"), undefined);
  store.close();
});
