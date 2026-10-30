import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

test("versioned notebook HTTP contracts preserve revisions, local drafts, note syncing, and complete exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-notebook-api-"));
  await writeFile(
    join(root, "Paper.md"),
    "---\nsummary: Existing summary\n---\n# Paper\n\n## Understanding\n\nOriginal understanding.\n",
  );
  const store = new Store(join(root, "history.sqlite"));
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const app = await createApp({
    store,
    dataDir: root,
    vaultRoot: root,
    port,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  server.on("request", app);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await app.locals.agentHarness.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/api`;
  const boot = await (await fetch(base + "/bootstrap")).json();
  async function call(path, body, method, expected = 200) {
    const response = await fetch(base + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        "X-Margin-Token": boot.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  const source = await call("/sources/from-note", {
    path: "Paper.md",
    noteOnly: true,
  });
  const session = await call("/sessions", {
    sourceId: source.id,
    workspaceId: boot.workspaces[0].id,
  });
  const anchor = {
    sourceId: source.id,
    page: 1,
    quote: "Original understanding.",
  };
  const a = await call(`/sessions/${session.id}/artifacts`, {
    text: "My original wording",
    anchor,
    surface: "thoughts",
    captureKey: "capture-key",
  });
  const retry = await call(`/sessions/${session.id}/artifacts`, {
    text: "My original wording",
    anchor,
    surface: "thoughts",
    captureKey: "capture-key",
  });
  assert.equal(retry.id, a.id);
  const edited = await call(
    `/artifacts/${a.id}`,
    { text: "My corrected wording", expectedRevision: 0 },
    "PATCH",
  );
  assert.equal(edited.revision, 1);
  await call(
    `/artifacts/${a.id}`,
    { text: "Stale edit", expectedRevision: 0 },
    "PATCH",
    409,
  );
  const history = await call(`/artifacts/${a.id}/revisions`);
  assert.equal(history.revisions[0].text, "My original wording");
  const state = {
    schemaVersion: 1,
    mode: "tutor",
    thoughts: {
      text: "Unsent thought",
      anchor,
      start: 3,
      end: 4,
      scroll: 80,
      interim: "unfinished",
    },
    tutor: {
      text: "Unsent question",
      anchor,
      start: 2,
      end: 2,
      scroll: 20,
      interim: "",
    },
    synthesis: { start: 5, end: 5, scroll: 40 },
    activeThread: "",
    tabCycles: true,
  };
  await call(`/sources/${source.id}/notebook-state/client-a`, state, "PUT");
  assert.equal(
    (await call(`/sources/${source.id}/notebook-state/client-a`)).thoughts
      .anchor.page,
    1,
  );
  assert.equal(
    await call(`/sources/${source.id}/notebook-state/client-b`),
    null,
  );
  let view = await call(`/sources/${source.id}/notebook`);
  const docId = view.document.id;
  assert.match(view.document.markdown, /Existing summary/);
  view = await call(
    `/documents/${docId}`,
    {
      expectedRevision: 0,
      markdown: view.document.markdown + "\nA direct local edit.\n",
    },
    "PATCH",
  );
  const conflict = await call(
    `/documents/${docId}`,
    { expectedRevision: 0, markdown: "stale" },
    "PATCH",
    409,
  );
  assert.equal(conflict.current.revision, 1);
  view = await call(`/documents/${docId}/connect`, {
    expectedRevision: 1,
    path: "Paper.md",
    syncEnabled: true,
    syncMethod: "closed-note",
  });
  view = await call(`/documents/${docId}/sync`, {});
  assert.equal(view.document.syncStatus, "synced");
  assert.match(
    await readFile(join(root, "Paper.md"), "utf8"),
    /A direct local edit/,
  );
  const pendingModel = await call("/settings", {
    synthesis: { provider: "ollama", model: "qwen3.8:27b-q4_K_M" },
  });
  assert.equal(pendingModel.synthesis.model, "qwen3.8:27b-q4_K_M");
  await call(
    "/settings",
    { synthesis: { provider: "ollama", model: "unavailable:cloud" } },
    undefined,
    400,
  );
  const unchangedTutor = (await call("/bootstrap")).config;
  assert.equal(unchangedTutor.model, boot.config.model);
  assert.equal(unchangedTutor.provider, boot.config.provider);
  await call(
    `/documents/${docId}/organize`,
    { retryKey: "offline-organization" },
    undefined,
    400,
  );
  assert.match(
    (await call(`/documents/${docId}`)).document.markdown,
    /A direct local edit/,
  );
  const exported = await call("/export");
  assert.equal(exported.notebookSchemaVersion, 1);
  assert.equal(exported.literatureDocuments.length, 1);
  assert.ok(exported.documentRevisions.length >= 3);
  assert.equal(exported.annotationRevisions[0].text, "My original wording");
  assert.equal(exported.notebookStates[0].tutor.text, "Unsent question");
  await call(`/sessions/${session.id}/research-history/delete`, {});
  assert.equal(
    (await call(`/documents/${docId}`)).document.markdown,
    view.document.markdown,
  );
});
