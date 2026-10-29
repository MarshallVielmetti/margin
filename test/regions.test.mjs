import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractNative,
  makeLayout,
  nativeBlocks,
  paddleLayout,
  hash,
} from "../server/regions.mjs";
import { hitRegions, boxStyle } from "../src/region-geometry.mjs";
import { pdfFixture } from "./fixtures/pdf.mjs";

test("real PDF extraction produces stable page anchors, nested definitions, and normalized geometry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "margin-regions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "source.pdf");
  await writeFile(file, pdfFixture());
  const layout = await extractNative("s1", file),
    again = await extractNative("s1", file);
  assert.equal(layout.revision, again.revision);
  assert.equal(layout.pageCount, 2);
  assert.equal(layout.regions.filter((r) => r.kind === "page").length, 2);
  const definition = layout.regions.find(
    (r) => r.kind === "definition" && r.heuristic,
  );
  assert.ok(definition);
  assert.match(definition.text, /shrinks distances/);
  const child = layout.regions.find((r) => r.parentId === definition.id);
  assert.ok(child);
  assert.ok(layout.regions.every((r) => r.box.every((n) => n >= 0 && n <= 1)));
  const changed = makeLayout("s1", "changed", [
    [
      {
        text: "A different chunk",
        kind: "paragraph",
        box: [0.1, 0.1, 0.5, 0.2],
      },
    ],
  ]);
  assert.notEqual(layout.revision, changed.revision);
  assert.equal(layout.contentHash, hash(new Uint8Array(pdfFixture())));
});
test("Paddle results preserve formula content and reject invalid geometry", () => {
  const layout = paddleLayout("s", "hash", [
    {
      width: 1000,
      height: 2000,
      blocks: [
        {
          text: "Definition 1. Stability",
          label: "text",
          box: [100, 100, 900, 200],
        },
        { text: "x_{k+1}=Ax_k", label: "formula", box: [200, 230, 800, 300] },
      ],
    },
  ]);
  const equation = layout.regions.find((r) => r.kind === "equation");
  assert.equal(equation.latex, "x_{k+1}=Ax_k");
  assert.deepEqual(equation.box, [0.2, 0.115, 0.8, 0.15]);
  assert.equal(
    layout.regions.find((r) => r.id === equation.parentId).kind,
    "definition",
  );
  assert.throws(
    () =>
      paddleLayout("s", "h", [
        {
          width: 1,
          height: 1,
          blocks: [{ text: "x", label: "text", box: [0.9, 0.1, 0.2, 0.4] }],
        },
      ]),
    /invalid region box/,
  );
});
test("hit testing picks inner equation before enclosing definition and ignores page background", () => {
  const regions = [
    { id: "p", kind: "page", box: [0, 0, 1, 1], order: 0 },
    { id: "d", kind: "definition", box: [0.1, 0.1, 0.9, 0.5], order: 1 },
    { id: "e", kind: "equation", box: [0.2, 0.2, 0.7, 0.3], order: 2 },
  ];
  assert.deepEqual(
    hitRegions(regions, 0.3, 0.25).map((r) => r.id),
    ["e", "d"],
  );
  assert.deepEqual(hitRegions(regions, 0.99, 0.99), []);
  assert.equal(boxStyle([0.1, 0.2, 0.5, 0.6]).left, "10%");
});
test("native geometry does not join text across a column gutter", () => {
  const items = [
    { str: "Left column", width: 180, transform: [12, 0, 0, 12, 50, 700] },
    { str: "Right column", width: 180, transform: [12, 0, 0, 12, 350, 700] },
  ];
  const multiply = (a, b) => [
    a[0] * b[0],
    0,
    0,
    a[3] * b[3],
    a[0] * b[4] + a[4],
    a[3] * b[5] + a[5],
  ];
  const result = nativeBlocks(
    items,
    { width: 612, height: 792, scale: 1, transform: [1, 0, 0, -1, 0, 792] },
    multiply,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Left column");
});
