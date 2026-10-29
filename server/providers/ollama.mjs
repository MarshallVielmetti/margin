import { localEndpoint } from "../ollama.mjs";
import {
  jsonResponse,
  normalizedUsage,
  parseArguments,
  responseError,
  responseLines,
  throwIfAborted,
} from "./common.mjs";

function ollamaMessages(messages = []) {
  return messages.map((message) => {
    if (message.role === "tool")
      return {
        role: "tool",
        tool_name: message.name,
        content: message.content,
      };
    const normalized = { role: message.role, content: message.content || "" };
    if (message.toolCalls?.length) {
      normalized.tool_calls = message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return normalized;
  });
}

function ollamaTools(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema || {},
    },
  }));
}

function collectToolCalls(callMap, calls = []) {
  calls.forEach((call, index) => {
    const fn = call.function || call;
    const id = String(call.id || call.index || index);
    const existing = callMap.get(id) || {
      id: call.id,
      name: "",
      rawArguments: "",
    };
    if (fn.name) existing.name = fn.name;
    if (typeof fn.arguments === "string") existing.rawArguments += fn.arguments;
    else if (fn.arguments !== undefined) existing.rawArguments = fn.arguments;
    callMap.set(id, existing);
  });
}

function finalizeToolCalls(callMap, runId) {
  return [...callMap.values()].map((call, index) => ({
    id: call.id || `${runId}-tool-${index + 1}`,
    name: call.name,
    arguments: parseArguments(call.rawArguments),
  }));
}

export class OllamaAgentProvider {
  constructor({
    endpoint = "http://127.0.0.1:11434",
    fetchImpl = fetch,
    timeoutMs = 180_000,
  } = {}) {
    this.endpoint = localEndpoint(endpoint);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.id = "ollama";
    this.capabilities = Object.freeze({
      streaming: "supported-by-adapter",
      tools: "requires-endpoint-and-model-probe",
      structuredOutput: "requires-endpoint-and-model-probe",
      liveTested: false,
      localOnly: true,
    });
  }

  async probe(signal) {
    try {
      const response = await this.fetch(`${this.endpoint}/api/version`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok)
        return { reachable: false, status: response.status, liveTested: false };
      const body = await response.json().catch(() => ({}));
      return {
        reachable: true,
        version: body.version || null,
        toolsTested: false,
        streamingTested: false,
        liveTested: false,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        reachable: false,
        reason: String(error?.message || error),
        liveTested: false,
      };
    }
  }

  async generate({
    model,
    messages,
    tools = [],
    actionEnvelope,
    signal,
    budgets = {},
    onEvent,
    runId,
  }) {
    throwIfAborted(signal);
    const body = {
      model,
      messages: ollamaMessages(messages),
      stream: true,
      think: false,
      keep_alive: "5m",
      options: {
        temperature: 0.2,
        num_ctx: budgets.contextTokens || 8192,
        num_predict: budgets.outputTokens || 1200,
      },
    };
    if (actionEnvelope) body.format = actionEnvelope;
    else if (tools.length) body.tools = ollamaTools(tools);
    const response = await this.fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson, application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await responseError(response, "Ollama");
    let text = "";
    let doneReason = "stop";
    let usage = {};
    const toolCallMap = new Map();
    const consume = async (record) => {
      if (record.error)
        throw new Error(`Ollama: ${String(record.error).slice(0, 300)}`);
      const content = record.message?.content || "";
      if (content) {
        text += content;
        await onEvent?.({
          type: "text.delta",
          delta: content,
          provider: this.id,
        });
      }
      collectToolCalls(toolCallMap, record.message?.tool_calls || []);
      if (record.done_reason || record.done)
        doneReason = record.done_reason || (record.done ? "stop" : doneReason);
      usage = {
        ...normalizedUsage(record.prompt_eval_count, record.eval_count),
      };
    };

    if (jsonResponse(response)) {
      const record = await response.json();
      await consume(record);
    } else {
      for await (const line of responseLines(response, signal)) {
        throwIfAborted(signal);
        await consume(JSON.parse(line));
      }
    }
    throwIfAborted(signal);
    return {
      text,
      toolCalls: finalizeToolCalls(toolCallMap, runId),
      finishReason: doneReason,
      truncated: doneReason === "length",
      usage,
      streaming: !jsonResponse(response),
    };
  }
}

export function createOllamaProvider(options) {
  return new OllamaAgentProvider(options);
}
