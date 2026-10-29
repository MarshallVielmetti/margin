import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { AgentHarness } from "../server/agent/harness.mjs";

const validAnswer = async ({ text, evidence, requiredLabels }) => {
  assert.equal(typeof text, "string");
  assert.ok(Array.isArray(evidence));
  assert.equal(requiredLabels, undefined);
  return { valid: true, issues: [] };
};

function makeStore(t, filename = ":memory:") {
  const store = new Store(filename);
  t.after(() => {
    try {
      store.close();
    } catch {
      // A restart test may close the first connection early.
    }
  });
  return store;
}

function makeInput(overrides = {}) {
  return {
    sessionId: "session-1",
    text: "What are references 11, 12, and 26?",
    workspaceId: "workspace-1",
    sourceId: "paper-1",
    sourceRevision: "sha256:paper-revision-1",
    researchQuestion: "Understand the paper's bibliography.",
    anchor: { sourceId: "paper-1", page: 2 },
    mode: "discuss",
    selection: { quote: "references 11, 12, and 26" },
    model: { provider: "ollama", model: "local-model", endpointId: "local" },
    provider: "ollama",
    cloud: false,
    budgets: { wallClockMs: 5_000 },
    idempotencyKey: "request-1",
    ...overrides,
  };
}

function answer(
  text = "Recovered all three reference entries.",
  overrides = {},
) {
  return {
    text,
    evidence: [],
    kind: "reference-lookup",
    origin: "tool",
    status: "unverified",
    provider: "local",
    cloud: false,
    ...overrides,
  };
}

test("start persists a frozen question immediately, deduplicates retries, and saves a validated artifact", async (t) => {
  const store = makeStore(t);
  let calls = 0;
  let executeCalls = 0;
  const harness = new AgentHarness({
    store,
    validateAnswer: validAnswer,
    registerEvidence: (db, runId, input) =>
      db.put("evidenceSnapshot", { ...input, id: "ev-bibliography", runId }),
    prepare: async (run, { registerEvidence, emit }) => {
      calls += 1;
      assert.equal(Object.isFrozen(run.input), true);
      const evidence = await registerEvidence(
        {
          kind: "paper-bibliography",
          title: "Current paper · bibliography",
          text: "[11] First entry. [12] Second entry. [26] Third entry.",
        },
        "call-17",
      );
      emit("tool.started", {
        name: "source.references",
        toolCallId: "call-17",
        arguments: { labels: ["11", "12", "26"] },
      });
      emit("tool.completed", {
        name: "source.references",
        toolCallId: "call-17",
        ok: true,
      });
      emit("context.updated", { loadedEvidence: 1 });
      emit("text.delta", { type: "text.delta", delta: "provisional answer" });
      emit("run.completed", { provisional: true });
      return {
        deterministicAnswer: answer(
          "[11] First entry. [12] Second entry. [26] Third entry.",
          {
            evidence: [evidence],
            referenceResults: [
              { label: "11" },
              { label: "12" },
              { label: "26" },
            ],
            usage: { inputTokens: 15, outputTokens: 9 },
            transcript: {
              version: 1,
              messages: [
                { role: "user", content: "lookup" },
                {
                  role: "assistant",
                  channel: "analysis",
                  content: "private reasoning",
                },
                {
                  role: "tool",
                  name: "source.references",
                  content: "[11] entry",
                },
              ],
            },
          },
        ),
      };
    },
    execute: async () => {
      executeCalls += 1;
      return answer();
    },
  });

  const input = makeInput();
  const started = harness.start(input);
  assert.equal(started.status, "queued");
  assert.equal(started.text, input.text);
  assert.equal(started.mode, input.mode);
  assert.deepEqual(started.anchor, input.anchor);
  assert.deepEqual(started.selection, input.selection);
  assert.equal(harness.get(started.id).input.text, input.text);
  assert.equal(harness.get(started.id).sourceRevision, input.sourceRevision);
  input.model.model = "changed-after-start";
  const duplicate = harness.start(makeInput());
  assert.equal(duplicate.id, started.id);
  assert.equal(duplicate.input.text, "What are references 11, 12, and 26?");
  assert.throws(
    () => harness.start(makeInput({ text: "different retry payload" })),
    (error) => error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );

  const completed = await harness.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.model.model, "local-model");
  assert.deepEqual(completed.usage, { inputTokens: 15, outputTokens: 9 });
  assert.equal(
    completed.transcript.messages.some(
      (message) => message.channel === "analysis",
    ),
    false,
  );
  assert.equal(calls, 1);
  assert.equal(executeCalls, 0);
  assert.deepEqual(completed.evidenceIds, ["ev-bibliography"]);
  assert.equal(
    store.get("evidenceSnapshot", "ev-bibliography").parentToolCallId,
    "call-17",
  );
  assert.equal(store.list("toolCall")[0].status, "completed");
  assert.equal(store.listAgentRuns("session-1").length, 1);
  assert.equal(store.get("agentRun", completed.id).text, input.text);
  assert.equal(store.list("agentRun").length, 1);
  const questions = store
    .list("artifact")
    .filter((item) => item.kind === "question");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, completed.questionArtifactId);
  assert.equal(questions[0].runId, completed.id);
  assert.equal(questions[0].text, input.text);
  const artifact = store.get("artifact", completed.artifactId);
  assert.equal(artifact.runId, completed.id);
  assert.equal(artifact.kind, "reference-lookup");
  assert.equal(artifact.runStatus, "completed");
  assert.equal(artifact.evidence[0].id, "ev-bibliography");
  assert.equal(artifact.referenceResults.length, 3);
  assert.deepEqual(artifact.usage, { inputTokens: 15, outputTokens: 9 });

  const events = harness.events(started.id);
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.equal(
    events.some((event) => event.type === "runtime.terminal"),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "answer.delta"),
    true,
  );
  assert.equal(
    events.find((event) => event.type === "tool.started").status,
    "retrieving",
  );
  assert.equal(
    events.find((event) => event.type === "tool.completed").status,
    "generating",
  );
  assert.equal(
    events.filter((event) => event.type === "run.completed").length,
    1,
  );
  assert.equal(events.at(-1).type, "run.completed");
});

test("runs serialize within one session while independent sessions can proceed", async (t) => {
  const store = makeStore(t);
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(
    (resolve) => (firstStarted = resolve),
  );
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));
  let secondEntered = false;
  let otherSessionEntered = false;
  const harness = new AgentHarness({
    store,
    validateAnswer: validAnswer,
    prepare: async (run) => {
      if (run.input.text === "first") {
        firstStarted();
        await firstGate;
        return { deterministicAnswer: answer("first answer") };
      }
      if (run.input.text === "second") secondEntered = true;
      if (run.input.text === "other session") otherSessionEntered = true;
      return { deterministicAnswer: answer(`${run.input.text} answer`) };
    },
  });

  const first = harness.start(
    makeInput({ text: "first", idempotencyKey: "first" }),
  );
  const second = harness.start(
    makeInput({ text: "second", idempotencyKey: "second" }),
  );
  const independent = harness.start(
    makeInput({
      sessionId: "session-2",
      text: "other session",
      idempotencyKey: "third",
    }),
  );
  await firstStartedPromise;
  await harness.wait(independent.id);
  await Promise.resolve();
  assert.equal(otherSessionEntered, true);
  assert.equal(secondEntered, false);

  releaseFirst();
  await Promise.all([harness.wait(first.id), harness.wait(second.id)]);
  assert.equal(secondEntered, true);
});

test("cancellation wins a race with a late model result and keeps only streamed partial text", async (t) => {
  const store = makeStore(t);
  let releaseExecution;
  let executionStarted;
  let lateFinished;
  const executionGate = new Promise((resolve) => (releaseExecution = resolve));
  const executionStartedPromise = new Promise(
    (resolve) => (executionStarted = resolve),
  );
  const lateFinishedPromise = new Promise(
    (resolve) => (lateFinished = resolve),
  );
  const harness = new AgentHarness({
    store,
    validateAnswer: validAnswer,
    prepare: async () => ({}),
    execute: async (_prepared, _run, { emit }) => {
      executionStarted();
      emit("answer.delta", { text: "partial text " });
      await executionGate;
      lateFinished();
      return answer("partial text plus late answer");
    },
  });
  const started = harness.start(makeInput({ idempotencyKey: "cancel-race" }));
  await executionStartedPromise;
  const cancelled = harness.cancel(started.id, "stop requested");
  assert.equal(cancelled.status, "cancelled");
  await harness.wait(started.id);
  const artifact = store.getAgentArtifact(started.id);
  assert.equal(artifact.text, "partial text ");
  assert.equal(artifact.partial, true);

  releaseExecution();
  await lateFinishedPromise;
  await Promise.resolve();
  assert.equal(harness.get(started.id).status, "cancelled");
  assert.equal(store.getAgentArtifact(started.id).text, "partial text ");
  assert.equal(
    store.list("artifact").filter((item) => item.kind === "question").length,
    1,
  );
  assert.equal(
    store.list("artifact").filter((item) => item.kind !== "question").length,
    1,
  );
});

test("a process restart marks active runs recoverable without replaying execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "margin-agent-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, "margin.db");
  const firstStore = new Store(filename);
  const now = new Date().toISOString();
  firstStore.createAgentRun(
    {
      id: "interrupted-run",
      sessionId: "session-1",
      idempotencyKey: "interrupted-key",
      status: "generating",
      input: { text: "saved question" },
      workspaceId: "workspace-1",
      sourceId: "paper-1",
      sourceRevision: "sha256:before-crash",
      model: { model: "frozen-model" },
      provider: "local",
      budgets: { wallClockMs: 90_000 },
      evidence: [{ id: "ev-before-crash", text: "saved evidence" }],
      evidenceIds: ["ev-before-crash"],
      draftText: "Already streamed text",
      createdAt: now,
      updatedAt: now,
    },
    { type: "run.started", status: "generating" },
  );
  firstStore.appendAgentEvent("interrupted-run", {
    type: "tool.started",
    toolCallId: "pending-call",
    name: "source.read",
  });
  firstStore.close();

  const recoveredStore = new Store(filename);
  t.after(() => recoveredStore.close());
  let executions = 0;
  const harness = new AgentHarness({
    store: recoveredStore,
    prepare: async () => {
      executions += 1;
      return { deterministicAnswer: answer("must not replay") };
    },
  });
  const recovered = harness.get("interrupted-run");
  assert.equal(recovered.status, "partial");
  assert.equal(recovered.recoverable, true);
  assert.equal(recovered.sourceRevision, "sha256:before-crash");
  assert.equal(recovered.failure.type, "process-restarted");
  assert.equal(recovered.draftText, "Already streamed text");
  assert.equal(
    recoveredStore.getAgentArtifact("interrupted-run").text,
    "Already streamed text",
  );
  assert.equal(
    recoveredStore.get("toolCall", "interrupted-run:pending-call").status,
    "interrupted",
  );
  assert.equal(executions, 0);
  assert.equal(
    harness.events("interrupted-run").at(-1).reason,
    "process-restarted",
  );
});

test("provider failures become terminal failed runs with a durable error event", async (t) => {
  const store = makeStore(t);
  const harness = new AgentHarness({
    store,
    validateAnswer: validAnswer,
    prepare: async () => {
      throw new Error("provider unavailable");
    },
  });
  const started = harness.start(
    makeInput({ idempotencyKey: "provider-failure" }),
  );
  const failed = await harness.wait(started.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.message, "provider unavailable");
  assert.equal(harness.events(started.id).at(-1).type, "run.failed");
  assert.equal(store.getAgentArtifact(started.id), undefined);
});

test("wall-clock budget stops a stuck callback and preserves a partial artifact", async (t) => {
  const store = makeStore(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  const harness = new AgentHarness({
    store,
    prepare: async (_run, { emit }) => {
      emit("answer.delta", { text: "partial before timeout" });
      entered();
      await gate;
      return { deterministicAnswer: answer("late") };
    },
  });
  const started = harness.start(
    makeInput({ idempotencyKey: "timeout", budgets: { wallClockMs: 30 } }),
  );
  await enteredPromise;
  const timedOut = await harness.wait(started.id);
  assert.equal(timedOut.status, "partial");
  assert.equal(timedOut.failure.type, "wall-clock-budget-exceeded");
  assert.equal(
    store.getAgentArtifact(started.id).text,
    "partial before timeout",
  );
  release();
  await Promise.resolve();
  assert.equal(
    store.getAgentArtifact(started.id).text,
    "partial before timeout",
  );
});

test("wall-clock budget also releases a run waiting on answer validation", async (t) => {
  const store = makeStore(t);
  let releaseValidation;
  let validationStarted;
  const validationGate = new Promise(
    (resolve) => (releaseValidation = resolve),
  );
  const validationStartedPromise = new Promise(
    (resolve) => (validationStarted = resolve),
  );
  const harness = new AgentHarness({
    store,
    prepare: async () => ({
      deterministicAnswer: answer("answer before validation"),
    }),
    validateAnswer: async () => {
      validationStarted();
      await validationGate;
      return { valid: true, issues: [] };
    },
  });
  const started = harness.start(
    makeInput({
      idempotencyKey: "validation-timeout",
      budgets: { wallClockMs: 30 },
    }),
  );
  await validationStartedPromise;
  const timedOut = await harness.wait(started.id);
  assert.equal(timedOut.status, "partial");
  assert.equal(timedOut.failure.type, "wall-clock-budget-exceeded");
  assert.equal(
    store.getAgentArtifact(started.id).text,
    "answer before validation",
  );
  releaseValidation();
  await Promise.resolve();
  assert.equal(harness.get(started.id).status, "partial");
});

test("tool execution budget stops the next tool call and preserves the configured ceiling", async (t) => {
  const store = makeStore(t);
  let toolCalls = 0;
  const harness = new AgentHarness({
    store,
    prepare: async (_run, { emit }) => {
      emit("tool.started", { tool: "source.references", callId: "call-1" });
      toolCalls += 1;
      emit("tool.started", { tool: "source.read", callId: "call-2" });
      toolCalls += 1;
      return { deterministicAnswer: answer("must not finish after budget") };
    },
  });
  const started = harness.start(
    makeInput({
      idempotencyKey: "tool-budget",
      budgets: { maxSeconds: 5, maxToolCalls: 1 },
    }),
  );
  const partial = await harness.wait(started.id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.failure.type, "toolExecutions-budget-exceeded");
  assert.equal(partial.budgets.maxToolExecutions, 1);
  assert.equal(partial.budgets.maxToolCalls, 1);
  assert.equal(partial.budgets.maxSeconds, 5);
  assert.equal(toolCalls, 1);
  assert.equal(
    harness.events(started.id).filter((event) => event.type === "tool.started")
      .length,
    1,
  );
});

test("citation validation sees only evidence loaded into the model context", async (t) => {
  const store = makeStore(t);
  let validatedEvidence;
  const harness = new AgentHarness({
    store,
    registerEvidence: (db, runId, input) => {
      const evidence = { ...input, id: input.id, runId, handles: [input.id] };
      db.put("evidenceSnapshot", evidence);
      db.put("runEvidence", {
        id: `${runId}:${input.id}`,
        runId,
        evidenceId: input.id,
        handles: [input.id],
        state: "available",
      });
      return evidence;
    },
    validateAnswer: async (value) => {
      validatedEvidence = value.evidence;
      return {
        valid: value.evidence.some((item) => item.id === "ev_loaded"),
        issues: [],
      };
    },
    prepare: async (_run, { registerEvidence }) => {
      const loaded = await registerEvidence(
        {
          id: "ev_loaded",
          title: "Loaded source",
          kind: "paper",
          text: "loaded",
        },
        "call-loaded",
      );
      const inventoryOnly = await registerEvidence(
        {
          id: "ev_inventory",
          title: "Available source",
          kind: "note",
          text: "not sent",
        },
        "call-inventory",
      );
      return {
        deterministicAnswer: answer(
          "A claim supported by {{cite:ev_loaded}}.",
          {
            evidence: [loaded, inventoryOnly],
            loadedEvidenceIds: ["ev_loaded"],
          },
        ),
      };
    },
  });
  const started = harness.start(
    makeInput({ idempotencyKey: "loaded-evidence" }),
  );
  const completed = await harness.wait(started.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(
    validatedEvidence.map((item) => item.id),
    ["ev_loaded"],
  );
  const artifact = store.getAgentArtifact(started.id);
  assert.deepEqual(
    artifact.evidence.map((item) => [item.id, item.loadedInPrompt, item.state]),
    [
      ["ev_loaded", true, "loaded"],
      ["ev_inventory", false, "available"],
    ],
  );
  assert.equal(
    store.get("runEvidence", `${started.id}:ev_loaded`).state,
    "loaded",
  );
  assert.equal(
    store.get("runEvidence", `${started.id}:ev_inventory`).state,
    "available",
  );
});

test("graceful stop marks active work recoverable and waits for abort-aware jobs", async (t) => {
  const store = makeStore(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  const harness = new AgentHarness({
    store,
    prepare: async (_run, { emit }) => {
      emit("answer.delta", { text: "saved before stop" });
      entered();
      await gate;
      return { deterministicAnswer: answer("late result") };
    },
  });
  const started = harness.start(makeInput({ idempotencyKey: "shutdown" }));
  await enteredPromise;
  const shutdownRuns = await harness.stop("server closing");
  assert.equal(
    shutdownRuns.find((run) => run.id === started.id).status,
    "partial",
  );
  assert.equal(harness.get(started.id).failure.type, "process-shutdown");
  assert.equal(store.getAgentArtifact(started.id).text, "saved before stop");
  assert.throws(
    () => harness.start(makeInput({ idempotencyKey: "after-stop" })),
    /shutting down/,
  );
  release();
  await harness.wait(started.id);
  assert.equal(store.getAgentArtifact(started.id).text, "saved before stop");
});

test("continue starts a new run with the same frozen inquiry and a recorded parent", async (t) => {
  const store = makeStore(t);
  let attempts = 0;
  const harness = new AgentHarness({
    store,
    validateAnswer: validAnswer,
    prepare: async () => {
      attempts += 1;
      return {
        deterministicAnswer: answer("partial answer", {
          partial: attempts === 1,
        }),
      };
    },
  });
  const first = harness.start(makeInput({ idempotencyKey: "continue-1" }));
  const firstDone = await harness.wait(first.id);
  assert.equal(firstDone.status, "partial");
  const next = harness.continue(first.id, {
    budgets: { wallClockMs: 6_000, maxToolExecutions: 8 },
  });
  assert.notEqual(next.id, first.id);
  assert.equal(next.continuationOf, first.id);
  assert.equal(next.input.text, first.input.text);
  assert.equal(next.questionArtifactId, first.questionArtifactId);
  assert.equal(next.sourceRevision, first.sourceRevision);
  const continued = await harness.wait(next.id);
  assert.equal(continued.status, "completed");
  assert.equal(continued.budgets.maxToolExecutions, 8);
  assert.equal(
    store.list("artifact").filter((item) => item.kind === "question").length,
    1,
  );
});
