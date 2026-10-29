import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { createHistoryTools } from "../server/agent/tools/history.mjs";
import { createResearchStateService } from "../server/research-state.mjs";
import { scanVault } from "../server/vault.mjs";

function historyFixture(store) {
  store.put("workspace", { id: "workspace-1", title: "Current" });
  store.put("workspace", { id: "workspace-2", title: "Other" });
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.put("session", { id: "session-2", workspaceId: "workspace-1" });
  store.put("session", { id: "session-other", workspaceId: "workspace-2" });
  store.createAgentRun({
    id: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    status: "generating",
  });
  store.put("artifact", {
    id: "artifact-current",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    text: "I suspect the spectral gap controls convergence.",
    kind: "claim",
    origin: "user",
    status: "unverified",
    anchor: { page: 2, section: "Theorem" },
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  store.put("artifact", {
    id: "artifact-same-workspace",
    sessionId: "session-2",
    workspaceId: "workspace-1",
    text: "An earlier inquiry about convergence.",
    kind: "question",
    origin: "user",
    status: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  store.put("artifact", {
    id: "artifact-other-workspace",
    sessionId: "session-other",
    workspaceId: "workspace-2",
    text: "A private other-workspace convergence claim.",
    kind: "claim",
    origin: "user",
  });
}

test("history search is workspace-scoped discovery and history read registers attributed evidence", async () => {
  const store = new Store(":memory:");
  historyFixture(store);
  const registered = [];
  const tools = createHistoryTools({
    store,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    getVault: () => ({ root: "", notes: [] }),
    registerEvidence: async (input, toolCallId) => {
      const evidence = store.put("evidenceSnapshot", {
        ...input,
        runId: "run-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        toolCallId,
      });
      store.put("runEvidence", {
        id: `run-1:${evidence.id}`,
        runId: "run-1",
        evidenceId: evidence.id,
      });
      registered.push(evidence);
      return evidence;
    },
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));
  const found = await byName["history.search"].execute(
    { query: "convergence" },
    { runId: "run-1", toolCallId: "history-search" },
  );
  assert.equal(found.inspectedEvidence, false);
  assert.equal(registered.length, 0);
  assert.deepEqual(
    found.candidates.map((candidate) => candidate.sessionId).sort(),
    ["session-1", "session-2"],
  );
  assert.ok(
    found.candidates.every((candidate) => candidate.recordKind === "artifact"),
  );
  await assert.rejects(
    byName["history.read"].execute(
      { candidateId: found.candidates[0].candidateId },
      { runId: "run-other" },
    ),
    /another run/,
  );
  const read = await byName["history.read"].execute(
    { candidateId: found.candidates[0].candidateId },
    { runId: "run-1", toolCallId: "history-read" },
  );
  assert.equal(read.freshness, "historical-snapshot");
  assert.equal(read.evidence[0].provenance.originalSessionId, read.sessionId);
  assert.equal(registered.length, 1);
  store.close();
});

test("research state keeps explicit attribution and status; it never infers mastery", async () => {
  const store = new Store(":memory:");
  store.put("workspace", { id: "workspace-1", title: "Current" });
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.put("session", { id: "session-other", workspaceId: "workspace-2" });
  const state = createResearchStateService(store, {
    sessionId: "session-1",
    workspaceId: "workspace-1",
  });
  state.recordInquiry({
    question: "When does the spectral gap imply convergence?",
    status: "open",
    attribution: { origin: "user" },
    assumptions: ["The graph is connected."],
    evidenceIds: ["ev_source"],
  });
  const accepted = state.recordClaim({
    claim: "The graph has a positive spectral gap.",
    status: "accepted",
    attribution: { origin: "user", evidenceIds: ["ev_source"] },
    assumptions: ["Undirected graph."],
    evidenceIds: ["ev_source"],
  });
  state.recordClaim({
    claim: "The gap controls the rate.",
    status: "proposed",
    attribution: { origin: "ai", evidenceIds: ["ev_source"] },
    assumptions: ["A specific update rule."],
    evidenceIds: ["ev_source"],
  });
  state.recordConceptOccurrence({
    conceptId: "spectral-gap",
    notePath: "Spectral Gap.md",
    relation: "same_concept_candidate",
    status: "proposed",
    attribution: { origin: "ai", evidenceIds: ["ev_source"] },
    evidenceIds: ["ev_source"],
  });
  state.recordLearningEvidence({
    conceptId: "spectral-gap",
    evidenceType: "user-response",
    description: "The researcher explained the assumption in their own words.",
    responseText: "Connectivity is needed so the zero eigenvalue is simple.",
    status: "observed",
    attribution: { origin: "user" },
    evidenceIds: ["ev_source"],
  });
  assert.throws(
    () =>
      state.recordClaim({
        claim: "AI accepted claim",
        status: "accepted",
        attribution: { origin: "ai" },
      }),
    /Only an explicit user attribution/,
  );
  assert.throws(
    () =>
      state.recordLearningEvidence({
        evidenceType: "ai-provisional-assessment",
        description: "User mastered this concept.",
        status: "observed",
        attribution: { origin: "ai" },
      }),
    /must remain provisional/,
  );
  assert.throws(() =>
    state.recordLearningEvidence({
      evidenceType: "self-report",
      description: "Mastery claimed",
      attribution: { origin: "user" },
      mastery: true,
    }),
  );
  store.put("researchClaim", {
    id: "wrong-workspace-claim",
    workspaceId: "workspace-2",
    sessionId: "session-other",
    claim: "Must not leak",
    status: "accepted",
    attribution: { origin: "user" },
  });
  const result = state.getState();
  assert.equal(result.claims[0].id, accepted.id);
  assert.equal(
    result.claims.some((claim) => claim.id === "wrong-workspace-claim"),
    false,
  );
  assert.equal(result.learningEvidence[0].status, "observed");
  assert.match(result.note, /not evidence of mastery/);
  store.close();
});

test("session summaries are attributed retrieval aids linked to immutable same-workspace originals", async () => {
  const store = new Store(":memory:");
  store.put("workspace", { id: "workspace-1", title: "Current" });
  store.put("workspace", { id: "workspace-2", title: "Other" });
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.put("session", { id: "session-other", workspaceId: "workspace-2" });
  const original = store.put("artifact", {
    id: "user-original",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    text: "I think the graph must be connected for the zero eigenvalue to be simple.",
    kind: "thought",
    origin: "user",
    status: "unverified",
  });
  store.put("artifact", {
    id: "other-original",
    sessionId: "session-other",
    workspaceId: "workspace-2",
    text: "Private note from another workspace.",
    kind: "thought",
    origin: "user",
  });
  const originalBefore = structuredClone(store.get("artifact", original.id));
  const state = createResearchStateService(store, {
    sessionId: "session-1",
    workspaceId: "workspace-1",
  });
  assert.throws(
    () =>
      state.recordSessionSummary({
        text: "This summary has no source.",
        originalArtifactIds: ["missing-original"],
        attribution: { origin: "ai" },
      }),
    /does not exist/,
  );
  assert.throws(
    () =>
      state.recordSessionSummary({
        text: "This summary points outside its workspace.",
        originalArtifactIds: ["other-original"],
        attribution: { origin: "system" },
      }),
    /outside this workspace/,
  );
  assert.throws(() =>
    state.recordSessionSummary({
      text: "This is not a user-authored summary.",
      originalArtifactIds: [original.id],
      attribution: { origin: "user" },
    }),
  );

  const summary = state.recordSessionSummary({
    text: "The researcher connected graph connectivity to the multiplicity of the zero eigenvalue.",
    originalArtifactIds: [original.id],
    attribution: { origin: "ai", recordId: "run-previous" },
  });
  const systemSummary = state.recordSessionSummary({
    text: "A system-generated retrieval summary.",
    originalArtifactIds: [original.id],
    attribution: { origin: "system" },
  });
  assert.equal(summary.origin, "ai");
  assert.equal(systemSummary.origin, "system");
  assert.equal(summary.kind, "session-summary");
  assert.equal(summary.status, "retrieval-aid");
  assert.deepEqual(summary.originalArtifactIds, [original.id]);
  assert.deepEqual(store.get("artifact", original.id), originalBefore);
  const stateView = state.getState();
  assert.ok(
    stateView.sessionSummaries.some((entry) => entry.id === summary.id),
  );
  assert.ok(
    stateView.sessionSummaries.some((entry) => entry.id === systemSummary.id),
  );

  const tools = createHistoryTools({
    store,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    getVault: () => ({ root: "", notes: [] }),
    registerEvidence: async (input, toolCallId) =>
      store.put("evidenceSnapshot", {
        ...input,
        id: "ev_session_summary",
        runId: "run-summary",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        toolCallId,
      }),
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));
  const stateResult = await byName["research.get_state"].execute(
    {},
    { runId: "run-summary", toolCallId: "state-read" },
  );
  const stateSummary = stateResult.sessionSummaries.find(
    (entry) => entry.id === summary.id,
  );
  assert.equal(stateSummary.text, summary.text);
  assert.deepEqual(stateSummary.originalArtifactIds, [original.id]);
  const found = await byName["history.search"].execute(
    { query: "connectivity", recordKinds: ["sessionSummary"] },
    { runId: "run-summary", toolCallId: "summary-search" },
  );
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].origin, "ai");
  assert.deepEqual(found.candidates[0].originalArtifactIds, [original.id]);
  const read = await byName["history.read"].execute(
    { candidateId: found.candidates[0].candidateId },
    { runId: "run-summary", toolCallId: "summary-read" },
  );
  assert.equal(read.recordKind, "sessionSummary");
  assert.equal(read.attribution.origin, "ai");
  assert.deepEqual(read.originalArtifactIds, [original.id]);
  assert.equal(read.evidence[0].provenance.origin, "ai");
  assert.deepEqual(read.evidence[0].provenance.originalArtifactIds, [
    original.id,
  ]);
  assert.deepEqual(store.get("artifact", original.id), originalBefore);
  store.close();
});

test("proposal.create stores a reviewable promotion preview with exact version and provenance, without writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-proposal-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const notePath = join(root, "Graph.md");
  const original =
    "# Graph\n## Summary\nExisting summary.\n## Proof\nDo not remove this.\n";
  await writeFile(notePath, original);
  const vault = await scanVault(root);
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.createAgentRun({
    id: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    status: "generating",
  });
  const evidence = store.put("evidenceSnapshot", {
    id: "ev_current",
    title: "Graph paper",
    kind: "source-passage",
    text: "The graph is connected.",
    revision: "paper-rev-1",
    locator: { page: 2 },
    provenance: { origin: "source", status: "unverified" },
  });
  store.put("runEvidence", {
    id: "run-1:ev_current",
    runId: "run-1",
    evidenceId: evidence.id,
  });
  const tools = createHistoryTools({
    store,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    getVault: () => vault,
    registerEvidence: async () => {
      throw new Error("This proposal should use existing evidence.");
    },
  });
  const propose = tools.find((entry) => entry.name === "proposal.create");
  const preview = await propose.execute(
    {
      path: "Graph.md",
      mode: "summary",
      heading: "Summary",
      text: "The source says the graph is connected.",
      evidenceIds: ["ev_current"],
    },
    { runId: "run-1", toolCallId: "proposal-call" },
  );
  assert.equal(preview.status, "draft");
  assert.equal(preview.applied, false);
  assert.equal(preview.target.expectedHash, vault.notes[0].hash);
  assert.deepEqual(preview.evidenceIds, ["ev_current"]);
  assert.match(preview.preview.after, /AI-generated proposal; not accepted/);
  assert.equal(await readFile(notePath, "utf8"), original);
  const saved = store.get("promotion", preview.proposalId);
  assert.equal(saved.origin, "ai");
  assert.equal(saved.proposalType, "memory-promotion");
  assert.equal(saved.status, "draft");
  assert.equal(saved.proposedProvenance.evidence[0].evidenceId, "ev_current");
});

test("proposal rejects cross-run, cross-session evidence and mismatched preview identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-proposal-scope-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "Graph.md"), "# Graph\n## Summary\nExisting.\n");
  const vault = await scanVault(root);
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.createAgentRun({
    id: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    status: "generating",
  });
  store.createAgentRun({
    id: "run-other",
    sessionId: "session-other",
    workspaceId: "workspace-2",
    status: "generating",
  });
  for (const id of ["ev-other-run", "ev-other-workspace"]) {
    store.put("evidenceSnapshot", {
      id,
      title: "Other evidence",
      kind: "source-passage",
      text: "Text",
    });
  }
  store.put("runEvidence", {
    id: "run-other:ev-other-run",
    runId: "run-other",
    evidenceId: "ev-other-run",
  });
  store.put("runEvidence", {
    id: "run-other:ev-other-workspace",
    runId: "run-other",
    evidenceId: "ev-other-workspace",
  });
  const tools = createHistoryTools({
    store,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    getVault: () => vault,
    registerEvidence: async () => undefined,
    preparePromotion: async () => ({
      path: "SomewhereElse.md",
      mode: "summary",
      status: "draft",
      beforeHash: vault.notes[0].hash,
      afterHash: "new-hash",
      after: "Nope",
    }),
  });
  const propose = tools.find((entry) => entry.name === "proposal.create");
  const args = {
    path: "Graph.md",
    mode: "summary",
    text: "A suggestion",
    evidenceIds: ["ev-other-run"],
  };
  await assert.rejects(
    propose.execute(args, { runId: "run-1" }),
    /not attached to this run/,
  );
  await assert.rejects(
    propose.execute(
      { ...args, evidenceIds: ["ev-other-workspace"] },
      { runId: "run-1" },
    ),
    /not attached to this run/,
  );
  store.put("runEvidence", {
    id: "run-1:ev-current",
    runId: "run-1",
    evidenceId: "ev-current",
  });
  store.put("evidenceSnapshot", {
    id: "ev-current",
    title: "Current",
    kind: "note",
    text: "Text",
  });
  await assert.rejects(
    propose.execute(
      { ...args, evidenceIds: ["ev-current"] },
      { runId: "run-1" },
    ),
    /mismatched draft/,
  );
  assert.equal(store.list("promotion").length, 0);
});
