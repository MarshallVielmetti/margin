import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNote,
  scanVault,
  resolveLinks,
  searchNotes,
  safeNotePath,
} from "../server/vault.mjs";

test("indexes note sections, metadata, aliases, callouts, and explicit links with evidence", () => {
  const note = parseNote(
    "notes/Contraction.md",
    `---\ntitle: Contraction mappings\naliases: [Contraction, Strict contraction]\ntags: [definition]\n---\n# Contraction\n## Statement\nA map on a [[Metric Space|metric space]].\n> [!assumption] Strict coefficient\n> k < 1\n## Examples\n![[Banach#Proof]]\n\`\`\`dataviewjs\nconst x = "[[not a concept]]";\n## Not a heading\n\`\`\`\n`,
  );
  assert.equal(note.type, "definition");
  assert.equal(note.title, "Contraction mappings");
  assert.deepEqual(note.aliases, ["Contraction", "Strict contraction"]);
  assert.deepEqual(
    note.links.map((l) => [l.target, l.section, l.embedded]),
    [
      ["Metric Space", "Statement", false],
      ["Banach", "Examples", true],
    ],
  );
  assert.equal(note.callouts[0].type, "assumption");
  assert.ok(note.links[0].line > 5);
  assert.equal(note.headings.length, 3);
  assert.equal(
    note.sections.find((s) => s.title === "Statement").text.includes("k < 1"),
    true,
  );
});

test("supports legacy inline metadata and summary sections without rewriting content", () => {
  const content =
    "2026-01-01\nStatus: #MOC\n# Research\n## Summary\nAn open question.\n## Proof\nUnfinished.\n";
  const note = parseNote("Research.md", content);
  assert.equal(note.type, "MOC");
  assert.equal(note.summary, "An open question.");
  assert.equal(note.content, content);
});

test("keeps conflicting aliases separate instead of asserting concept equivalence", () => {
  const notes = [
    parseNote("a/A.md", "---\naliases: [Shared]\n---\n# A"),
    parseNote("b/B.md", "---\naliases: [Shared]\n---\n# B"),
  ];
  assert.equal(resolveLinks(notes, "Shared").length, 2);
  assert.equal(resolveLinks(notes, "a/A#Statement|alias").length, 1);
});

test("searches aliases and returns passage evidence with an unverified relationship label", () => {
  const notes = [
    parseNote(
      "Banach.md",
      "---\naliases: [Contraction principle]\n---\n# Banach\n## Proof\nA Cauchy sequence in a complete space.\n",
    ),
  ];
  const match = searchNotes(notes, "contraction principle")[0];
  assert.equal(match.path, "Banach.md");
  assert.match(match.reason, /unverified/);
  assert.match(searchNotes(notes, "Cauchy")[0].excerpt, /complete space/);
  assert.equal(searchNotes(notes, "obscurewidget").length, 0);
});

test("vault scanning excludes symlinks, runtime folders, and code templates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "notes"));
  await mkdir(join(root, ".obsidian"));
  await mkdir(join(root, "templates"));
  await writeFile(join(root, "notes", "A.md"), "# A");
  await writeFile(join(root, ".obsidian", "secret.md"), "# Ignore");
  await writeFile(join(root, "templates", "template.md"), "# Ignore");
  await symlink(join(root, "notes"), join(root, "linked-notes"));
  const index = await scanVault(root);
  assert.deepEqual(
    index.notes.map((n) => n.path),
    ["notes/A.md"],
  );
});

test("rejects traversal, hidden paths, and symlink escapes for existing and new notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "margin-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "private");
  await symlink(outside, join(root, "escape"));
  for (const path of [
    "../secret.md",
    ".obsidian/config.md",
    "escape/secret.md",
    "escape/new.md",
    "/tmp/secret.md",
  ])
    await assert.rejects(safeNotePath(root, path, { allowNew: true }));
  assert.equal(
    (await safeNotePath(root, "New idea.md", { allowNew: true })).endsWith(
      "/New idea.md",
    ),
    true,
  );
});
