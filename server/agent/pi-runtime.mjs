import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  Type,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { buildInitialContext, compactTranscript } from "./context.mjs";
import { makeInstructions } from "./runtime.mjs";
import {
  AgentPolicyError,
  assertProviderScope,
  boundToolResult,
  parseToolArguments,
  resolveBudgets,
  selectRelevantTools,
  toJsonSchema,
  validateToolDefinitions,
} from "./policy.mjs";
import { makeProviderMap } from "./runtime.mjs";
import { throwIfAborted } from "../providers/common.mjs";

export const PI_RUNTIME_PINS = Object.freeze({
  agent: "@earendil-works/pi-agent-core@1.4.0",
  ai: "@earendil-works/pi-ai@1.4.0",
  node: ">=22.19.0",
});

export const PI_ADOPTION_CHECKS = Object.freeze([
  "searchReadAnswer",
  "streamingCancellation",
  "invalidCallRejected",
  "contextReload",
  "noOutboundTelemetry",
]);

export function evaluatePiAdoptionGate({
  checks = {},
  selectedEndpoint,
  evidenceEndpoint,
} = {}) {
  const endpointMatches =
    typeof selectedEndpoint === "string" &&
    selectedEndpoint.length > 0 &&
    selectedEndpoint === evidenceEndpoint;
  const missing = PI_ADOPTION_CHECKS.filter((name) => checks[name] !== true);
  return {
    passed: endpointMatches && missing.length === 0,
    endpointMatches,
    missing,
    evidenceEndpoint: evidenceEndpoint || null,
    selectedEndpoint: selectedEndpoint || null,
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("");
}

function toMarginMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.role === "system")
    return { role: "system", content: messageText(message.content) };
  if (message.role === "user")
    return { role: "user", content: messageText(message.content) };
  if (message.role === "assistant") {
    const text = messageText(message.content);
    const toolCalls = (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part?.type === "toolCall")
      .map((part) => ({
        id: part.id,
        name: part.name,
        arguments: part.argumentsError ? part.argumentsError : part.arguments,
      }));
    return {
      role: "assistant",
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      name: message.toolName,
      content: messageText(message.content),
      isError: !!message.isError,
      evidenceIds: Array.isArray(message.details?.margin?.evidenceIds)
        ? message.details.margin.evidenceIds
        : [],
    };
  }
  return null;
}

function usageForPi(usage = {}) {
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: Number(usage.totalTokens) || input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const PI_TOOL_RESULT_COUNTS = [
  "hits",
  "candidates",
  "results",
  "entries",
  "items",
  "headings",
  "links",
  "inquiries",
  "claims",
  "conceptOccurrences",
  "learningEvidence",
  "passages",
];

function summarizePiToolMetadata(result, evidenceIds, complete, errorCode) {
  if (errorCode) {
    return {
      status: "failed",
      code: String(errorCode).slice(0, 80),
      evidenceIds: [],
      truncated: !complete,
    };
  }
  const counts = {};
  for (const key of PI_TOOL_RESULT_COUNTS) {
    if (Array.isArray(result?.[key])) counts[key] = result[key].length;
  }
  return {
    status: String(
      result?.status || (complete ? "completed" : "truncated"),
    ).slice(0, 80),
    ...(result?.resultKind
      ? { resultKind: String(result.resultKind).slice(0, 80) }
      : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    evidenceIds: evidenceIds.slice(0, 20).map((id) => String(id).slice(0, 200)),
    truncated: !complete,
  };
}

function piProviderName(provider) {
  if (provider === "llama.cpp") return "openai";
  return provider;
}

function piModel(model, provider, endpoint, budgets) {
  return {
    id: model,
    name: model,
    api: "openai-completions",
    provider: piProviderName(provider),
    baseUrl: endpoint || "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: budgets.contextTokens,
    maxTokens: budgets.outputTokens,
  };
}

function normalizedAgentMessages(messages, fallbackSystemPrompt = "") {
  const transcript = Array.isArray(messages) ? messages : [];
  const systemPrompt =
    getCurrentSystemPrompt(transcript) || fallbackSystemPrompt;
  const rest = transcript
    .filter((message) => message?.role !== "system")
    .map(toMarginMessage)
    .filter(Boolean);
  return [{ role: "system", content: systemPrompt }, ...rest];
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = messageText(message.content).trim();
      if (text) return text;
    }
  }
  return "";
}

function makeAssistantMessage({
  provider,
  model,
  text = "",
  toolCalls = [],
  usage = {},
  finishReason,
  errorMessage,
}) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    const raw = call.arguments;
    const validObject = raw && typeof raw === "object" && !Array.isArray(raw);
    content.push({
      type: "toolCall",
      id: String(call.id || randomUUID()),
      name: String(call.name || ""),
      arguments: validObject ? raw : {},
      ...(!validObject
        ? {
            argumentsError: `Malformed JSON arguments: ${String(raw).slice(0, 300)}`,
          }
        : {}),
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: piProviderName(provider),
    model,
    timestamp: Date.now(),
    usage: usageForPi(usage),
    stopReason: errorMessage
      ? "error"
      : finishReason || (toolCalls.length ? "toolUse" : "stop"),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function makePiStreamFunction({
  adapter,
  provider,
  model,
  systemPrompt,
  tools,
  budgets,
  runId,
  onUsage,
  onModelCall,
  onModelStarted,
  onTruncated,
  shouldStop,
  signal,
}) {
  return async (_piModel, context, streamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    const combinedSignal =
      signal && streamOptions.signal
        ? AbortSignal.any([signal, streamOptions.signal])
        : signal || streamOptions.signal;
    try {
      throwIfAborted(combinedSignal);
      if (shouldStop?.()) {
        const message = makeAssistantMessage({
          provider,
          model,
          finishReason: "length",
          errorMessage: "The transcript exceeds the configured context budget.",
        });
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
        return stream;
      }
      if (!onModelCall()) {
        const message = makeAssistantMessage({
          provider,
          model,
          finishReason: "length",
          errorMessage: "The model-call budget is exhausted.",
        });
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
        return stream;
      }
      await onModelStarted?.();
      // The run harness can abort in response to model.started (for example,
      // when its independent budget counter reaches the configured limit).
      throwIfAborted(combinedSignal);
      const partial = makeAssistantMessage({ provider, model });
      stream.push({ type: "start", partial });
      let streamedText = "";
      let textBlock;
      const pushText = (delta) => {
        if (!delta) return;
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          partial.content.push(textBlock);
          stream.push({
            type: "text_start",
            contentIndex: partial.content.length - 1,
            partial,
          });
        }
        streamedText += delta;
        textBlock.text += delta;
        stream.push({
          type: "text_delta",
          contentIndex: partial.content.indexOf(textBlock),
          delta,
          partial,
        });
      };
      const marginMessages = normalizedAgentMessages(
        context.messages,
        context.systemPrompt || systemPrompt,
      );
      const result = await adapter.generate({
        model,
        messages: marginMessages,
        tools: tools.map(({ name, description, jsonSchema }) => ({
          name,
          description,
          jsonSchema,
        })),
        signal: combinedSignal,
        budgets,
        runId,
        onEvent: async (event) => {
          if (event?.type === "text.delta") pushText(String(event.delta || ""));
        },
      });
      throwIfAborted(combinedSignal);
      onUsage(result.usage);
      onTruncated(!!result.truncated);
      const finalText = result.text || "";
      if (!streamedText) pushText(finalText);
      else if (finalText.startsWith(streamedText))
        pushText(finalText.slice(streamedText.length));
      else if (streamedText !== finalText) {
        textBlock.text = finalText;
        streamedText = finalText;
      }
      if (textBlock)
        stream.push({
          type: "text_end",
          contentIndex: partial.content.indexOf(textBlock),
          content: textBlock.text,
          partial,
        });
      const assistant = makeAssistantMessage({
        provider,
        model,
        text: finalText,
        toolCalls: result.toolCalls || [],
        usage: result.usage,
        finishReason: result.truncated ? "length" : undefined,
      });
      for (const part of assistant.content) {
        if (part.type === "toolCall") {
          const contentIndex = partial.content.length;
          stream.push({ type: "toolcall_start", contentIndex, partial });
          partial.content.push(part);
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: part,
            partial,
          });
        }
      }
      Object.assign(partial, assistant);
      stream.push({
        type: "done",
        reason: assistant.stopReason,
        message: assistant,
      });
      stream.end(assistant);
    } catch (error) {
      const aborted = combinedSignal?.aborted || error?.name === "AbortError";
      const message = makeAssistantMessage({
        provider,
        model,
        finishReason: aborted ? "aborted" : "error",
        errorMessage: String(error?.message || error).slice(0, 400),
      });
      stream.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: message,
      });
      stream.end(message);
    }
    return stream;
  };
}

export function createEmbeddedPiRuntimeCandidate(options = {}) {
  const defaultProvider = options.provider || "ollama";
  const defaultModel = options.model || "";
  const forcedLocalOnly = options.localOnly === true;
  const providers = options.providers || makeProviderMap(options);

  async function run(input = {}) {
    if (typeof input.question !== "string" || !input.question.trim())
      throw new AgentPolicyError(
        "A non-empty research question is required.",
        "question_required",
      );
    const providerName = String(
      input.selection?.provider || defaultProvider,
    ).toLowerCase();
    const explicitlyCloudSelected =
      input.selection?.cloud === true || input.selection?.localOnly === false;
    const localOnly =
      forcedLocalOnly ||
      input.selection?.localOnly === true ||
      (providerName !== "openai" && !explicitlyCloudSelected);
    const provider = assertProviderScope(providerName, localOnly);
    if (input.selection?.toolMode === "action-envelope")
      throw new AgentPolicyError(
        "The Pi candidate requires a selected endpoint that passed the native-tool gate.",
        "pi_tool_mode_unavailable",
      );
    const adapter = providers.get(provider);
    if (!adapter)
      throw new AgentPolicyError(`Provider ${provider} is not configured.`);
    const model = String(input.selection?.model || defaultModel || "");
    if (!model)
      throw new AgentPolicyError(
        "A provider model must be selected for each run.",
        "model_required",
      );
    const budgets = resolveBudgets(input.budgets);
    const mode = String(input.mode || "discuss");
    const registry = validateToolDefinitions(input.tools || [], budgets);
    const selectedTools = selectRelevantTools(registry, {
      question: input.question,
      mode,
      requestedNames: input.selection?.toolNames,
      maxTools: budgets.maxTools,
    });
    const schemas = new Map();
    const providerTools = [...selectedTools.values()].map((tool) => {
      const jsonSchema = toJsonSchema(tool.schema);
      if (!jsonSchema || jsonSchema.type !== "object")
        throw new AgentPolicyError(
          `Tool ${tool.name} has a schema that cannot be sent safely to a provider.`,
        );
      schemas.set(tool.name, jsonSchema);
      return { name: tool.name, description: tool.description, jsonSchema };
    });
    const systemPrompt = makeInstructions(mode);
    const initial = buildInitialContext({
      question: input.question,
      mode,
      source: input.source,
      anchor: input.anchor,
      history: input.history,
      researchQuestion: input.researchQuestion,
      evidence: input.evidence,
      selection: { ...input.selection, provider, model },
      systemPrompt,
      toolSchemas: providerTools.map((tool) => tool.jsonSchema),
      budgets,
    });
    const runId = String(input.runId || randomUUID());
    const timeoutSignal = AbortSignal.timeout(budgets.maxSeconds * 1000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    const usage = {};
    let modelCalls = 0;
    let toolCalls = 0;
    let invalidCalls = 0;
    let budgetStopped = false;
    let providerTruncated = false;
    let overflow = false;
    let estimatedContextTokens = initial.estimatedInputTokens;
    let lastContext = [];
    const evidenceById = new Map(
      initial.inventory.map((item) => [
        item.id,
        {
          ...item,
          ...(initial.payload.evidence.find(
            (candidate) => candidate.id === item.id,
          )?.text
            ? {
                text: initial.payload.evidence.find(
                  (candidate) => candidate.id === item.id,
                ).text,
              }
            : {}),
        },
      ]),
    );
    const seenToolCalls = new Set();
    const startedAt = Date.now();
    const onEvent = async (event) => {
      try {
        await input.onEvent?.({ ...event, runId });
      } catch {
        /* observers cannot break the agent */
      }
    };

    const agentTools = [...selectedTools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      label: tool.name,
      parameters: Type.Unsafe(schemas.get(tool.name)),
      prepareArguments(args) {
        try {
          return parseToolArguments(tool, args);
        } catch (error) {
          invalidCalls += 1;
          throw error;
        }
      },
      async execute(toolCallId, args, toolSignal) {
        const toolStartedAt = Date.now();
        try {
          throwIfAborted(toolSignal || signal);
          const fingerprint = JSON.stringify({ name: tool.name, args });
          if (seenToolCalls.has(fingerprint))
            throw new AgentPolicyError(
              "Duplicate tool call blocked to prevent repeated reads.",
              "duplicate_tool_call",
            );
          seenToolCalls.add(fingerprint);
          toolCalls += 1;
          if (toolCalls > budgets.maxToolCalls) {
            toolCalls -= 1;
            throw new AgentPolicyError(
              "Tool-call budget exhausted.",
              "tool_budget_exhausted",
            );
          }
          const value = await tool.execute(args, {
            signal: toolSignal || signal,
            toolCallId,
            runId,
          });
          throwIfAborted(toolSignal || signal);
          const body = boundToolResult(
            { ok: true, result: value },
            budgets.toolResultBytes,
          );
          let complete = false;
          try {
            complete = JSON.parse(body)?.truncated !== true;
          } catch {}
          const evidenceIds = [];
          if (Array.isArray(value?.evidence)) {
            for (const item of value.evidence) {
              if (!item?.id) continue;
              const id = String(item.id);
              const text =
                typeof item.text === "string" ? item.text : undefined;
              if (!evidenceById.has(id))
                evidenceById.set(id, {
                  id,
                  title: String(item.title || "Untitled evidence"),
                  kind: String(item.kind || "unknown"),
                  locator: item.locator || {},
                  status: "available",
                  loadedInPrompt: false,
                  ...(text ? { text } : {}),
                });
              if (complete && text && body.includes(JSON.stringify(text)))
                evidenceIds.push(id);
            }
          }
          return {
            content: [{ type: "text", text: body }],
            details: {
              margin: {
                evidenceIds,
                metadata: summarizePiToolMetadata(value, evidenceIds, complete),
                durationMs: Math.max(0, Date.now() - toolStartedAt),
              },
            },
            isError: false,
          };
        } catch (error) {
          if (signal.aborted) throw error;
          if (
            ["invalid_tool_arguments", "duplicate_tool_call"].includes(
              error?.code,
            )
          )
            invalidCalls += 1;
          const body = boundToolResult(
            {
              error: String(error?.message || error).slice(0, 600),
              code: error?.code || "tool_failed",
            },
            budgets.toolResultBytes,
          );
          return {
            content: [{ type: "text", text: body }],
            details: {
              margin: {
                evidenceIds: [],
                metadata: summarizePiToolMetadata(
                  undefined,
                  [],
                  true,
                  error?.code || "tool_failed",
                ),
                durationMs: Math.max(0, Date.now() - toolStartedAt),
              },
            },
            isError: true,
          };
        }
      },
    }));

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: piModel(model, provider, adapter.endpoint, budgets),
        thinkingLevel: "off",
        tools: agentTools,
      },
      toolExecution: "sequential",
      transformContext: async (messages) => {
        const systemText = getCurrentSystemPrompt(messages) || systemPrompt;
        const originalSystem = messages.find(
          (message) => message?.role === "system",
        );
        const piSystem = originalSystem
          ? { ...originalSystem, content: systemText }
          : { role: "system", content: systemText, timestamp: Date.now() };
        const mapped = [
          {
            original: piSystem,
            margin: { role: "system", content: systemText },
          },
          ...messages
            .filter((message) => message?.role !== "system")
            .map((message) => ({
              original: message,
              margin: toMarginMessage(message),
            }))
            .filter((item) => item.margin),
        ];
        const compacted = compactTranscript(
          mapped.map((item) => item.margin),
          {
            maxTokens: budgets.contextTokens,
            toolSchemas: providerTools.map((tool) => tool.jsonSchema),
            outputTokens: budgets.outputTokens,
          },
        );
        overflow ||= compacted.overflow;
        estimatedContextTokens = Math.max(
          estimatedContextTokens,
          compacted.estimatedTokens,
        );
        lastContext = compacted.messages;
        const originalByMargin = new Map(
          mapped.map((item) => [item.margin, item.original]),
        );
        return compacted.messages
          .map((message) => originalByMargin.get(message))
          .filter(Boolean);
      },
      streamFn: makePiStreamFunction({
        adapter,
        provider,
        model,
        tools: providerTools,
        budgets,
        runId,
        systemPrompt,
        signal,
        shouldStop: () => overflow,
        onModelCall: () => {
          modelCalls += 1;
          if (modelCalls > budgets.maxModelCalls) {
            modelCalls -= 1;
            budgetStopped = true;
            return false;
          }
          return true;
        },
        onModelStarted: () =>
          onEvent({
            type: "model.started",
            provider,
            model,
            modelCall: modelCalls,
          }),
        onTruncated: (value) => {
          providerTruncated ||= value;
        },
        onUsage(next) {
          for (const [target, key] of [
            ["inputTokens", "inputTokens"],
            ["outputTokens", "outputTokens"],
            ["totalTokens", "totalTokens"],
          ]) {
            if (Number.isFinite(Number(next?.[key])))
              usage[target] = (usage[target] || 0) + Number(next[key]);
          }
        },
      }),
      finishTurn: (turn) => {
        const hasToolCall = turn.message?.content?.some(
          (part) => part.type === "toolCall",
        );
        if (!hasToolCall) return { action: "end" };
        if (
          invalidCalls > budgets.maxInvalidCalls ||
          toolCalls >= budgets.maxToolCalls ||
          modelCalls >= budgets.maxModelCalls
        ) {
          budgetStopped = true;
          return { action: "end" };
        }
        return { action: "continue" };
      },
    });
    const abortAgent = () => agent.abort();
    signal.addEventListener("abort", abortAgent, { once: true });
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "agent_start")
        await onEvent({ type: "runtime.started", provider, model, mode });
      else if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      )
        await onEvent({
          type: "answer.delta",
          delta: event.assistantMessageEvent.delta,
        });
      else if (event.type === "tool_execution_start")
        await onEvent({
          type: "tool.started",
          toolCallId: event.toolCallId,
          name: event.toolName,
          arguments: event.args,
        });
      else if (event.type === "tool_execution_end")
        await onEvent({
          type: "tool.completed",
          toolCallId: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          result: event.result?.details?.margin?.metadata || {
            status: event.isError ? "failed" : "completed",
            evidenceIds: [],
          },
          durationMs:
            event.durationMs ?? event.result?.details?.margin?.durationMs ?? 0,
        });
    });

    try {
      throwIfAborted(signal);
      await agent.prompt(initial.prompt);
      if (input.signal?.aborted)
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new DOMException("The operation was aborted.", "AbortError");
    } catch (error) {
      if (!input.signal?.aborted && !signal.aborted) throw error;
      if (input.signal?.aborted) {
        await onEvent({ type: "runtime.cancelled", reason: "cancelled" });
        throw error;
      }
    } finally {
      signal.removeEventListener("abort", abortAgent);
      unsubscribe();
      agent.clearAllQueues();
    }
    const messages = normalizedAgentMessages(agent.state.messages);
    const loadedEvidenceIds = new Set();
    if (modelCalls > 0) {
      for (const item of initial.payload.evidence)
        loadedEvidenceIds.add(String(item.id));
      for (const message of lastContext) {
        if (message.role === "tool")
          for (const id of message.evidenceIds || [])
            loadedEvidenceIds.add(String(id));
      }
    }
    for (const [id, item] of evidenceById) {
      const loaded = loadedEvidenceIds.has(id);
      item.loadedInPrompt = loaded;
      if (loaded) item.status = "loaded";
      else if (item.status === "loaded") item.status = "available";
    }
    let text = finalAssistantText(agent.state.messages);
    const budgetPartial =
      overflow ||
      budgetStopped ||
      providerTruncated ||
      signal.aborted ||
      invalidCalls > budgets.maxInvalidCalls ||
      (toolCalls >= budgets.maxToolCalls && !text) ||
      !text;
    if (!text || budgetPartial) {
      text =
        text ||
        "I reached the run budget before producing a complete answer. The loaded evidence and completed tool results remain available for a continuation.";
    }
    usage.modelCalls = modelCalls;
    usage.toolCalls = toolCalls;
    usage.invalidCalls = invalidCalls;
    usage.contextEstimateTokens = estimatedContextTokens;
    usage.durationMs = Date.now() - startedAt;
    usage.estimation =
      "conservative UTF-8 bytes divided by 3; tool/schema overhead included";
    await onEvent({
      type: budgetPartial ? "runtime.partial" : "runtime.completed",
      reason: budgetPartial ? "budget_or_truncation" : "completed",
    });
    return {
      text,
      evidence: [...evidenceById.values()],
      loadedEvidenceIds: [...loadedEvidenceIds],
      usage,
      transcript: { version: 1, messages },
      capabilities: {
        runtime: "pi-agent-candidate",
        provider,
        model,
        endpoint: adapter.endpoint || adapter.url || null,
        localOnly,
        adapter: { ...adapter.capabilities, localOnly },
        liveEndpointTested: false,
        selectedModelTested: false,
        toolLoopTested: false,
        adoptionGatePassed: false,
      },
      truncated: !!budgetPartial,
      runId,
    };
  }

  return {
    runtime: "pi-agent-candidate",
    run,
    probeCapabilities: async ({ provider = defaultProvider, signal } = {}) => {
      const normalized = assertProviderScope(provider, forcedLocalOnly);
      const adapter = providers.get(normalized);
      if (!adapter)
        throw new AgentPolicyError(`Provider ${normalized} is not configured.`);
      return {
        provider: normalized,
        endpoint: adapter.endpoint || adapter.url || null,
        adapterCapabilities: adapter.capabilities,
        endpointProbe: await adapter.probe(signal),
        agentToolLoopTested: false,
        selectedModelTested: false,
        adoptionGatePassed: false,
      };
    },
  };
}

/**
 * Keep the embedded Agent candidate behind evidence for the exact selected
 * endpoint. The fallback remains the active runtime unless every gate check is
 * true and a candidate runtime was explicitly supplied.
 */
export function createPiRuntime({
  fallbackRuntime,
  gateEvidence = {},
  selectedEndpoint,
  candidateRuntime,
  candidateOptions,
} = {}) {
  const gate = evaluatePiAdoptionGate({
    checks: gateEvidence.checks,
    selectedEndpoint,
    evidenceEndpoint: gateEvidence.endpoint,
  });
  const candidate =
    candidateRuntime ||
    (gate.passed && candidateOptions
      ? createEmbeddedPiRuntimeCandidate(candidateOptions)
      : null);
  const activeRuntime =
    gate.passed && candidate ? "pi-agent" : "bounded-transport";
  const runtime = activeRuntime === "pi-agent" ? candidate : fallbackRuntime;
  if (!runtime)
    throw new AgentPolicyError(
      "A fallback runtime is required while the Pi adoption gate is closed.",
    );
  return {
    runtime: activeRuntime,
    gate,
    run: runtime.run.bind(runtime),
    probeCapabilities: runtime.probeCapabilities?.bind(runtime),
    probeSelectedModel: runtime.probeSelectedModel?.bind(runtime),
  };
}

export { makeAssistantMessage };
