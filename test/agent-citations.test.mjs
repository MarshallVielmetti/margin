import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Store } from "../server/store.mjs";
import {
  evidenceFreshness,
  getEvidence,
  listEvidence,
  registerEvidence,
} from "../server/agent/evidence.mjs";
import { validateAnswer } from "../server/agent/validation.mjs";
import {
  citationLabel,
  exportReadableMarkdown,
  resolveEvidenceHandle,
  remarkCitations,
  resolveCitationTarget,
} from "../src/citations.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/agent/citations.json", import.meta.url),
    "utf8",
  ),
);

test("evidence snapshots persist and legacy handles stay scoped to their run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "margin-citations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "store.sqlite");
  let store = new Store(filename);
  const source = registerEvidence(store, "run-a", {
    id: "N2",
    title: "Algebraic Connectivity (Spectral Gap)",
    text: "Exact saved passage.",
    kind: "note",
    path: "notes/Algebraic Connectivity (Spectral Gap).md",
    section: "Connectivity",
    line: 18,
    revision: "v1",
    currentRevision: "v1",
  });
  assert.match(source.id, /^ev_/);
  assert.deepEqual(source.handles, ["N2"]);
  assert.equal(source.freshness, "current");
  assert.equal(getEvidence(store, "run-b", source.id), undefined);
  registerEvidence(store, "run-b", {
    id: source.id,
    title: source.title,
    text: source.text,
    kind: source.kind,
    path: source.path,
    section: source.section,
    line: source.line,
    revision: source.revision,
    handles: ["S2"],
    currentRevision: "v2",
  });
  assert.deepEqual(getEvidence(store, "run-a", source.id).handles, ["N2"]);
  assert.deepEqual(getEvidence(store, "run-b", source.id).handles, ["S2"]);
  assert.equal(getEvidence(store, "run-a", source.id).freshness, "current");
  assert.equal(getEvidence(store, "run-b", source.id).freshness, "stale");
  store.close();

  store = new Store(filename);
  assert.equal(
    getEvidence(store, "run-a", source.id).text,
    "Exact saved passage.",
  );
  assert.deepEqual(getEvidence(store, "run-a", source.id).handles, ["N2"]);
  assert.deepEqual(getEvidence(store, "run-b", source.id).handles, ["S2"]);
  assert.equal(getEvidence(store, "run-a", source.id).freshness, "current");
  assert.equal(getEvidence(store, "run-b", source.id).freshness, "stale");
  assert.equal(listEvidence(store, "run-a")[0].title, source.title);
  assert.deepEqual(listEvidence(store, "run-b")[0].handles, ["S2"]);
  store.close();
});

test("freshness never invents a revision for legacy snapshots", () => {
  assert.equal(evidenceFreshness({ text: "old" }), "unknown");
  assert.equal(evidenceFreshness({ revision: "v1" }), "unchecked");
  assert.equal(evidenceFreshness({ revision: "v1" }, "v1"), "current");
  assert.equal(evidenceFreshness({ revision: "v1" }, "v2"), "stale");
  const store = new Store(":memory:");
  assert.equal(
    registerEvidence(store, "run", {
      title: "Fresh source",
      text: "passage",
      kind: "note",
      revision: "v1",
      freshness: "current",
    }).freshness,
    "current",
  );
  store.close();
});

test("citation validation is artifact-scoped and leaves paper reference numbers alone", () => {
  const result = validateAnswer({
    text: "Claim [N2] and {{cite:ev_source_a}}; bibliography label [11].",
    evidence: fixture.evidence,
    requiredLabels: ["11"],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.citations.map((item) => item.status),
    ["resolved", "resolved"],
  );

  const unknown = validateAnswer({
    text: "A claim [N9].",
    evidence: fixture.evidence,
  });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.issues[0].code, "unresolved-citation");

  const missingObligation = validateAnswer({
    text: "No bibliography labels included.",
    evidence: fixture.evidence,
    requiredLabels: ["11", "12", "26"],
  });
  assert.deepEqual(
    missingObligation.issues.map((issue) => issue.label),
    ["11", "12", "26"],
  );

  const literalResult = validateAnswer({
    text: "Code `[N9]`; math $[S8]$; linked [N7](https://example.test); source [N2].",
    evidence: fixture.evidence,
    requiredLabels: ["11"],
  });
  assert.equal(
    literalResult.issues.some((issue) => issue.label === "11"),
    true,
  );
  assert.deepEqual(
    literalResult.citations.map((item) => item.handle),
    ["N2"],
  );
});

test("validator ignores citation-looking code and math", () => {
  const result = validateAnswer({
    text: "Literal `[N9]` and $[S8]$ plus:\n```md\n[N7]\n```\n\\([N6]\\)\nSupported [N2].",
    evidence: fixture.evidence,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.citations.map((item) => item.handle),
    ["N2"],
  );
});

test("validator matches explicitly annotated and nearby quoted passages", () => {
  const explicit = validateAnswer({
    text: "The source says “Exact saved passage.” {{cite:ev_note_a}}.",
    evidence: [
      {
        id: "ev_note_a",
        title: "A note",
        text: "Exact   saved passage. Additional context follows.",
        kind: "note",
      },
    ],
    quotes: [{ evidenceId: "ev_note_a", text: "Exact saved passage." }],
  });
  assert.equal(explicit.valid, true);
  assert.equal(explicit.quotes[0].status, "matched");

  const nearby = validateAnswer({
    text: "The paper states “The selected page describes the connectivity-based contract.” [S1]",
    evidence: fixture.evidence,
  });
  assert.equal(nearby.valid, true);
  assert.equal(nearby.quotes[0].status, "matched");

  const fabricated = validateAnswer({
    text: "The note says “A fabricated passage.” [N2]",
    evidence: [
      {
        id: "ev_note_a",
        handles: ["N2"],
        title: "A note",
        text: "Actual source passage.",
        kind: "note",
      },
    ],
  });
  assert.equal(fabricated.valid, false);
  assert.equal(fabricated.issues[0].code, "quotation-mismatch");
});

test("remark citation parsing only rewrites ordinary AST text nodes", async () => {
  const text =
    "Use [N2] and [S1, N2], while [11] remains a paper reference. ` [N9] ` and $[S8]$ stay literal. \\[N8\\]\n\n```md\n[N7] {{cite:ev_missing}}\n```\n\n\\([N6]\\)";
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkCitations, { evidence: fixture.evidence });
  const tree = await processor.run(processor.parse(text), { value: text });
  const found = [];
  const walk = (node) => {
    if (node.type === "citation") found.push(node.data.hProperties.handle);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  assert.deepEqual(found, ["N2", "S1", "N2"]);
  assert.equal(JSON.stringify(tree).includes("[11]"), true);
  assert.equal(JSON.stringify(tree).includes("[N7]"), true);
  assert.equal(JSON.stringify(tree).includes("[N8]"), true);
});

test("duplicate evidence handles remain unresolved instead of selecting a plausible source", () => {
  const evidence = [
    { id: "ev_one", handles: ["N2"], title: "First", text: "one" },
    { id: "ev_two", handles: ["N2"], title: "Second", text: "two" },
  ];
  assert.equal(resolveEvidenceHandle(evidence, "N2"), undefined);
  const result = validateAnswer({ text: "[N2]", evidence });
  assert.equal(result.issues[0].code, "ambiguous-citation");
});

test("legacy N2 citations keep their saved direct note target", () => {
  const legacyNote = { ...fixture.evidence[0], id: "N2" };
  const target = new URL(
    resolveCitationTarget(legacyNote, {
      vaultRoot: "/vaults/Research Vault",
      vaultId: "Research Vault",
      bridge: true,
    }),
  );
  assert.equal(target.hostname, "margin");
  assert.equal(target.searchParams.get("file"), legacyNote.path);
  assert.equal(target.searchParams.get("heading"), "Connectivity");
  assert.equal(target.searchParams.get("line"), "18");
});

test("navigation uses configured vault identity and falls back safely", () => {
  const note = fixture.evidence[0];
  const bridge = new URL(
    resolveCitationTarget(note, {
      vaultRoot: "/vaults/Folder Name",
      vaultId: "Configured Vault",
      bridge: true,
    }),
  );
  assert.equal(bridge.protocol, "obsidian:");
  assert.equal(bridge.hostname, "margin");
  assert.equal(bridge.searchParams.get("vault"), "Configured Vault");
  assert.equal(bridge.searchParams.get("file"), note.path);
  assert.equal(bridge.searchParams.get("heading"), "Connectivity");
  assert.equal(bridge.searchParams.get("line"), "18");

  const standard = new URL(
    resolveCitationTarget(note, { vaultRoot: "/vaults/Folder Name" }),
  );
  assert.equal(standard.hostname, "open");
  assert.equal(standard.searchParams.get("vault"), "Folder Name");
  assert.equal(standard.searchParams.get("file"), `${note.path}#Connectivity`);
  const duplicateHeading = new URL(
    resolveCitationTarget(
      { ...note, locator: { headingOccurrence: 2 } },
      { vaultRoot: "/vault", bridge: true },
    ),
  );
  assert.equal(duplicateHeading.searchParams.get("heading"), null);
  assert.equal(duplicateHeading.searchParams.get("line"), "18");
  const structuredLocator = {
    ...note,
    line: undefined,
    locator: {
      headingPath: ["Definitions", "Connectivity"],
      section: "Connectivity",
      blockId: "gap-condition",
      lineStart: 24,
    },
  };
  assert.equal(
    citationLabel(structuredLocator),
    "Algebraic Connectivity (Spectral Gap) · Connectivity",
  );
  const structuredBridge = new URL(
    resolveCitationTarget(structuredLocator, {
      vaultRoot: "/vaults/Root Name",
      vaultId: "/vaults/Configured Name",
      bridge: true,
    }),
  );
  assert.equal(structuredBridge.searchParams.get("vault"), "Configured Name");
  assert.equal(
    structuredBridge.searchParams.get("headingPath"),
    JSON.stringify(["Definitions", "Connectivity"]),
  );
  assert.equal(structuredBridge.searchParams.get("blockId"), "gap-condition");
  assert.equal(structuredBridge.searchParams.get("line"), "24");
  const structuredStandard = new URL(
    resolveCitationTarget(structuredLocator, {
      vaultRoot: "/vaults/Root Name",
    }),
  );
  assert.equal(
    structuredStandard.searchParams.get("file"),
    `${note.path}#^gap-condition`,
  );
  assert.equal(
    resolveCitationTarget(
      { ...note, path: "../outside.md" },
      { vaultRoot: "/vault" },
    ),
    undefined,
  );
});

test("copy/export uses names and locators, preserving code, math, and [11]", () => {
  const output = exportReadableMarkdown(
    "See [N2], [S1], [11], `literal [N2]`, and $[N2]$.",
    fixture.evidence,
    { vaultRoot: "/vaults/Folder Name", vaultId: "Configured Vault" },
  );
  assert.match(
    output,
    /Algebraic Connectivity \\\(Spectral Gap\\\) · Connectivity/,
  );
  assert.match(output, /obsidian:\/\/open\?/);
  assert.match(output, /source\\_fixture/);
  assert.match(output, /page 2/);
  assert.match(output, /\[11\]/);
  assert.match(output, /`literal \[N2\]`/);
  assert.match(output, /\$\[N2\]\$/);
});
