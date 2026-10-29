import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { pdfFixture } from "./fixtures/pdf.mjs";
import { extractNative } from "../server/regions.mjs";

test("region API persists anchored notes, exports bundles, and supplies fresh intake context to the tutor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-chunk-api-"));
  const noteFile = join(dir, "Contraction.md");
  await writeFile(
    noteFile,
    "# Contraction\n## Statement\nA contraction shrinks distances in a complete metric space.",
  );
  const store = new Store(join(dir, "research.sqlite"));
  store.setting("ollamaModel", "local");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let submitted;
  const app = await createApp({
    store,
    dataDir: dir,
    vaultRoot: dir,
    intakeExtractors: {
      native: extractNative,
      paddle: async (...args) => {
        const result = await extractNative(...args);
        return {
          ...result,
          extractor: "paddle",
          revision: "alternate-layout",
          regions: result.regions.map((r) => ({
            ...r,
            id: r.id + ":alternate",
            parentId: r.parentId ? r.parentId + ":alternate" : null,
          })),
        };
      },
    },
    port,
    fetchImpl: async (url, opts) => ({
      ok: true,
      json: async () => {
        if (url.endsWith("/tags"))
          return { models: [{ name: "local", capabilities: ["completion"] }] };
        if (url.endsWith("/chat")) {
          submitted = JSON.parse(opts.body);
          return {
            message: { content: "The contraction uses completeness [S1]." },
            done_reason: "stop",
          };
        }
        return {};
      },
    }),
  });
  server.on("request", app);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/api`;
  const boot = await (await fetch(base + "/bootstrap")).json();
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-Margin-Token": boot.token,
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  await writeFile(join(dir, "sources", "fixture.pdf"), pdfFixture());
  const source = store.put("source", {
    title: "Fixed point paper",
    kind: "pdf",
    file: "fixture.pdf",
    pages: ["", "Theorem 2. Existence of a fixed point."],
  });
  const session = await call("/sessions", {
    sourceId: source.id,
    workspaceId: boot.workspaces[0].id,
  });
  const missingToken = await fetch(base + `/sources/${source.id}/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingToken.status, 403);
  await call(`/sources/${source.id}/intake`, {});
  let state;
  for (let i = 0; i < 150; i++) {
    state = await call(`/sources/${source.id}/regions`);
    if (["complete", "failed"].includes(state.job?.status)) break;
    await delay(10);
  }
  assert.equal(state.job.status, "complete");
  const region = state.layout.regions.find((r) => r.kind === "definition");
  assert.ok(region);
  const anchor = {
    sourceId: source.id,
    page: region.page,
    regionId: region.id,
    revision: state.layout.revision,
    box: region.box,
    quote: region.text,
  };
  const note = await call(`/sessions/${session.id}/artifacts`, {
    text: "My question about this definition.",
    anchor,
  });
  assert.equal(note.anchor.regionId, region.id);
  assert.deepEqual(note.anchor.box, region.box);
  const bundles = await call(
    `/sources/${source.id}/chunks?regionId=${encodeURIComponent(region.id)}`,
  );
  assert.equal(bundles.contexts.length, 1);
  assert.equal(bundles.contexts[0].stale, false);
  const answer = await call(`/sessions/${session.id}/tutor`, {
    text: "Explain this definition.",
    anchor,
  });
  assert.ok(
    answer.evidence.some((e) => e.id === "C1" || e.handles?.includes("C1")),
  );
  assert.match(
    answer.evidence.find((e) => e.id === "S1" || e.handles?.includes("S1"))
      .text,
    /contraction/i,
    "recognized region content must be available even when the original text layer is empty",
  );
  assert.match(submitted.messages[1].content, /saved chunk context/);
  await writeFile(noteFile, "# Contraction\nCompletely revised content.");
  const stale = await call(
    `/sources/${source.id}/chunks?regionId=${encodeURIComponent(region.id)}`,
  );
  assert.equal(stale.contexts[0].stale, true);
  const after = await call(`/sessions/${session.id}/tutor`, {
    text: "Explain this definition.",
    anchor,
  });
  assert.ok(
    after.evidence.every(
      (e) =>
        !e.id.startsWith("C") &&
        !e.handles?.some((handle) => /^C\d+$/.test(handle)),
    ),
  );
  assert.ok(
    after.evidence
      .filter((e) => e.path)
      .every((e) => !e.text.includes("shrinks distances")),
    "changed vault passages must not be reused",
  );
  await call(`/sources/${source.id}/intake`, { extractor: "paddle" });
  for (let i = 0; i < 100; i++) {
    const latest = await call(`/sources/${source.id}/regions`);
    if (latest.job.status === "complete") break;
    await delay(10);
  }
  const previousNote = await call(`/sessions/${session.id}/artifacts`, {
    text: "Annotation on the prior extraction",
    anchor,
  });
  assert.equal(previousNote.anchor.revision, anchor.revision);
  const historical = await call(
    `/sources/${source.id}/chunks?regionId=${encodeURIComponent(region.id)}&revision=${anchor.revision}`,
  );
  assert.equal(historical.contexts.length, 1);
  const exported = await call("/export");
  assert.equal(exported.layoutSnapshots.length, 2);
  assert.ok(exported.chunkContexts.length);
  assert.equal(exported.documentLayouts[0].sourceId, source.id);
  const invalid = await fetch(base + `/sessions/${session.id}/artifacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Margin-Token": boot.token,
    },
    body: JSON.stringify({
      text: "wrong region",
      anchor: { ...anchor, regionId: "invented" },
    }),
  });
  assert.equal(invalid.status, 400);
});
