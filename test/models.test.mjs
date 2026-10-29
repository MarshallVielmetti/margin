import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

test("model picker defaults to Qwen, persists selection, and routes local and cloud requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-models-"));
  const store = new Store(":memory:");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const requests = [];
  let localOffline = false;
  let cloudOffline = false;
  let bothQwens = false;
  let route = "fast";
  const fetchImpl = async (url, options = {}) => {
    const body = options.body && JSON.parse(options.body);
    requests.push({ url, body, headers: options.headers });
    if (url.startsWith("http://127.0.0.1:11434") && localOffline)
      throw new Error("offline");
    if (url.endsWith("/tags"))
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: "gemma4:12b", capabilities: ["completion"] },
            { name: "qwen3.8:27b-mlx", capabilities: ["completion"] },
            ...(bothQwens
              ? [{ name: "qwen3.6:35b-a3b", capabilities: ["completion"] }]
              : []),
            { name: "embed", capabilities: ["embedding"] },
            { name: "remote:cloud", capabilities: ["completion"] },
            { name: "broken" },
          ],
        }),
      };
    if (url.endsWith("/show")) throw new Error("one model is unavailable");
    if (url.endsWith("/models")) {
      if (cloudOffline) throw new Error("offline");
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "gpt-test" },
            { id: "text-embedding-test" },
            { id: "gpt-image-test" },
            { id: "gpt-realtime-test" },
          ],
        }),
      };
    }
    if (url.endsWith("/chat"))
      return {
        ok: true,
        json: async () => ({
          message: {
            content: body.format
              ? JSON.stringify({ route, reason: "Task complexity" })
              : "Local evidence [S1].",
          },
        }),
      };
    if (url.endsWith("/responses"))
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Cloud evidence [S1]." }],
            },
          ],
        }),
      };
    throw new Error(`Unexpected request: ${url}`);
  };
  server.on(
    "request",
    await createApp({
      store,
      dataDir: dir,
      port: server.address().port,
      apiKey: "secret-test-key",
      fetchImpl,
    }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const boot = await (await fetch(base + "/bootstrap")).json();
  const post = async (path, body, status = 200) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Margin-Token": boot.token,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  assert.equal(boot.config.model, "qwen3.8:27b-mlx");
  assert.equal(boot.config.provider, "ollama");
  assert.equal(boot.config.aiEnabled, true);
  assert.equal(boot.config.embeddingModel, "embed");
  assert.deepEqual(
    boot.config.chatModels.map((m) => m.name),
    ["gemma4:12b", "qwen3.8:27b-mlx", "remote:cloud", "gpt-test"],
  );
  assert.equal(JSON.stringify(boot).includes("secret-test-key"), false);
  const source = store.put("source", {
    title: "Paper",
    kind: "pdf",
    pages: ["Source evidence"],
  });
  const session = store.put("session", {
    sourceId: source.id,
    workspaceId: boot.workspaces[0].id,
    page: 1,
  });
  const ask = () => post(`/sessions/${session.id}/tutor`, { text: "Explain" });
  assert.equal((await ask()).model, "qwen3.8:27b-mlx");
  assert.equal(requests.at(-1).body.model, "qwen3.8:27b-mlx");
  await post(
    "/settings",
    { provider: "ollama", ollamaModel: "auto-local" },
    400,
  );
  bothQwens = true;
  const withAuto = await post("/models/refresh", {});
  assert.equal(withAuto.chatModels[0].name, "auto-local");
  await post("/settings", {
    provider: "ollama",
    ollamaModel: "auto-local",
    localAiEnabled: true,
  });
  for (const choice of ["fast", "deep"]) {
    route = choice;
    const answer = await ask();
    assert.equal(
      answer.model,
      choice === "fast" ? "qwen3.6:35b-a3b" : "qwen3.8:27b-mlx",
    );
    assert.equal(answer.cloud, false);
    assert.equal(answer.routing.fallback, false);
    assert.equal(requests.at(-1).body.model, answer.model);
  }
  await post("/settings", {
    provider: "ollama",
    ollamaModel: "qwen3.8:27b-mlx",
  });
  await post("/settings", { provider: "ollama", ollamaModel: "embed" }, 400);
  await post("/settings", { provider: "ollama", ollamaModel: "missing" }, 400);
  assert.equal(store.setting("ollamaModel"), "qwen3.8:27b-mlx");
  await post("/settings", {
    provider: "ollama",
    ollamaModel: "remote:cloud",
    localAiEnabled: true,
  });
  assert.equal((await ask()).cloud, true);
  await post("/settings", {
    provider: "openai",
    model: "gpt-test",
    aiEnabled: true,
  });
  assert.equal(store.setting("provider"), "openai");
  const answer = await ask();
  assert.equal(answer.provider, "openai");
  assert.equal(requests.at(-1).url, "https://api.openai.com/v1/responses");
  assert.equal(requests.at(-1).body.model, "gpt-test");
  // Local failures must not hide a configured cloud provider.
  localOffline = true;
  const refreshed = await post("/models/refresh", {});
  assert.equal(refreshed.model, "gpt-test");
  assert.deepEqual(
    refreshed.chatModels.map((m) => m.name),
    ["gpt-test"],
  );
  localOffline = false;
  cloudOffline = true;
  const cloudFailed = await post("/models/refresh", {});
  assert.ok(cloudFailed.chatModels.some((m) => m.name === "qwen3.8:27b-mlx"));
  await post("/settings", {
    provider: "ollama",
    ollamaModel: "gemma4:12b",
    localAiEnabled: true,
  });
  assert.equal((await ask()).model, "gemma4:12b");
});

test("missing default stays visible without silently selecting another model", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-offline-model-"));
  const store = new Store(":memory:");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  server.on(
    "request",
    await createApp({
      store,
      dataDir: dir,
      port: server.address().port,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
  );
  const boot = await (
    await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`)
  ).json();
  assert.equal(boot.config.model, "qwen3.8:27b-mlx");
  assert.equal(boot.config.aiEnabled, false);
  assert.equal(boot.config.openaiConfigured, false);
  const rejected = await fetch(
    `http://127.0.0.1:${server.address().port}/api/settings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Margin-Token": boot.token,
      },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-test",
        aiEnabled: true,
      }),
    },
  );
  assert.equal(rejected.status, 400);
  assert.equal(store.setting("provider"), undefined);
});
