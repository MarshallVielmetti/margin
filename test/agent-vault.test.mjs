import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { createVaultTools } from "../server/agent/tools/vault.mjs";
import { createAgentRuntime } from "../server/agent/runtime.mjs";
import { registerEvidence } from "../server/agent/evidence.mjs";
import { passagesFor, searchPassages } from "../server/retrieval.mjs";
import {
  parseNote,
  resolveLinkMatches,
  resolveLinks,
  scanVault,
} from "../server/vault.mjs";

test("note parsing keeps hierarchical headings and original heading/block wikilinks", () => {
  const source = parseNote(
    "notes/Main.md",
    `# Main\n## Proof\n### Assumptions\nUse [[../shared/Other#^result|the result]].\n^proof-end\n`,
  );
  assert.deepEqual(
    source.headings.map((heading) => heading.headingPath),
    [["Main"], ["Main", "Proof"], ["Main", "Proof", "Assumptions"]],
  );
  assert.equal(source.links[0].target, "../shared/Other");
  assert.equal(
    source.links[0].originalTarget,
    "../shared/Other#^result|the result",
  );
  assert.equal(source.links[0].fragment, "^result");
  assert.equal(source.links[0].blockId, "result");
  assert.equal(source.links[0].display, "the result");
  assert.equal(source.blockIds[0].id, "proof-end");
});

test("relative links resolve before duplicate basenames while shared aliases stay ambiguous", () => {
  const notes = [
    parseNote("notes/Main.md", "# Main"),
    parseNote("shared/Other.md", "---\naliases: [Shared idea]\n---\n# Other"),
    parseNote(
      "notes/shared/Other.md",
      "---\naliases: [Shared idea]\n---\n# Nearby",
    ),
  ];
  const relative = resolveLinkMatches(
    notes,
    "../shared/Other#^result|the result",
    "notes/Main.md",
  );
  assert.deepEqual(
    relative.map((match) => match.note.path),
    ["shared/Other.md"],
  );
  assert.equal(relative[0].matchType, "source-relative-path");
  assert.deepEqual(
    resolveLinks(notes, "Shared idea")
      .map((note) => note.path)
      .sort(),
    ["notes/shared/Other.md", "shared/Other.md"],
  );
  assert.deepEqual(
    resolveLinks(notes, "Other")
      .map((note) => note.path)
      .sort(),
    ["notes/shared/Other.md", "shared/Other.md"],
  );
});

test("local heading and block wikilinks resolve to their source note and retain the fragment", () => {
  const source = parseNote(
    "notes/Local.md",
    "# Theorem\nThe result follows from the argument. ^claim\n[[#Theorem]]\n[[#^claim]]\n",
  );
  const heading = resolveLinkMatches([source], source.links[0], source.path);
  const block = resolveLinkMatches([source], source.links[1], source.path);
  assert.equal(heading.length, 1);
  assert.equal(heading[0].note.path, source.path);
  assert.equal(heading[0].matchType, "local-fragment");
  assert.equal(heading[0].fragment, "Theorem");
  assert.equal(heading[0].originalTarget, "#Theorem");
  assert.equal(block.length, 1);
  assert.equal(block[0].note.path, source.path);
  assert.equal(block[0].fragment, "^claim");
  assert.equal(block[0].blockId, "claim");
  assert.equal(resolveLinkMatches([source], "#Theorem").length, 0);
});

test("retrieval returns multiple distinct passages from one note with heading paths", () => {
  const note = parseNote(
    "Graph.md",
    `# Graph connectivity\n## Statement\nConnectivity follows from a positive spectral gap in this finite graph.\n## Assumptions\nConnectivity requires a connected undirected graph and a positive spectral gap.\n## Proof\nThe graph Laplacian has a zero eigenvalue and the next eigenvalue is positive.\n`,
  );
  const matches = searchPassages([note], "connectivity", { limit: 10 });
  assert.ok(matches.length >= 3);
  assert.equal(new Set(matches.map((match) => match.path)).size, 1);
  assert.ok(
    matches.some(
      (match) =>
        match.headingPath.join(" / ") === "Graph connectivity / Statement",
    ),
  );
  assert.ok(
    matches.some(
      (match) =>
        match.headingPath.join(" / ") === "Graph connectivity / Assumptions",
    ),
  );
  const passages = passagesFor(note, { maxChars: 90 });
  assert.ok(passages.length >= 3);
  assert.ok(passages.every((passage) => passage.excerpt.length <= 90));
  assert.ok(passages.every((passage) => passage.line <= passage.endLine));
});

test("short assumption passages remain discoverable beside theorem and proof text", () => {
  const note = parseNote(
    "Consensus.md",
    `# Consensus\n## Theorem\nA positive spectral gap yields exponential convergence for this update process.\n## Proof\nThe spectral gap bounds the contraction rate in the energy estimate.\n## Assumptions\nThe graph is undirected.\n`,
  );
  const matches = searchPassages([note], "spectral undirected", { limit: 10 });
  assert.ok(matches.some((match) => match.section === "Theorem"));
  assert.ok(matches.some((match) => match.section === "Proof"));
  const assumption = matches.find((match) => match.section === "Assumptions");
  assert.ok(assumption);
  assert.equal(assumption.excerpt, "The graph is undirected.");
  assert.ok(assumption.excerpt.length < 30);
});

test("vault search is discovery only; read registers bounded fresh evidence and rejects stale or cross-run IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-vault-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "Graph.md");
  await writeFile(
    path,
    `# Graph\n## Assumptions\nConnectivity requires a bounded delay and a connected undirected graph.\n`,
  );
  let vault = await scanVault(root);
  const registered = [];
  const tools = createVaultTools({
    store,
    getVault: () => vault,
    registerEvidence: async (input, toolCallId) => {
      const evidence = store.put("evidenceSnapshot", {
        ...input,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        toolCallId,
      });
      registered.push(evidence);
      return evidence;
    },
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));
  const candidates = await byName["vault.search"].execute(
    { query: "bounded delay" },
    { runId: "run-1", toolCallId: "search-1" },
  );
  assert.equal(registered.length, 0);
  assert.equal(candidates.inspectedEvidence, false);
  assert.equal(candidates.candidates[0].inspected, false);
  await assert.rejects(
    byName["vault.read"].execute(
      { candidateId: candidates.candidates[0].candidateId },
      { runId: "run-2", toolCallId: "read-other-run" },
    ),
    /another run/,
  );
  const result = await byName["vault.read"].execute(
    { candidateId: candidates.candidates[0].candidateId, maxChars: 35 },
    { runId: "run-1", toolCallId: "read-1" },
  );
  assert.equal(registered.length, 1);
  assert.equal(result.evidence[0].id, registered[0].id);
  assert.equal(result.evidence[0].revision, vault.notes[0].hash);
  assert.ok(result.text.length <= 35);
  assert.deepEqual(result.locator.headingPath, ["Graph", "Assumptions"]);

  const oldCandidate = candidates.candidates[0].candidateId;
  await writeFile(
    path,
    "# Graph\n## Assumptions\nThe note changed after search.\n",
  );
  await assert.rejects(
    byName["vault.read"].execute(
      { candidateId: oldCandidate },
      { runId: "run-1", toolCallId: "read-stale" },
    ),
    /changed after the current vault index/,
  );
  await unlink(path);
  await assert.rejects(
    byName["vault.read"].execute(
      { path: "Graph.md" },
      { runId: "run-1", toolCallId: "read-deleted" },
    ),
  );
});

test("vault outline and link tools preserve ambiguous targets and existing anchors", async () => {
  const notes = [
    parseNote("A.md", "# A\n## Same\n[[B#Same|target]]\n"),
    parseNote("one/B.md", "# B\n## Same\nFirst."),
    parseNote("two/B.md", "# B\n## Same\nSecond."),
  ];
  const tools = createVaultTools({
    store: {},
    getVault: () => ({ root: "/unused", notes }),
    registerEvidence: async (input) => input,
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));
  const resolved = await byName["vault.resolve_link"].execute({
    link: "B#Same",
    fromPath: "A.md",
  });
  assert.equal(resolved.ambiguous, true);
  const outline = await byName["vault.outline"].execute({ path: "A.md" });
  assert.deepEqual(outline.headings[1].headingPath, ["A", "Same"]);
  const edges = await byName["vault.links"].execute({
    path: "A.md",
    direction: "outbound",
  });
  assert.equal(edges.links[0].originalTarget, "B#Same|target");
  assert.equal(edges.links[0].fragment, "Same");
  assert.equal(edges.links[0].candidates.length, 2);
});

test("vault reads require a line when a block ID is duplicated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-block-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "Duplicate.md"),
    "# Duplicate\nFirst passage with enough detail for a bounded evidence read. ^same\n## Later\nSecond passage with different support and detail. ^same\n",
  );
  const vault = await scanVault(root);
  const tools = createVaultTools({
    getVault: () => vault,
    registerEvidence: async (input) => input,
  });
  const read = tools.find((entry) => entry.name === "vault.read");
  await assert.rejects(
    read.execute({ path: "Duplicate.md", blockId: "same" }, { runId: "run-1" }),
    /occurs more than once/,
  );
  const result = await read.execute(
    { path: "Duplicate.md", blockId: "same", line: 4 },
    { runId: "run-1", toolCallId: "block-read" },
  );
  assert.deepEqual(result.locator.headingPath, ["Duplicate", "Later"]);
  assert.equal(result.locator.lineStart, 4);
});

test("runtime loads vault.read evidence into citation validation context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-vault-runtime-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, "Graph.md"),
    "# Graph\n## Assumptions\nA bounded delay is needed for convergence in this connected graph.\n",
  );
  const vault = await scanVault(root);
  const tools = createVaultTools({
    store,
    getVault: () => vault,
    registerEvidence: async (input, toolCallId) =>
      registerEvidence(store, "run-runtime", { ...input, toolCallId }),
  });
  let call = 0;
  const provider = {
    capabilities: { tools: true },
    async generate({ messages }) {
      const toolMessages = messages.filter(
        (message) => message.role === "tool",
      );
      call++;
      if (toolMessages.length === 0)
        return {
          text: "",
          toolCalls: [
            {
              id: "search-call",
              name: "vault.search",
              arguments: { query: "bounded delay" },
            },
          ],
        };
      if (toolMessages.length === 1) {
        const searchResult = JSON.parse(toolMessages[0].content).result;
        return {
          text: "",
          toolCalls: [
            {
              id: "read-call",
              name: "vault.read",
              arguments: {
                candidateId: searchResult.candidates[0].candidateId,
              },
            },
          ],
        };
      }
      const readResult = JSON.parse(toolMessages[1].content).result;
      const evidenceId = readResult.evidence[0].id;
      return {
        text: `The note states this requirement. {{cite:${evidenceId}}}`,
        toolCalls: [],
      };
    },
  };
  const runtime = createAgentRuntime({
    providers: new Map([["ollama", provider]]),
  });
  const result = await runtime.run({
    runId: "run-runtime",
    question: "What does the note say about bounded delay?",
    tools,
    selection: { provider: "ollama", model: "mock" },
  });
  assert.equal(call, 3);
  assert.match(result.text, /\{\{cite:ev_/);
  assert.equal(result.loadedEvidenceIds.length, 1);
  assert.equal(result.evidence[0].loadedInPrompt, true);
});
