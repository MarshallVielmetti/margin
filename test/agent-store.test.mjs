import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";

function tempDb(t) {
  const root = mkdtempSync(join(tmpdir(), "margin-agent-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "margin.db");
}

function runRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    sessionId: "session-1",
    idempotencyKey: "request-1",
    status: "queued",
    input: { text: "What are references 11 and 12?" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("fresh store tracks schema migrations and persists ordered run events", (t) => {
  const filename = tempDb(t);
  const store = new Store(filename);
  t.after(() => store.close());

  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(
    store.db
      .prepare("SELECT version FROM migration_ledger ORDER BY version")
      .all()
      .map((row) => row.version),
    [1, 2],
  );

  const created = store.createAgentRun(runRecord(), {
    type: "run.queued",
    status: "queued",
  });
  assert.equal(created.created, true);
  const duplicate = store.createAgentRun(runRecord({ id: "run-duplicate" }), {
    type: "run.queued",
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.id, "run-1");
  assert.equal(duplicate.run.input.text, "What are references 11 and 12?");
  assert.throws(
    () =>
      store.createAgentRun(
        runRecord({ id: "run-different", input: { text: "a retry" } }),
      ),
    (error) => error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );
  assert.equal(
    store.list("artifact").filter((item) => item.kind === "question").length,
    1,
  );

  const first = store.appendAgentEvent("run-1", {
    type: "tool.started",
    toolCallId: "call-1",
    tool: "source.references",
    name: "source.references",
    arguments: { labels: ["11", "12"] },
  });
  const update = store.updateAgentRun(
    { ...store.getAgentRun("run-1"), status: "generating" },
    { type: "run.state", status: "generating" },
  );
  const completedCall = store.appendAgentEvent("run-1", {
    type: "tool.completed",
    toolCallId: "call-1",
    name: "source.references",
    ok: false,
    error: "Source unavailable",
  });
  const events = store.getAgentEvents("run-1");
  assert.equal(first.seq, 2);
  assert.equal(update.event.seq, 3);
  assert.equal(completedCall.seq, 4);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.queued", "tool.started", "run.state", "tool.completed"],
  );
  const toolCall = store.list("toolCall")[0];
  assert.equal(toolCall.status, "failed");
  assert.equal(toolCall.toolCallId, "call-1");
  assert.deepEqual(toolCall.arguments, { labels: ["11", "12"] });
  assert.equal(toolCall.error, "Source unavailable");
});

test("v1 migration makes a consistent backup and preserves legacy snapshots", (t) => {
  const filename = tempDb(t);
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX records_kind ON records(kind);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  legacy
    .prepare("INSERT INTO records VALUES (?,?,?,?)")
    .run(
      "old-artifact",
      "artifact",
      JSON.stringify({ id: "old-artifact", text: "saved answer" }),
      "2026-01-01",
    );
  legacy
    .prepare("INSERT INTO settings VALUES (?,?)")
    .run("model", JSON.stringify("local-model"));
  legacy.exec("PRAGMA user_version=1");
  legacy.close();

  const store = new Store(filename);
  t.after(() => store.close());
  assert.equal(store.get("artifact", "old-artifact").text, "saved answer");
  assert.equal(store.setting("model"), "local-model");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.ok(store.migrationBackupPath);
  assert.equal(existsSync(store.migrationBackupPath), true);

  const backup = new DatabaseSync(store.migrationBackupPath);
  try {
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      backup
        .prepare("SELECT payload FROM records WHERE id=?")
        .get("old-artifact").payload,
      JSON.stringify({ id: "old-artifact", text: "saved answer" }),
    );
    assert.equal(
      backup
        .prepare("SELECT name FROM sqlite_master WHERE name='agent_runs'")
        .get(),
      undefined,
    );
  } finally {
    backup.close();
  }
});

test("store rejects a database from a newer schema without changing it", (t) => {
  const filename = tempDb(t);
  const future = new DatabaseSync(filename);
  future.exec("CREATE TABLE future_data (value TEXT); PRAGMA user_version=3;");
  future.close();

  assert.throws(
    () => new Store(filename),
    /newer than this application supports/,
  );
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name='migration_ledger'")
        .get(),
      undefined,
    );
  } finally {
    check.close();
  }
});

test("final run, artifact, and terminal event commit once as one operation", (t) => {
  const store = new Store(tempDb(t));
  t.after(() => store.close());
  store.createAgentRun(runRecord());
  const run = {
    ...store.getAgentRun("run-1"),
    status: "completed",
    artifactId: "artifact-1",
  };
  const artifact = {
    id: "artifact-1",
    runId: "run-1",
    text: "Recovered bibliography.",
  };
  const completed = store.finalizeAgentRun(run, artifact, {
    type: "run.completed",
    status: "completed",
  });
  assert.equal(completed.committed, true);
  assert.equal(store.get("artifact", "artifact-1").text, artifact.text);
  assert.equal(store.getAgentArtifact("run-1").text, artifact.text);

  const retry = store.finalizeAgentRun(
    { ...run, text: "late answer" },
    { ...artifact, text: "late answer" },
    { type: "run.completed", status: "completed" },
  );
  assert.equal(retry.committed, false);
  assert.equal(store.getAgentArtifact("run-1").text, artifact.text);
  assert.equal(
    store
      .getAgentEvents("run-1")
      .filter((event) => event.type === "run.completed").length,
    1,
  );
});

test("diagnostic purge keeps the final answer, evidence, question, and terminal event sequence", (t) => {
  const store = new Store(tempDb(t));
  t.after(() => store.close());
  store.put("session", { id: "session-1", workspaceId: "workspace-1" });
  store.put("evidenceSnapshot", {
    id: "ev_saved",
    workspaceId: "workspace-1",
    title: "Saved source",
    kind: "note",
    text: "Exact supporting text.",
  });
  store.put("runEvidence", {
    id: "run-1:ev_saved",
    runId: "run-1",
    evidenceId: "ev_saved",
    state: "loaded",
    loadedInPrompt: true,
  });
  store.createAgentRun(
    runRecord({
      workspaceId: "workspace-1",
      transcript: {
        version: 1,
        messages: [{ role: "user", content: "private prompt" }],
      },
      toolTranscript: [{ name: "source.read", result: "verbose result" }],
      diagnostics: { providerResponse: "verbose provider dump" },
      draftText: "Answer in progress",
      evidence: [{ id: "ev_saved", loadedInPrompt: true, state: "loaded" }],
    }),
    { type: "run.queued", status: "queued" },
  );
  store.appendAgentEvent("run-1", {
    type: "tool.started",
    toolCallId: "read-1",
    name: "source.read",
    arguments: { page: 2 },
  });
  store.appendAgentEvent("run-1", {
    type: "tool.completed",
    toolCallId: "read-1",
    name: "source.read",
    result: { text: "verbose passage" },
  });
  const finalized = store.finalizeAgentRun(
    {
      ...store.getAgentRun("run-1"),
      status: "completed",
      artifactId: "answer-1",
      transcript: {
        version: 1,
        messages: [{ role: "assistant", content: "verbose transcript" }],
      },
      draftText: "final answer draft",
    },
    {
      id: "answer-1",
      runId: "run-1",
      sessionId: "session-1",
      text: "Final saved answer.",
      evidence: [{ id: "ev_saved", title: "Saved source" }],
    },
    { type: "run.completed", status: "completed", artifactId: "answer-1" },
  );
  assert.equal(finalized.committed, true);
  const terminalBeforePurge = store.getAgentEvents("run-1").at(-1);

  const result = store.purgeAgentDiagnostics({ runId: "run-1" });
  assert.equal(result.runsPurged, 1);
  assert.equal(result.eventsDeleted, 3);
  assert.equal(result.toolCallsDeleted, 1);
  const remainingEvents = store.getAgentEvents("run-1");
  assert.equal(remainingEvents.length, 1);
  assert.equal(remainingEvents[0].type, "run.completed");
  assert.equal(remainingEvents[0].seq, terminalBeforePurge.seq);

  const compactedRun = store.getAgentRun("run-1");
  assert.equal(compactedRun.transcript, undefined);
  assert.equal(compactedRun.toolTranscript, undefined);
  assert.equal(compactedRun.diagnostics, undefined);
  assert.equal(compactedRun.draftText, undefined);
  assert.equal(compactedRun.input.text, "What are references 11 and 12?");
  assert.equal(compactedRun.evidence[0].id, "ev_saved");
  assert.equal(
    store.get("artifact", compactedRun.questionArtifactId).kind,
    "question",
  );
  assert.equal(store.get("artifact", "answer-1").text, "Final saved answer.");
  assert.equal(store.getAgentArtifact("run-1").text, "Final saved answer.");
  assert.equal(
    store.get("evidenceSnapshot", "ev_saved").text,
    "Exact supporting text.",
  );
  assert.equal(store.get("runEvidence", "run-1:ev_saved").state, "loaded");
  assert.equal(store.list("toolCall").length, 0);

  const second = store.purgeAgentDiagnostics({ runId: "run-1" });
  assert.equal(second.runsPurged, 0);
  assert.equal(second.eventsDeleted, 0);
  assert.equal(second.toolCallsDeleted, 0);
  assert.equal(store.getAgentEvents("run-1")[0].seq, terminalBeforePurge.seq);
});

test("session history deletion rejects active runs without changing persisted data", (t) => {
  const store = new Store(tempDb(t));
  t.after(() => store.close());
  store.put("session", {
    id: "session-1",
    workspaceId: "workspace-1",
    nextStep: "Open the source",
    takeaway: "A cached takeaway",
  });
  store.createAgentRun(runRecord());

  assert.throws(
    () => store.deleteSessionData("session-1"),
    (error) => error.code === "ACTIVE_RUNS" && error.status === 409,
  );
  assert.equal(store.getAgentRun("run-1").status, "queued");
  assert.equal(store.list("artifact").length, 1);
  assert.equal(store.get("session", "session-1").takeaway, "A cached takeaway");
});

test("session deletion removes owned research state and only unreferenced in-scope snapshots", (t) => {
  const filename = tempDb(t);
  const sentinelPath = join(filename, "..", "vault-pdf-must-remain.pdf");
  writeFileSync(sentinelPath, "PDF bytes stay in place");
  const store = new Store(filename);
  t.after(() => store.close());
  store.put("workspace", { id: "workspace-1", question: "Target workspace" });
  store.put("workspace", { id: "workspace-2", question: "Other workspace" });
  store.put("source", {
    id: "source-1",
    workspaceId: "workspace-1",
    title: "Paper",
  });
  store.put("session", {
    id: "session-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    nextStep: "Clear this",
    takeaway: "Clear this too",
  });
  store.put("session", {
    id: "session-2",
    workspaceId: "workspace-1",
    sourceId: "source-1",
  });
  store.put("session", { id: "session-foreign", workspaceId: "workspace-2" });
  store.setting("model", "kept-model");

  const snapshots = [
    ["ev_unique", { workspaceId: "workspace-1" }],
    ["ev_shared", { workspaceId: "workspace-1" }],
    ["ev_record_shared", { workspaceId: "workspace-1" }],
    ["ev_foreign_workspace", { workspaceId: "workspace-2" }],
    [
      "ev_foreign_session",
      { workspaceId: "workspace-1", sessionId: "session-2" },
    ],
  ];
  for (const [id, scope] of snapshots)
    store.put("evidenceSnapshot", {
      id,
      ...scope,
      title: id,
      kind: "note",
      text: `Evidence ${id}`,
    });

  store.createAgentRun(
    runRecord({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      evidenceIds: snapshots.map(([id]) => id),
      evidence: snapshots.map(([id]) => ({ id, title: id })),
    }),
    { type: "run.queued", status: "queued" },
  );
  for (const [id] of snapshots) {
    store.put("runEvidence", {
      id: `run-1:${id}`,
      runId: "run-1",
      evidenceId: id,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      state: "loaded",
    });
  }
  store.appendAgentEvent("run-1", {
    type: "context.updated",
    text: "target event",
  });
  store.finalizeAgentRun(
    {
      ...store.getAgentRun("run-1"),
      status: "completed",
      artifactId: "answer-1",
    },
    {
      id: "answer-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      text: "Saved answer.",
    },
    { type: "run.completed", status: "completed", artifactId: "answer-1" },
  );

  store.put("runEvidence", {
    id: "run-foreign:ev_shared",
    runId: "run-foreign",
    evidenceId: "ev_shared",
    sessionId: "session-2",
    workspaceId: "workspace-1",
  });
  store.put("researchClaim", {
    id: "claim-target",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    claim: "Target claim",
    evidenceIds: ["ev_unique", "ev_record_shared"],
  });
  store.put("researchInquiry", {
    id: "inquiry-other",
    sessionId: "session-2",
    workspaceId: "workspace-1",
    question: "Other session question",
    evidenceIds: ["ev_record_shared"],
  });
  store.put("sessionSummary", {
    id: "summary-target",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    text: "Target summary",
  });
  store.put("memoryProposal", {
    id: "proposal-target",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    status: "proposed",
    evidenceIds: ["ev_unique"],
  });
  store.put("researchClaim", {
    id: "foreign-scope-record",
    sessionId: "session-1",
    workspaceId: "workspace-2",
    claim: "Do not delete across workspaces",
  });
  store.put("researchClaim", {
    id: "workspace-only-claim",
    workspaceId: "workspace-1",
    claim: "Workspace-level record is not session history",
  });
  store.put("artifact", {
    id: "other-answer",
    sessionId: "session-2",
    workspaceId: "workspace-1",
    text: "Other session answer",
  });
  store.put("artifact", {
    id: "foreign-answer",
    sessionId: "session-foreign",
    workspaceId: "workspace-2",
    text: "Foreign answer",
  });

  const result = store.deleteSessionData("session-1");
  assert.equal(result.sessionPreserved, true);
  assert.equal(result.deletedRuns, 1);
  assert.equal(result.deletedEvents, 3);
  assert.equal(result.deletedAgentArtifacts, 1);
  assert.equal(result.deletedRecords.artifact, 2);
  assert.equal(result.deletedRecords.runEvidence, 5);
  assert.equal(result.deletedRecords.researchClaim, 1);
  assert.equal(result.deletedRecords.sessionSummary, 1);
  assert.equal(result.deletedRecords.memoryProposal, 1);
  assert.equal(result.deletedEvidenceSnapshots, 1);
  assert.equal(result.preservedSharedEvidenceSnapshots, 2);
  assert.equal(result.preservedForeignEvidenceSnapshots, 2);
  assert.equal(result.preservedForeignRecords, 1);
  assert.deepEqual(result.clearedSessionFields.sort(), [
    "nextStep",
    "takeaway",
  ]);

  assert.equal(store.get("session", "session-1").workspaceId, "workspace-1");
  assert.equal(store.get("session", "session-1").nextStep, undefined);
  assert.equal(store.get("session", "session-1").takeaway, undefined);
  assert.equal(store.get("session", "session-2").workspaceId, "workspace-1");
  assert.equal(
    store.get("workspace", "workspace-1").question,
    "Target workspace",
  );
  assert.equal(
    store.get("workspace", "workspace-2").question,
    "Other workspace",
  );
  assert.equal(store.get("source", "source-1").title, "Paper");
  assert.equal(store.setting("model"), "kept-model");
  assert.equal(store.getAgentRun("run-1"), undefined);
  assert.equal(store.getAgentArtifact("run-1"), undefined);
  assert.equal(store.get("artifact", "answer-1"), undefined);
  assert.equal(
    store.get("artifact", "other-answer").text,
    "Other session answer",
  );
  assert.equal(store.get("artifact", "foreign-answer").text, "Foreign answer");
  assert.equal(
    store.get("researchInquiry", "inquiry-other").question,
    "Other session question",
  );
  assert.equal(
    store.get("researchClaim", "foreign-scope-record").claim,
    "Do not delete across workspaces",
  );
  assert.equal(
    store.get("researchClaim", "workspace-only-claim").claim,
    "Workspace-level record is not session history",
  );
  assert.equal(store.get("evidenceSnapshot", "ev_unique"), undefined);
  for (const id of [
    "ev_shared",
    "ev_record_shared",
    "ev_foreign_workspace",
    "ev_foreign_session",
  ])
    assert.ok(
      store.get("evidenceSnapshot", id),
      `snapshot ${id} should be preserved`,
    );
  assert.equal(readFileSync(sentinelPath, "utf8"), "PDF bytes stay in place");
});
