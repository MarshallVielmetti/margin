import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import express from "express";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { pdfFixture } from "../test/fixtures/pdf.mjs";
const dir = await mkdtemp(join(tmpdir(), "margin-regions-qa-")),
  vault = join(dir, "vault");
await mkdir(vault);
await mkdir(join(dir, "sources"));
await writeFile(
  join(vault, "Contraction Mappings.md"),
  "---\ntags: [definition]\n---\n# Contraction Mappings\n## Statement\nA contraction shrinks distances in a complete metric space.\nThe contraction factor satisfies 0 <= q < 1.\n## Context\nCompleteness ensures that the Cauchy sequence converges to a point in the space.",
);
await writeFile(join(dir, "sources", "fixture.pdf"), pdfFixture());
const store = new Store(join(dir, "research.sqlite"));
const source = store.put("source", {
  title: "Fixed points and completeness",
  authors: "Local PDF fixture",
  kind: "pdf",
  file: "fixture.pdf",
  pages: [
    "Definition 1. A contraction mapping. A map shrinks distances in a complete metric space.",
    "Theorem 2. Existence of a fixed point. A contraction on a complete metric space has a unique fixed point.",
  ],
});
const port = Number(process.env.PORT || 4320);
const app = await createApp({ store, dataDir: dir, vaultRoot: vault, port });
const session = store.put("session", {
  sourceId: source.id,
  workspaceId: store.list("workspace")[0].id,
  title: source.title,
  page: 1,
  status: "active",
  takeaway: "",
  createdAt: new Date().toISOString(),
});
app.use(express.static(resolve("dist")));
app.get("/{*path}", (req, res) => res.sendFile(resolve("dist/index.html")));
const server = createServer(app);
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${port}/?session=${session.id}`,
      dir,
      sourceId: source.id,
    }),
  ),
);
