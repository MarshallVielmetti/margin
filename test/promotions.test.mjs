import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  preparePromotion,
  applyPromotion,
  undoPromotion,
  updateSummary,
  updateSection,
} from "../server/promotions.mjs";
const original =
  "---\ntitle: Paper\ntags: [literature_note]\n---\n## Summary\nOld summary.\n\n## Notes\nMy original derivation.\n\n### Proof\nUntouched mathematics: $x^2$.\n";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "margin-promotion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "Paper.md"), original);
  return root;
}
const request = {
  path: "Paper.md",
  mode: "summary",
  text: "My own short explanation.",
  heading: "Summary",
  links: [],
};

test("summary edits preserve frontmatter and every subsequent section verbatim", () => {
  const after = updateSummary(original, "A new summary.");
  assert.equal(
    after.slice(after.indexOf("## Notes")),
    original.slice(original.indexOf("## Notes")),
  );
  assert.equal(
    after.slice(0, after.indexOf("## Summary")),
    original.slice(0, original.indexOf("## Summary")),
  );
  assert.match(after, /## Summary\nA new summary\./);
  assert.doesNotMatch(after, /Old summary/);
});

test("ignores headings inside code fences when choosing the summary boundary", () => {
  const value =
    "## Summary\nOld\n```md\n## Not a boundary\n```\n### Detail\nOld too\n## Proof\nKeep exactly.\n";
  const after = updateSummary(value, "New");
  assert.equal(after, "## Summary\nNew\n\n## Proof\nKeep exactly.\n");
});

test("preserves CRLF endings when appending a section", () => {
  const after = updateSection(
    "## Intuition\r\nOld\r\n## Proof\r\nKeep\r\n",
    "Intuition",
    "First\nSecond",
  );
  assert.match(after, /Old\r\n\r\nFirst\r\nSecond\r\n\r\n## Proof\r\nKeep\r\n/);
  assert.equal(after.replaceAll("\r\n", "").includes("\n"), false);
});

test("updates a YAML summary property when there is no Summary section", () => {
  const source =
    "---\ntitle: Paper\nsummary: Old\nauthors: Person\n---\n## Notes\nDo not touch.\n";
  const after = updateSummary(source, "First sentence.\nSecond sentence.");
  assert.equal(
    parse(after.split("---")[1]).summary,
    "First sentence.\nSecond sentence.",
  );
  assert.ok(after.endsWith("## Notes\nDo not touch.\n"));
});

test("previews without writing, then applies once and restores the exact original", async (t) => {
  const root = await fixture(t),
    draft = await preparePromotion(root, request);
  assert.equal(await readFile(join(root, "Paper.md"), "utf8"), original);
  const applied = await applyPromotion(root, draft);
  assert.equal(await readFile(join(root, "Paper.md"), "utf8"), draft.after);
  await assert.rejects(applyPromotion(root, applied), /Only an unapplied/);
  const undone = await undoPromotion(root, applied);
  assert.equal(undone.status, "undone");
  assert.equal(await readFile(join(root, "Paper.md"), "utf8"), original);
});

test("refuses a stale preview and preserves edits made outside the application", async (t) => {
  const root = await fixture(t),
    draft = await preparePromotion(root, request),
    newer = original + "\nNew Obsidian edit.\n";
  await writeFile(join(root, "Paper.md"), newer);
  await assert.rejects(applyPromotion(root, draft), /changed since/);
  assert.equal(await readFile(join(root, "Paper.md"), "utf8"), newer);
});

test("undo never overwrites later user work", async (t) => {
  const root = await fixture(t),
    applied = await applyPromotion(root, await preparePromotion(root, request));
  const newer = applied.after + "\nAnother proof step.\n";
  await writeFile(join(root, "Paper.md"), newer);
  await assert.rejects(undoPromotion(root, applied), /newer edits/);
  assert.equal(await readFile(join(root, "Paper.md"), "utf8"), newer);
});

test("drafts cannot be applied to another vault even with identical content", async (t) => {
  const root = await fixture(t),
    other = await fixture(t),
    draft = await preparePromotion(root, request);
  await assert.rejects(applyPromotion(other, draft), /different vault/);
});

test("new-note creation uses exclusive writes and supports undo", async (t) => {
  const root = await fixture(t),
    draft = await preparePromotion(root, {
      ...request,
      path: "Insight.md",
      mode: "new",
      title: "Insight",
      noteType: "theorem",
      links: ["Paper.md"],
    });
  const applied = await applyPromotion(root, draft);
  assert.match(
    await readFile(join(root, "Insight.md"), "utf8"),
    /\[\[Paper\]\]/,
  );
  await undoPromotion(root, applied);
  await assert.rejects(readFile(join(root, "Insight.md")), /ENOENT/);
  await writeFile(join(root, "Insight.md"), "A newer note");
  await assert.rejects(applyPromotion(root, draft), /changed since/);
});
