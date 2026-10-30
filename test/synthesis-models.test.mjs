import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "margin-synthesis-models-"));
  const filename = join(root, "research.sqlite"),
    store = new Store(filename);
  store.setting("agentHarness", false);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const calls = [];
  const state = { localOffline: false, cloudOffline: false };
  const proposal = (body) => {
    const context = JSON.parse(
      body.messages?.[1].content || body.input[0].content,
    );
    return JSON.stringify({
      changes: [
        {
          blockId: context.blocks[0].id,
          operation: "insert_after",
          text: "A tentative interpretation, with its qualification.",
          artifactRevisionIds: [context.inputs[0].artifactRevisionId],
          evidenceIds: [],
          rationale: "Keep the source-linked thought tentative.",
        },
      ],
      pending: [],
    });
  };
  const app = await createApp({
    store,
    dataDir: root,
    port: server.address().port,
    apiKey: "test-synthesis-secret",
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/tags")) {
        if (state.localOffline) throw new Error("local models offline");
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: "qwen3.8:27b-mlx", capabilities: ["completion"] },
              { name: "qwen3.6:35b-a3b", capabilities: ["completion"] },
              { name: "qwen3.8:27b-q4_K_M", capabilities: ["completion"] },
              { name: "remote:cloud", capabilities: ["completion"] },
              { name: "embed", capabilities: ["embedding"] },
            ],
          }),
        };
      }
      if (url.endsWith("/models"))
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "gpt-tutor" }, { id: "gpt-synthesis" }],
          }),
        };
      if (url.endsWith("/responses")) {
        if (state.cloudOffline)
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: { code: "rate_limit_exceeded" } }),
          };
        return {
          ok: true,
          json: async () => ({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: proposal(body) }],
              },
            ],
          }),
        };
      }
      if (url.endsWith("/chat"))
        return {
          ok: true,
          json: async () => ({ message: { content: proposal(body) } }),
        };
      throw new Error("Unexpected endpoint " + url);
    },
  });
  server.on("request", app);
  t.after(async () => {
    await app.locals.closeNotebook();
    await app.locals.agentHarness.stop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`,
    boot = await (await fetch(base + "/bootstrap")).json();
  async function call(path, body, status = 200) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Margin-Token": boot.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const source = store.put("source", {
    title: "A paper",
    kind: "source-excerpt",
    pages: ["An exact source passage."],
  });
  const session = store.put("session", {
    sourceId: source.id,
    workspaceId: boot.workspaces[0].id,
    page: 1,
  });
  const view = await call(`/sources/${source.id}/notebook`),
    docId = view.document.id;
  const capture = () =>
    store.put("artifact", {
      sessionId: session.id,
      origin: "user",
      kind: "thought",
      status: "open",
      text: "This might be the key qualification.",
      anchor: {
        sourceId: source.id,
        page: 1,
        quote: "An exact source passage.",
      },
      createdAt: new Date().toISOString(),
    });
  async function organize(input = {}) {
    capture();
    const run = await call(`/documents/${docId}/organize`, {
      retryKey: crypto.randomUUID(),
      ...input,
    });
    for (let count = 0; count < 200; count++) {
      const next = store.get("synthesisRun", run.id);
      if (next.status !== "running") return next;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Synthesis run did not finish");
  }
  return {
    root,
    filename,
    store,
    app,
    call,
    boot,
    calls,
    state,
    source,
    session,
    docId,
    capture,
    organize,
  };
}

test("synthesis Settings persist an independent provider/model and reject invalid pairs atomically", async (t) => {
  const f = await fixture(t);
  assert.equal(f.boot.config.synthesis.model, "qwen3.8:27b-q4_K_M");
  assert.equal(f.boot.config.synthesis.cloud, false);
  await f.call("/settings", { provider: "ollama", ollamaModel: "auto-local" });
  const saved = await f.call("/settings", {
    synthesis: { provider: "openai", model: "gpt-synthesis" },
  });
  assert.equal(saved.model, "auto-local");
  assert.equal(saved.provider, "ollama");
  assert.equal(saved.synthesis.model, "gpt-synthesis");
  assert.equal(saved.synthesis.provider, "openai");
  assert.equal(saved.synthesis.cloud, true);
  const reopened = new Store(f.filename);
  assert.deepEqual(reopened.setting("synthesisSelection"), {
    provider: "openai",
    model: "gpt-synthesis",
    cloud: true,
  });
  reopened.close();
  for (const choice of [
    { provider: "ollama", model: "gpt-synthesis" },
    { provider: "openai", model: "missing" },
    { provider: "ollama", model: "auto-local" },
    { provider: "ollama", model: "embed" },
  ])
    await f.call(
      "/settings",
      { synthesis: choice, provider: "ollama", ollamaModel: "qwen3.8:27b-mlx" },
      400,
    );
  const after = (await f.call("/bootstrap")).config;
  assert.equal(after.model, "auto-local");
  assert.deepEqual(after.synthesis, saved.synthesis);
  assert.equal(JSON.stringify(after).includes("test-synthesis-secret"), false);
  await f.call("/settings", {
    provider: "openai",
    model: "gpt-tutor",
    aiEnabled: true,
  });
  assert.equal(
    (await f.call("/bootstrap")).config.synthesis.model,
    "gpt-synthesis",
  );
});
test("local synthesis uses its configured model while Tutor selects a cloud model", async (t) => {
  const f = await fixture(t);
  await f.call("/settings", {
    provider: "openai",
    model: "gpt-tutor",
    aiEnabled: true,
  });
  const run = await f.organize();
  assert.equal(run.status, "completed");
  assert.deepEqual(run.selection, {
    provider: "ollama",
    model: "qwen3.8:27b-q4_K_M",
    cloud: false,
  });
  const request = f.calls.filter((c) => c.url.endsWith("/chat")).at(-1);
  assert.equal(request.body.model, "qwen3.8:27b-q4_K_M");
  assert.equal(request.body.format, "json");
  assert.equal((await f.call("/bootstrap")).config.model, "gpt-tutor");
});
test("explicit cloud synthesis uses its own OpenAI model and never runs automatically or falls back on failure", async (t) => {
  const f = await fixture(t);
  await f.call("/settings", {
    synthesis: { provider: "openai", model: "gpt-synthesis" },
  });
  f.capture();
  const before = f.calls.length;
  await f.call(
    `/documents/${f.docId}/organize`,
    { retryKey: "not-explicit" },
    400,
  );
  await f.call(
    `/documents/${f.docId}/organize`,
    { retryKey: "background", cloud: true, background: true },
    400,
  );
  assert.equal(f.calls.length, before);
  let run = await f.organize({ cloud: true });
  assert.equal(run.status, "completed");
  assert.deepEqual(run.selection, {
    provider: "openai",
    model: "gpt-synthesis",
    cloud: true,
  });
  const request = f.calls.filter((c) => c.url.endsWith("/responses")).at(-1);
  assert.equal(request.body.model, "gpt-synthesis");
  assert.equal(request.body.store, false);
  assert.equal((await f.call("/bootstrap")).config.model, "qwen3.8:27b-mlx");
  f.state.cloudOffline = true;
  const callsBefore = f.calls.length;
  run = await f.organize({ cloud: true });
  assert.equal(run.status, "failed");
  assert.match(run.error, /429/);
  assert.equal(f.calls.length, callsBefore + 1);
  assert.equal(f.calls.at(-1).body.model, "gpt-synthesis");
  assert.equal(f.store.get("literatureDocument", f.docId).markdown, "");
});
test("Ollama cloud synthesis remains labelled cloud if model discovery becomes unavailable", async (t) => {
  const f = await fixture(t);
  await f.call("/settings", {
    synthesis: { provider: "ollama", model: "remote:cloud" },
  });
  const run = await f.organize({ cloud: true });
  assert.equal(run.status, "completed");
  assert.deepEqual(run.selection, {
    provider: "ollama",
    model: "remote:cloud",
    cloud: true,
  });
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/chat")).at(-1).body.model,
    "remote:cloud",
  );
  f.state.localOffline = true;
  const refreshed = await f.call("/models/refresh", {});
  assert.equal(refreshed.synthesis.cloud, true);
  assert.equal(refreshed.synthesis.available, false);
  assert.equal(refreshed.synthesis.model, "remote:cloud");
  f.capture();
  const before = f.calls.length;
  await f.call(
    `/documents/${f.docId}/organize`,
    { retryKey: "background-offline", background: true },
    400,
  );
  assert.equal(f.calls.length, before);
});
