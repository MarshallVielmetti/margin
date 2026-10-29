import { randomUUID } from "node:crypto";
import { RunEventHub } from "./events.mjs";

const ACTIVE_STATES = new Set([
  "queued",
  "preparing",
  "retrieving",
  "generating",
  "validating",
]);
const RUNTIME_TERMINAL_EVENTS = new Set([
  "run.completed",
  "run.partial",
  "run.failed",
  "run.cancelled",
  "run.awaiting_user",
]);

const DEFAULT_BUDGETS = Object.freeze({
  profile: "quick",
  maxModelCalls: 3,
  maxToolExecutions: 6,
  wallClockMs: 90_000,
});

const ARTIFACT_FIELDS = [
  "text",
  "evidence",
  "kind",
  "origin",
  "status",
  "partial",
  "truncated",
  "model",
  "provider",
  "cloud",
  "mode",
  "routing",
  "retrievalWarning",
  "usage",
  "validation",
  "referenceResults",
  "loadedEvidenceIds",
  "citationEvidenceIds",
  "anchor",
  "selection",
  "capabilities",
];

const PRIVATE_FIELD =
  /(?:chain.?of.?thought|private.?reasoning|reasoning|scratchpad|thought|analysis|api.?key|authorization|password|secret|credential)/i;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function bounded(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return value.slice(0, 4_000);
  if (typeof value === "undefined") return undefined;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => bounded(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (PRIVATE_FIELD.test(key)) continue;
      const next = bounded(item, depth + 1);
      if (next !== undefined) result[key] = next;
    }
    return result;
  }
  return String(value).slice(0, 1_000);
}

function errorDetails(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    message: String(error?.message || error || "Run failed").slice(0, 1_000),
  };
}

function normalizedBudget(input) {
  const source = input || {};
  const budgets = { ...DEFAULT_BUDGETS, ...source };
  const wallClockInput =
    source.wallClockMs ??
    source.timeoutMs ??
    (source.maxSeconds !== undefined
      ? Number(source.maxSeconds) * 1_000
      : undefined);
  const wallClockMs = Number(wallClockInput ?? DEFAULT_BUDGETS.wallClockMs);
  budgets.wallClockMs = Number.isFinite(wallClockMs)
    ? Math.max(1, Math.min(30 * 60_000, wallClockMs))
    : DEFAULT_BUDGETS.wallClockMs;
  budgets.maxSeconds = Math.max(0.001, budgets.wallClockMs / 1_000);
  if (
    source.maxToolExecutions === undefined &&
    source.maxToolCalls !== undefined
  )
    budgets.maxToolExecutions = source.maxToolCalls;
  budgets.maxToolCalls = Number.isFinite(Number(source.maxToolCalls))
    ? Math.max(0, Math.floor(Number(source.maxToolCalls)))
    : budgets.maxToolExecutions;
  for (const field of ["maxModelCalls", "maxToolExecutions"]) {
    const value = Number(budgets[field]);
    budgets[field] =
      Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_BUDGETS[field];
  }
  return budgets;
}

function answerFrom(prepared, executed) {
  const result = executed ?? prepared?.deterministicAnswer;
  if (typeof result === "string") return { text: result };
  if (result && typeof result === "object" && typeof result.text === "string")
    return result;
  return undefined;
}

function mergeEvidence(first = [], second = []) {
  const values = [
    ...(Array.isArray(first) ? first : []),
    ...(Array.isArray(second) ? second : []),
  ];
  const byId = new Map();
  const withoutId = [];
  for (const item of values) {
    const id = typeof item === "string" ? item : item?.id;
    if (id) byId.set(String(id), item);
    else withoutId.push(item);
  }
  return [...byId.values(), ...withoutId];
}

function artifactFrom(run, answer, validation, status, fallbackText = "") {
  const result = answer || {};
  const draft = result.text || fallbackText || run.draftText || "";
  if (!draft.trim()) return undefined;
  const metadata = {};
  for (const field of ARTIFACT_FIELDS) {
    if (result[field] !== undefined) metadata[field] = bounded(result[field]);
  }
  return {
    ...metadata,
    id: randomUUID(),
    runId: run.id,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    sourceId: run.sourceId,
    sourceRevision: run.sourceRevision,
    anchor: bounded(result.anchor ?? run.input.anchor),
    selection: bounded(result.selection ?? run.input.selection),
    mode: result.mode ?? run.input.mode,
    text: draft,
    evidence: mergeEvidence(run.evidence, result.evidence),
    validation: validation ? bounded(validation) : undefined,
    partial: status !== "completed" || !!result.partial || !!result.truncated,
    status: result.status || (status === "completed" ? "unverified" : status),
    runStatus: status,
    usage: result.usage !== undefined ? result.usage : run.usage,
    origin: result.origin || "ai",
    kind: result.kind || "tutor",
    model: result.model !== undefined ? result.model : run.model,
    provider: result.provider !== undefined ? result.provider : run.provider,
    cloud: result.cloud !== undefined ? result.cloud : run.cloud,
    createdAt: new Date().toISOString(),
  };
}

function validationResult(value) {
  if (!value || typeof value !== "object")
    return { valid: false, issues: ["Answer validation returned no result."] };
  return {
    valid: value.valid === true,
    issues: Array.isArray(value.issues)
      ? value.issues.map((item) => bounded(item))
      : [],
    ...(Array.isArray(value.citations)
      ? { citations: value.citations.map((item) => bounded(item)) }
      : {}),
  };
}

function safeTranscript(transcript) {
  if (!transcript || typeof transcript !== "object") return undefined;
  const messages = Array.isArray(transcript.messages)
    ? transcript.messages
    : [];
  const safeMessages = [];
  let totalChars = 0;
  for (const message of messages.slice(-300)) {
    if (!message || typeof message !== "object") continue;
    if (
      /analysis|reasoning|thought/i.test(
        String(message.channel || message.type || ""),
      )
    )
      continue;
    const safe = bounded(message);
    let encoded;
    try {
      encoded = JSON.stringify(safe);
    } catch {
      continue;
    }
    if (totalChars + encoded.length > 200_000) break;
    totalChars += encoded.length;
    safeMessages.push(safe);
  }
  return { version: transcript.version ?? 1, messages: safeMessages };
}

/**
 * Durable run coordinator. `prepare` resolves deterministic context and may
 * return `deterministicAnswer`; `execute` is called only when preparation did
 * not produce one.
 */
export class AgentHarness {
  constructor({
    store,
    prepare,
    execute,
    registerEvidence,
    validateAnswer,
    promptVersion = "1",
    toolVersion = "1",
    now = () => new Date(),
    idFactory = randomUUID,
  }) {
    if (!store) throw new TypeError("AgentHarness requires a Store.");
    if (typeof prepare !== "function")
      throw new TypeError("AgentHarness requires prepare().");
    if (execute !== undefined && typeof execute !== "function")
      throw new TypeError("execute must be a function when provided.");
    if (validateAnswer !== undefined && typeof validateAnswer !== "function")
      throw new TypeError("validateAnswer must be a function when provided.");
    this.store = store;
    this.prepare = prepare;
    this.execute = execute;
    this.registerEvidenceImpl = registerEvidence;
    this.validateAnswerImpl = validateAnswer;
    this.promptVersion = promptVersion;
    this.toolVersion = toolVersion;
    this.now = now;
    this.idFactory = idFactory;
    this.eventHub = new RunEventHub(store);
    this.sessionTails = new Map();
    this.jobs = new Map();
    this.controllers = new Map();
    this.deadlines = new Map();
    this.stopped = false;
    this.#recoverInterruptedRuns();
  }

  start(input) {
    if (this.stopped) throw new Error("The agent harness is shutting down.");
    if (!input || typeof input !== "object")
      throw new TypeError("Run input is required.");
    if (typeof input.sessionId !== "string" || !input.sessionId.trim())
      throw new TypeError("sessionId is required.");
    if (typeof input.text !== "string" || !input.text.trim())
      throw new TypeError("text is required.");

    const createdAt = this.now().toISOString();
    const continuationParent = input.continuationOf
      ? this.store.getAgentRun(input.continuationOf)
      : undefined;
    const inheritedQuestionArtifactId =
      continuationParent?.text === input.text
        ? continuationParent.questionArtifactId
        : undefined;
    const frozenInput = deepFreeze(
      clone({
        text: input.text,
        anchor: input.anchor,
        mode: input.mode,
        selection: input.selection,
        model: input.model ?? input.modelIdentity ?? input.selection?.model,
        provider: input.provider ?? input.selection?.provider,
        cloud: input.cloud ?? input.selection?.cloud,
        contextOverrides: input.contextOverrides,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        researchQuestion: input.researchQuestion,
      }),
    );
    const run = {
      id: input.id || this.idFactory(),
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey || null,
      questionArtifactId:
        input.questionArtifactId || inheritedQuestionArtifactId,
      text: frozenInput.text,
      anchor: frozenInput.anchor,
      mode: frozenInput.mode,
      selection: frozenInput.selection,
      contextOverrides: frozenInput.contextOverrides,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      researchQuestion: input.researchQuestion,
      input: frozenInput,
      scope: deepFreeze(
        clone({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          permissionScope: input.permissionScope,
          allowedProviders: input.allowedProviders,
          allowedTools: input.allowedTools,
        }),
      ),
      model: deepFreeze(
        clone(input.model ?? input.modelIdentity ?? input.selection?.model),
      ),
      selection: deepFreeze(clone(input.selection)),
      provider: input.provider ?? input.selection?.provider,
      cloud: input.cloud ?? input.selection?.cloud,
      capabilityProfile: deepFreeze(clone(input.capabilityProfile)),
      budgets: deepFreeze(normalizedBudget(input.budgets)),
      promptVersion: input.promptVersion ?? this.promptVersion,
      toolVersion: input.toolVersion ?? this.toolVersion,
      status: "queued",
      evidence: [],
      evidenceIds: [],
      draftText: "",
      continuationOf: input.continuationOf,
      recoverable: false,
      createdAt,
      updatedAt: createdAt,
    };

    const inserted = this.store.createAgentRun(run, {
      type: "run.queued",
      status: "queued",
      createdAt,
    });
    if (inserted.event) this.eventHub.publish(inserted.run.id, inserted.event);
    if (inserted.created) this.#schedule(inserted.run);
    return inserted.run;
  }

  get(id) {
    return this.store.getAgentRun(id);
  }

  events(id, after = 0) {
    return this.store.getAgentEvents(id, after);
  }

  subscribe(id, listener, options = {}) {
    return this.eventHub.subscribe(id, listener, options);
  }

  cancel(id, reason = "cancelled by user") {
    const current = this.store.getAgentRun(id);
    if (!current || !ACTIVE_STATES.has(current.status)) return current;
    const patch = {
      status: "cancelled",
      cancelledAt: this.now().toISOString(),
      cancelReason: String(reason).slice(0, 500),
    };
    const artifact = artifactFrom(current, undefined, undefined, "cancelled");
    const result = this.store.finalizeAgentRun(
      {
        ...current,
        ...patch,
        ...(artifact ? { artifactId: artifact.id } : {}),
      },
      artifact,
      {
        type: "run.cancelled",
        status: "cancelled",
        reason: patch.cancelReason,
      },
    );
    if (result.event) this.eventHub.publish(id, result.event);
    const controller = this.controllers.get(id);
    if (result.committed && controller && !controller.signal.aborted)
      controller.abort(patch.cancelReason);
    this.#clearDeadline(id);
    return result.run;
  }

  continue(id, input = {}) {
    const previous = this.get(id);
    if (!previous) throw new Error(`Unknown agent run: ${id}`);
    if (ACTIVE_STATES.has(previous.status))
      throw new Error(
        "A run must reach a terminal state before it can continue.",
      );
    return this.start({
      sessionId: previous.sessionId,
      text: input.text ?? previous.input.text,
      anchor: input.anchor ?? previous.input.anchor,
      mode: input.mode ?? previous.input.mode,
      contextOverrides:
        input.contextOverrides ?? previous.input.contextOverrides,
      workspaceId: previous.workspaceId,
      sourceId: previous.sourceId,
      sourceRevision: previous.sourceRevision,
      researchQuestion: previous.researchQuestion,
      model: input.model ?? previous.model,
      selection: input.selection ?? previous.selection,
      provider: input.provider ?? previous.provider,
      cloud: input.cloud ?? previous.cloud,
      capabilityProfile: input.capabilityProfile ?? previous.capabilityProfile,
      permissionScope: input.permissionScope ?? previous.scope?.permissionScope,
      allowedProviders:
        input.allowedProviders ?? previous.scope?.allowedProviders,
      allowedTools: input.allowedTools ?? previous.scope?.allowedTools,
      budgets: input.budgets ?? previous.budgets,
      promptVersion: input.promptVersion ?? previous.promptVersion,
      toolVersion: input.toolVersion ?? previous.toolVersion,
      idempotencyKey: input.idempotencyKey || this.idFactory(),
      continuationOf: previous.id,
    });
  }

  async wait(id) {
    const job = this.jobs.get(id);
    if (job) await job;
    return this.get(id);
  }

  async stop(reason = "server shutdown") {
    this.stopped = true;
    const jobs = [...this.jobs.values()];
    for (const run of this.store.listAgentRuns()) {
      if (!ACTIVE_STATES.has(run.status)) continue;
      const artifact = artifactFrom(run, undefined, undefined, "partial");
      const message = String(reason).slice(0, 500);
      const result = this.store.finalizeAgentRun(
        {
          ...run,
          status: "partial",
          recoverable: true,
          failure: { type: "process-shutdown", message },
          error: message,
          artifactId: artifact?.id,
          completedAt: this.now().toISOString(),
        },
        artifact,
        {
          type: "run.partial",
          status: "partial",
          reason: "process-shutdown",
          message,
          artifactId: artifact?.id,
        },
      );
      if (result.event) this.eventHub.publish(run.id, result.event);
      const controller = this.controllers.get(run.id);
      if (controller && !controller.signal.aborted) controller.abort(message);
      this.#clearDeadline(run.id);
    }
    await Promise.allSettled(jobs);
    return this.store.listAgentRuns();
  }

  #schedule(run) {
    const budgetMs = run.budgets.wallClockMs;
    const elapsed = this.now().getTime() - new Date(run.createdAt).getTime();
    const deadline = setTimeout(
      () => this.#timeoutRun(run.id),
      Math.max(1, budgetMs - Math.max(0, elapsed)),
    );
    this.deadlines.set(run.id, deadline);

    const previous = this.sessionTails.get(run.sessionId) || Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(() => this.#executeRun(run.id))
      .catch((error) => this.#failRun(run.id, error));
    this.jobs.set(run.id, job);
    this.sessionTails.set(run.sessionId, job);
    const cleanup = () => {
      if (this.jobs.get(run.id) === job) this.jobs.delete(run.id);
      if (this.sessionTails.get(run.sessionId) === job)
        this.sessionTails.delete(run.sessionId);
    };
    job.then(cleanup, cleanup);
  }

  async #executeRun(id) {
    const initial = this.get(id);
    if (!initial || !ACTIVE_STATES.has(initial.status)) return initial;
    if (
      this.now().getTime() - new Date(initial.createdAt).getTime() >=
      initial.budgets.wallClockMs
    ) {
      this.#timeoutRun(id);
      return this.get(id);
    }

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.#transition(id, "preparing", "run.started");

    let abortListener;
    const aborted = new Promise((resolve) => {
      abortListener = () => resolve({ aborted: true });
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });
    const work = this.#prepareAndExecute(id, controller.signal).then(
      (answer) => ({ answer }),
      (error) => ({ error }),
    );

    try {
      const result = await Promise.race([work, aborted]);
      if (result.aborted) return this.get(id);
      if (result.error) {
        this.#failRun(id, result.error);
        return this.get(id);
      }
      const current = this.get(id);
      if (!current || !ACTIVE_STATES.has(current.status)) return current;
      await this.#completeRun(
        current,
        result.answer,
        controller.signal,
        aborted,
      );
      return this.get(id);
    } finally {
      controller.signal.removeEventListener("abort", abortListener);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.#clearDeadline(id);
    }
  }

  async #prepareAndExecute(id, signal) {
    const run = this.get(id);
    if (!run || signal.aborted) return undefined;
    const callbackRun = deepFreeze(clone(run));
    const emit = (type, payload) => this.#emit(id, type, payload);
    const registerEvidence = async (input, parentToolCallId) => {
      const latest = this.get(id);
      if (!latest || !ACTIVE_STATES.has(latest.status) || signal.aborted)
        return undefined;
      const snapshotInput = {
        ...clone(input),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      };
      let snapshot;
      if (this.registerEvidenceImpl) {
        snapshot = await this.registerEvidenceImpl(
          this.store,
          id,
          snapshotInput,
        );
      } else {
        snapshot = this.store.put("evidenceSnapshot", {
          ...snapshotInput,
          runId: id,
        });
      }
      const after = this.get(id);
      if (
        !snapshot ||
        !after ||
        !ACTIVE_STATES.has(after.status) ||
        signal.aborted
      )
        return undefined;
      const existing = after.evidence.find((item) => item?.id === snapshot.id);
      const runEvidence = {
        ...snapshot,
        state: existing?.state || "available",
        loadedInPrompt: existing?.loadedInPrompt || false,
      };
      const evidence = mergeEvidence(after.evidence, [runEvidence]);
      const evidenceIds = [
        ...new Set([...after.evidenceIds, snapshot.id].filter(Boolean)),
      ];
      const saved = this.store.updateAgentRun(
        { ...after, evidence, evidenceIds },
        {
          type: "evidence.registered",
          evidenceId: snapshot.id,
          title: snapshot.title,
          kind: snapshot.kind,
          parentToolCallId: snapshot.parentToolCallId,
        },
      );
      if (saved.event) this.eventHub.publish(id, saved.event);
      return snapshot;
    };

    const prepared = await this.prepare(callbackRun, {
      signal,
      emit,
      registerEvidence,
    });
    if (signal.aborted || !ACTIVE_STATES.has(this.get(id)?.status))
      return undefined;
    if (prepared?.contextUpdated !== undefined)
      emit("context.updated", bounded(prepared.contextUpdated));

    const deterministic = answerFrom(prepared);
    if (deterministic) return deterministic;
    if (!this.execute)
      throw new Error(
        "Preparation did not produce an answer and execute() is unavailable.",
      );

    this.#transition(id, "generating", "run.state");
    const executeRun = deepFreeze(clone(this.get(id)));
    const executed = await this.execute(prepared, executeRun, {
      signal,
      emit,
      registerEvidence,
    });
    if (signal.aborted || !ACTIVE_STATES.has(this.get(id)?.status))
      return undefined;
    return answerFrom(undefined, executed);
  }

  async #completeRun(current, answer, signal, aborted) {
    if (!answer || typeof answer.text !== "string" || !answer.text.trim()) {
      this.#failRun(current.id, new Error("Run produced no answer text."));
      return;
    }
    const beforeValidation = this.get(current.id);
    if (!beforeValidation || !ACTIVE_STATES.has(beforeValidation.status))
      return;
    const evidenceInventory = mergeEvidence(current.evidence, answer.evidence);
    const loadedIdsValue = Array.isArray(answer.loadedEvidenceIds)
      ? answer.loadedEvidenceIds
      : Array.isArray(answer.citationEvidenceIds)
        ? answer.citationEvidenceIds
        : undefined;
    const loadedIds = loadedIdsValue
      ? new Set(loadedIdsValue.map(String))
      : undefined;
    const evidence = evidenceInventory.map((item) => {
      if (!loadedIds || typeof item === "string" || !item?.id) return item;
      const loadedInPrompt = loadedIds.has(String(item.id));
      return {
        ...item,
        loadedInPrompt,
        state: loadedInPrompt ? "loaded" : item.state || "available",
      };
    });
    this.store.updateAgentRun({
      ...beforeValidation,
      draftText: answer.text,
      evidence,
      ...(loadedIds ? { loadedEvidenceIds: [...loadedIds] } : {}),
      ...(answer.usage !== undefined ? { usage: bounded(answer.usage) } : {}),
      ...(answer.capabilities
        ? { capabilityProfile: bounded(answer.capabilities) }
        : {}),
      ...(answer.transcript
        ? { transcript: safeTranscript(answer.transcript) }
        : {}),
    });
    const citationEvidence = loadedIds
      ? evidence.filter((item) =>
          loadedIds.has(String(typeof item === "string" ? item : item?.id)),
        )
      : evidence;
    const validationInput = {
      text: answer.text,
      evidence: citationEvidence,
      requiredLabels: undefined,
    };
    this.#transition(current.id, "validating", "run.state");
    let validation;
    if (this.validateAnswerImpl) {
      try {
        const validationWork = Promise.resolve()
          .then(() => this.validateAnswerImpl(validationInput))
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        const result = await Promise.race([validationWork, aborted]);
        if (result.aborted || signal.aborted) return;
        if (result.error) throw result.error;
        validation = validationResult(result.value);
      } catch (error) {
        validation = {
          valid: false,
          issues: [`Answer validation failed: ${errorDetails(error).message}`],
        };
      }
    } else {
      validation = {
        valid: false,
        issues: ["Answer validation is not configured."],
      };
    }
    const refreshed = this.get(current.id);
    if (!refreshed || !ACTIVE_STATES.has(refreshed.status)) return;
    const preparedStatus =
      validation.valid && !answer.partial && !answer.truncated
        ? "completed"
        : "partial";
    const artifact = artifactFrom(
      refreshed,
      { ...answer, evidence },
      validation,
      preparedStatus,
    );
    const finalStatus = artifact ? preparedStatus : "failed";
    const artifactId = artifact?.id;
    const terminalRun = {
      ...refreshed,
      status: finalStatus,
      evidence,
      ...(loadedIds ? { loadedEvidenceIds: [...loadedIds] } : {}),
      draftText: answer.text,
      ...(answer.usage !== undefined ? { usage: bounded(answer.usage) } : {}),
      ...(answer.capabilities
        ? { capabilityProfile: bounded(answer.capabilities) }
        : {}),
      ...(answer.transcript
        ? { transcript: safeTranscript(answer.transcript) }
        : {}),
      validation,
      artifactId,
      completedAt: this.now().toISOString(),
      ...(finalStatus === "partial" ? { recoverable: true } : {}),
      ...(finalStatus === "partial"
        ? {
            error: validation.valid
              ? "The answer is partial and can be continued."
              : validation.issues[0]?.message ||
                validation.issues[0]?.code ||
                String(
                  validation.issues[0] || "Answer validation did not pass.",
                ),
          }
        : {}),
    };
    const validationEvent = this.eventHub.append(
      current.id,
      "validation.completed",
      {
        valid: validation.valid,
        issues: validation.issues,
      },
    );
    void validationEvent;
    const saved = this.store.finalizeAgentRun(terminalRun, artifact, {
      type: finalStatus === "completed" ? "run.completed" : "run.partial",
      status: finalStatus,
      artifactId,
      validation,
      ...(answer.truncated ? { truncated: true } : {}),
    });
    if (saved.event) this.eventHub.publish(current.id, saved.event);
    this.#clearDeadline(current.id);
  }

  #emit(id, type, payload = {}) {
    if (typeof type !== "string" || !type.trim())
      throw new TypeError("Run event type must be a non-empty string.");
    const run = this.get(id);
    if (!run || !ACTIVE_STATES.has(run.status)) return undefined;
    let eventType = type === "text.delta" ? "answer.delta" : type;
    let safePayload = bounded(payload || {});
    if (RUNTIME_TERMINAL_EVENTS.has(type)) {
      eventType = "runtime.terminal";
      safePayload = {
        ...(safePayload && typeof safePayload === "object"
          ? safePayload
          : { value: safePayload }),
        runtimeStatus: type.slice("run.".length),
      };
    }
    const counter =
      type === "tool.started"
        ? "toolExecutions"
        : [
              "model.started",
              "model.call.started",
              "model.request.started",
            ].includes(type)
          ? "modelCalls"
          : undefined;
    if (counter) {
      const usage = {
        modelCalls: run.budgetUsage?.modelCalls || 0,
        toolExecutions: run.budgetUsage?.toolExecutions || 0,
        [counter]: (run.budgetUsage?.[counter] || 0) + 1,
      };
      const limit =
        counter === "modelCalls"
          ? run.budgets.maxModelCalls
          : run.budgets.maxToolExecutions;
      if (usage[counter] > limit) {
        this.#budgetExceeded(id, counter, limit);
        const error = new Error(
          `The run reached its ${counter} limit (${limit}).`,
        );
        error.code = "BUDGET_EXCEEDED";
        throw error;
      }
      const status =
        type === "tool.started" &&
        ["preparing", "generating"].includes(run.status)
          ? "retrieving"
          : type === "model.started" && run.status === "retrieving"
            ? "generating"
            : run.status;
      const saved = this.store.updateAgentRun(
        { ...run, budgetUsage: usage, status },
        { ...safePayload, type, status },
      );
      if (saved.event) this.eventHub.publish(id, saved.event);
      return saved.event;
    }
    if (type === "tool.completed" && run.status === "retrieving") {
      const updated = this.store.updateAgentRun(
        { ...run, status: "generating" },
        { ...safePayload, type, status: "generating" },
      );
      if (updated.event) this.eventHub.publish(id, updated.event);
      return updated.event;
    }
    if (eventType === "answer.delta") {
      const delta =
        typeof safePayload?.text === "string"
          ? safePayload.text
          : typeof safePayload?.delta === "string"
            ? safePayload.delta
            : "";
      if (delta) {
        const eventPayload = { ...safePayload, text: delta };
        const updated = this.store.updateAgentRun(
          {
            ...run,
            draftText: `${run.draftText || ""}${delta}`.slice(0, 100_000),
          },
          { ...eventPayload, type: eventType },
        );
        if (updated.event) this.eventHub.publish(id, updated.event);
        return updated.event;
      }
    }
    if (type === "answer.completed" && typeof safePayload?.text === "string") {
      const updated = this.store.updateAgentRun(
        { ...run, draftText: safePayload.text.slice(0, 100_000) },
        { ...safePayload, type },
      );
      if (updated.event) this.eventHub.publish(id, updated.event);
      return updated.event;
    }
    return this.eventHub.append(id, eventType, safePayload);
  }

  #transition(id, status, eventType) {
    const run = this.get(id);
    if (!run || !ACTIVE_STATES.has(run.status)) return run;
    const result = this.store.updateAgentRun(
      { ...run, status },
      { type: eventType, status },
    );
    if (result.event) this.eventHub.publish(id, result.event);
    return result.run;
  }

  #timeoutRun(id) {
    const run = this.get(id);
    if (!run || !ACTIVE_STATES.has(run.status)) return run;
    const artifact = artifactFrom(run, undefined, undefined, "partial");
    const finishedAt = this.now().toISOString();
    const result = this.store.finalizeAgentRun(
      {
        ...run,
        status: "partial",
        recoverable: true,
        failure: {
          type: "wall-clock-budget-exceeded",
          message: "The run reached its wall-clock budget.",
        },
        error: "The run reached its wall-clock budget.",
        artifactId: artifact?.id,
        completedAt: finishedAt,
      },
      artifact,
      {
        type: "run.partial",
        status: "partial",
        reason: "wall-clock-budget-exceeded",
        artifactId: artifact?.id,
      },
    );
    if (result.event) this.eventHub.publish(id, result.event);
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted)
      controller.abort("wall-clock budget exceeded");
    this.#clearDeadline(id);
    return result.run;
  }

  #budgetExceeded(id, counter, limit) {
    const run = this.get(id);
    if (!run || !ACTIVE_STATES.has(run.status)) return run;
    const artifact = artifactFrom(run, undefined, undefined, "partial");
    const reason = `${counter}-budget-exceeded`;
    const result = this.store.finalizeAgentRun(
      {
        ...run,
        status: "partial",
        recoverable: true,
        failure: {
          type: reason,
          message: `The run reached its ${counter} limit (${limit}).`,
        },
        error: `The run reached its ${counter} limit (${limit}).`,
        artifactId: artifact?.id,
        completedAt: this.now().toISOString(),
      },
      artifact,
      {
        type: "run.partial",
        status: "partial",
        reason,
        limit,
        artifactId: artifact?.id,
      },
    );
    if (result.event) this.eventHub.publish(id, result.event);
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    this.#clearDeadline(id);
    return result.event;
  }

  #failRun(id, error) {
    const run = this.get(id);
    if (!run || !ACTIVE_STATES.has(run.status)) return run;
    const details = errorDetails(error);
    const status = run.draftText?.trim() ? "partial" : "failed";
    const answer = run.draftText
      ? { text: run.draftText, origin: "ai", kind: "tutor", partial: true }
      : undefined;
    const artifact = artifactFrom(run, answer, undefined, status);
    const completedAt = this.now().toISOString();
    const result = this.store.finalizeAgentRun(
      {
        ...run,
        status,
        recoverable: status === "partial",
        failure: details,
        error: details,
        artifactId: artifact?.id,
        completedAt,
      },
      artifact,
      {
        type: status === "partial" ? "run.partial" : "run.failed",
        status,
        error: details,
        artifactId: artifact?.id,
      },
    );
    if (result.event) this.eventHub.publish(id, result.event);
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted)
      controller.abort(details.message);
    this.#clearDeadline(id);
    return result.run;
  }

  #clearDeadline(id) {
    const deadline = this.deadlines.get(id);
    if (deadline) clearTimeout(deadline);
    this.deadlines.delete(id);
  }

  #recoverInterruptedRuns() {
    for (const run of this.store.listAgentRuns()) {
      if (!ACTIVE_STATES.has(run.status)) continue;
      const recoveredAt = this.now().toISOString();
      const artifact = artifactFrom(run, undefined, undefined, "partial");
      const result = this.store.finalizeAgentRun(
        {
          ...run,
          status: "partial",
          recoverable: true,
          failure: {
            type: "process-restarted",
            message:
              "The process stopped before this run reached a terminal state.",
          },
          error:
            "The process stopped before this run reached a terminal state.",
          artifactId: artifact?.id,
          completedAt: recoveredAt,
        },
        artifact,
        {
          type: "run.partial",
          status: "partial",
          reason: "process-restarted",
          artifactId: artifact?.id,
        },
      );
      if (result.event) this.eventHub.publish(run.id, result.event);
    }
  }
}
