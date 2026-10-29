import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama, localEndpoint } from "../server/ollama.mjs";
import { ZoteroLibrary, checkedPdf, citationKey } from "../server/zotero.mjs";
import { askTutor } from "../server/tutor.mjs";
import { Retrieval } from "../server/retrieval.mjs";
import { Store } from "../server/store.mjs";
import { parseNote } from "../server/vault.mjs";
test("Ollama uses local chat and identifies cloud models separately from embeddings", async () => {
  const requests = [];
  const o = new Ollama(undefined, async (url, options) => {
    const b = options.body && JSON.parse(options.body);
    requests.push({ url, b });
    return {
      ok: true,
      json: async () =>
        url.endsWith("/tags")
          ? {
              models: [
                { name: "chat" },
                { name: "embed" },
                { name: "remote:cloud" },
              ],
            }
          : url.endsWith("/show")
            ? {
                capabilities: [
                  b.model === "embed" ? "embedding" : "completion",
                ],
              }
            : {
                message: { content: "Check the assumption [S1]." },
                done_reason: "stop",
              },
    };
  });
  const models = await o.models();
  assert.deepEqual(
    models.map((m) => m.name),
    ["chat", "embed", "remote:cloud"],
  );
  assert.equal(models.find((m) => m.name === "remote:cloud").cloud, true);
  const a = await askTutor({
    provider: "ollama",
    ollama: o,
    model: "chat",
    mode: "assumptions",
    question: "Explain",
    source: { title: "Paper", kind: "pdf", pages: ["Bounded delays"] },
    notes: [],
    history: [],
  });
  assert.equal(a.provider, "ollama");
  assert.equal(a.status, "unverified");
  assert.match(requests.at(-1).b.messages[0].content, /quantifiers/);
  assert.equal(requests.at(-1).b.stream, false);
  assert.ok(requests.every((r) => r.url.startsWith("http://127.0.0.1:11434/")));
  assert.throws(() => localEndpoint("https://remote.example"));
  assert.throws(() => localEndpoint("http://user:pass@localhost"));
});
test("Zotero resolves citation keys, preserves ambiguous PDFs, blocks escaped paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-zotero-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "storage"));
  await writeFile(join(dir, "storage", "paper.pdf"), "%PDF-1.4");
  await writeFile(join(dir, "outside.pdf"), "%PDF-1.4");
  await symlink(join(dir, "outside.pdf"), join(dir, "storage", "escape.pdf"));
  const note = {
    path: "refs/@example.md",
    content: "[Zotero](zotero://select/items/@example)",
    metadata: {},
  };
  assert.equal(citationKey(note), "example");
  const z = new ZoteroLibrary({
    dataDir: dir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        result: [
          {
            open: "zotero://open-pdf/library/items/ABCD1234",
            path: join(dir, "storage", "paper.pdf"),
          },
          {
            open: "zotero://open-pdf/library/items/EFGH1234",
            path: join(dir, "storage", "escape.pdf"),
          },
        ],
      }),
    }),
  });
  const a = await z.attachments(note);
  assert.equal(a.length, 2);
  assert.equal(a[0].available, true);
  assert.equal(a[1].available, false);
  await assert.rejects(
    checkedPdf(join(dir, "outside.pdf"), z.roots),
    /outside/,
  );
});
test("semantic index reuses unchanged embeddings and excludes changed notes", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const r = new Retrieval(store, {
    embed: async (_, texts) => {
      calls++;
      return texts.map(() => [1, 0]);
    },
  });
  const n = parseNote(
    "Concept.md",
    "# Concept\nA bounded communication delay is essential for this statement.",
  );
  await r.build([n], "embed");
  const count = calls;
  await r.build([n], "embed");
  assert.equal(calls, count);
  assert.equal(r.statusFor([n], "embed").stale, false);
  const changed = parseNote(
    "Concept.md",
    "# Concept\nThis completely changed.",
  );
  const result = await r.retrieve(
    [changed],
    "delays",
    { notePath: "other" },
    "embed",
  );
  assert.ok(
    result.notes.every((n) => !n.excerpt.includes("bounded communication")),
  );
  store.close();
});
