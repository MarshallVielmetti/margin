import test from "node:test";
import assert from "node:assert/strict";
import { nativeBlocks, makeLayout } from "../server/regions.mjs";
import { hitRegions } from "../src/region-geometry.mjs";
const viewport = {
  width: 600,
  height: 800,
  scale: 1,
  transform: [1, 0, 0, -1, 0, 800],
};
const transform = (a, b) => [
  a[0] * b[0],
  0,
  0,
  a[3] * b[3],
  a[0] * b[4] + a[4],
  a[3] * b[5] + a[5],
];
const item = (str, x, y, width, h = 10) => ({
  str,
  width,
  transform: [h, 0, 0, h, x, y],
});
export const equationItems = [
  item("The optimization enforces the following constraints.", 45, 740, 240),
  item("x", 95, 700, 6),
  item("i,k+1", 101, 698, 24, 7),
  item("=", 135, 700, 8),
  item("f(x,u)", 150, 700, 60),
  item("(11a)", 277, 700, 24),
  item("u", 95, 685, 6),
  item("i,k", 101, 683, 14, 7),
  item("∈ U", 135, 685, 26),
  item("(11b)", 277, 685, 24),
  item("c(p)", 95, 670, 28),
  item("k|t", 123, 668, 14, 7),
  item("≤ 0", 145, 670, 23),
  item("(11c)", 277, 670, 24),
  item(
    "The next paragraph explains feasibility and assumptions.",
    45,
    640,
    245,
  ),
  item("An unrelated paragraph in the right column.", 330, 700, 230),
];
test("multiline math keeps scripts, separated equation labels, and full rows in one block", () => {
  const blocks = nativeBlocks(equationItems, viewport, transform);
  const group = blocks.find(
    (b) =>
      b.kind === "equation" &&
      b.text.includes("(11a)") &&
      b.text.includes("(11c)"),
  );
  assert.ok(
    group,
    "aligned constraints should form one selectable equation block",
  );
  assert.match(group.text, /i,k\+1/);
  assert.match(group.text, /∈ U/);
  assert.ok(group.box[0] <= 95 / 600 && group.box[2] >= 301 / 600);
  assert.ok(group.box[1] <= 90 / 800 && group.box[3] >= 132 / 800);
  assert.doesNotMatch(group.text, /unrelated|next paragraph/);
});
test("the default equation hit selects its entire block, with inner rows still available", () => {
  const layout = makeLayout("s", "hash", [
    nativeBlocks(equationItems, viewport, transform),
  ]);
  const rows = layout.regions.filter((r) => r.role === "equation-line");
  assert.ok(rows.length >= 3);
  const first = rows[0],
    hits = hitRegions(
      layout.regions,
      (first.box[0] + first.box[2]) / 2,
      (first.box[1] + first.box[3]) / 2,
    );
  assert.equal(hits[0].kind, "equation");
  assert.notEqual(hits[0].id, first.id);
  assert.ok(hits.some((r) => r.id === first.id));
});
test("additive selection toggles disjoint regions and removes overlapping ancestors", async () => {
  const { toggleRegions } = await import("../src/region-geometry.mjs");
  const a = { id: "a", page: 1, parentId: "p" },
    b = { id: "b", page: 2, parentId: "q" },
    p = { id: "p", page: 1, parentId: null };
  assert.deepEqual(
    toggleRegions([a], b, true, [a, b, p]).map((r) => r.id),
    ["a", "b"],
  );
  assert.deepEqual(
    toggleRegions([a, b], a, true, [a, b, p]).map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(
    toggleRegions([a, b], p, true, [a, b, p]).map((r) => r.id),
    ["b", "p"],
  );
  assert.deepEqual(
    toggleRegions([p, b], a, true, [a, b, p]).map((r) => r.id),
    ["b", "a"],
  );
  assert.deepEqual(
    toggleRegions([a, b], a, false, [a, b, p]).map((r) => r.id),
    ["a"],
  );
});

test("multi-region anchors preserve separate page geometry and text through reload", async () => {
  const { selectionAnchor, selectedRegions } =
    await import("../src/region-geometry.mjs");
  const regions = [
    {
      id: "a",
      sourceId: "s",
      page: 1,
      kind: "equation",
      text: "x = 1",
      box: [0.1, 0.1, 0.4, 0.2],
      order: 1,
    },
    {
      id: "b",
      sourceId: "s",
      page: 2,
      kind: "paragraph",
      text: "The explanation.",
      box: [0.1, 0.2, 0.8, 0.4],
      order: 1,
    },
  ];
  const anchor = selectionAnchor("s", 2, regions, "revision");
  assert.equal(anchor.regionId, undefined);
  assert.equal(anchor.regions.length, 2);
  assert.deepEqual(
    selectedRegions(JSON.parse(JSON.stringify(anchor)), []).map((r) => ({
      id: r.id,
      page: r.page,
      box: r.box,
    })),
    regions.map(({ id, page, box }) => ({ id, page, box })),
  );
  assert.match(anchor.quote, /x = 1/);
  assert.match(anchor.quote, /The explanation/);
});
