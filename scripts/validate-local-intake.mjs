import { Store } from "../server/store.mjs";
import { Intake } from "../server/intake.mjs";
import { Ollama } from "../server/ollama.mjs";
import { Retrieval } from "../server/retrieval.mjs";
import { parseNote } from "../server/vault.mjs";
import { makeLayout } from "../server/regions.mjs";
import { setTimeout as delay } from "node:timers/promises";
const ollama = new Ollama();
const models = await ollama.models();
const model = process.argv[2] || "qwen3.6:35b-a3b";
const store = new Store(":memory:");
const layout = makeLayout("live-validation", "fixture", [
  [
    {
      text: "A contraction T on a complete metric space satisfies d(Tx,Ty) <= q d(x,y) for 0 <= q < 1. The Banach fixed-point theorem gives a unique fixed point.",
      kind: "paragraph",
      box: [0.1, 0.1, 0.9, 0.3],
    },
  ],
]);
const notes = [
  parseNote(
    "Contraction Mappings.md",
    "# Contraction Mappings\n## Statement\nA contraction shrinks distances by a factor q < 1. Completeness is required for the fixed-point existence theorem.",
  ),
];
const intake = new Intake({
  store,
  ollama,
  retrieval: new Retrieval(store, ollama),
  getSource: () => ({
    id: "live-validation",
    kind: "pdf",
    title: "Controlled contraction fixture",
    pages: ["fixture"],
  }),
  getFile: async () => "/fixture.pdf",
  getNotes: async () => notes,
  getModels: () => models,
  extractors: { native: async () => layout },
});
const job = intake.start("live-validation", { model });
const start = Date.now();
while (
  ["queued", "running", "cancelling"].includes(
    store.get("intakeJob", job.id).status,
  )
)
  await delay(200);
const result = store.get("intakeJob", job.id),
  context = store.list("chunkContext")[0];
console.log(
  JSON.stringify(
    {
      status: result.status,
      model,
      durationMs: Date.now() - start,
      chunks: result.done,
      summary: context?.analysis?.summary,
      noteLinks: context?.analysis?.noteLinks.length,
      error:
        context?.error ||
        (result.status === "failed" && result.message) ||
        null,
    },
    null,
    2,
  ),
);
store.close();
if (result.status !== "complete") process.exitCode = 1;
