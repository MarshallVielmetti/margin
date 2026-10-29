import {
  jsonResponse,
  normalizedUsage,
  parseArguments,
  responseError,
  responseLines,
  throwIfAborted,
} from "./common.mjs";

export function localOpenAICompatibleEndpoint(
  value = "http://127.0.0.1:8080/v1",
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("llama.cpp must use an HTTP loopback endpoint.");
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "llama.cpp must use an HTTP loopback endpoint on this computer.",
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function completionsUrl(endpoint) {
  if (/\/v1\/chat\/completions$/i.test(endpoint)) return endpoint;
  if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
  return `${endpoint}/v1/chat/completions`;
}

function mapMessages(messages = []) {
  return messages.map((message) => {
    if (message.role === "tool")
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    const item = { role: message.role, content: message.content || "" };
    if (message.toolCalls?.length)
      item.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      }));
    return item;
  });
}

function mapTools(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema || {},
    },
  }));
}

function collectCalls(calls, deltas = []) {
  for (const [fallbackIndex, delta] of deltas.entries()) {
    const key = String(delta.index ?? fallbackIndex);
    const current = calls.get(key) || { id: "", name: "", rawArguments: "" };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    const args = delta.function?.arguments;
    if (typeof args === "string") current.rawArguments += args;
    else if (args !== undefined) current.rawArguments = args;
    calls.set(key, current);
  }
}

function resultToolCalls(calls, runId) {
  return [...calls.entries()].map(([index, call], position) => ({
    id: call.id || `${runId}-tool-${position + 1}-${index}`,
    name: call.name,
    arguments: parseArguments(call.rawArguments),
  }));
}

function parseSseLine(line) {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data);
}

export class LlamaCppProvider {
  constructor({
    endpoint = "http://127.0.0.1:8080/v1",
    fetchImpl = fetch,
  } = {}) {
    this.endpoint = localOpenAICompatibleEndpoint(endpoint);
    this.url = completionsUrl(this.endpoint);
    this.fetch = fetchImpl;
    this.id = "llama.cpp";
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
      const healthUrl = this.endpoint.replace(/\/v1$/i, "/health");
      const response = await this.fetch(healthUrl, { signal });
      return {
        reachable: !!response.ok,
        status: response.status,
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
      messages: mapMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: budgets.outputTokens || 1200,
    };
    if (actionEnvelope) {
      body.response_format = {
        type: "json_schema",
        // The locally parsed envelope rejects extra or missing fields. Keep
        // provider mode best-effort because the fallback schema uses a union.
        json_schema: {
          name: "margin_agent_action",
          strict: false,
          schema: actionEnvelope,
        },
      };
    } else if (tools.length) {
      body.tools = mapTools(tools);
      body.tool_choice = "auto";
    }
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await responseError(response, "llama.cpp");
    let text = "";
    let finishReason = "stop";
    let usage = {};
    const calls = new Map();
    const consume = async (record) => {
      const choice = record.choices?.[0] || {};
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        await onEvent?.({
          type: "text.delta",
          delta: delta.content,
          provider: this.id,
        });
      }
      collectCalls(calls, delta.tool_calls || []);
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (record.usage)
        usage = normalizedUsage(
          record.usage.prompt_tokens,
          record.usage.completion_tokens,
        );
    };

    if (jsonResponse(response)) {
      const record = await response.json();
      await consume(record);
    } else {
      for await (const line of responseLines(response, signal)) {
        throwIfAborted(signal);
        const record = parseSseLine(line);
        if (record) await consume(record);
      }
    }
    throwIfAborted(signal);
    return {
      text,
      toolCalls: resultToolCalls(calls, runId),
      finishReason,
      truncated: finishReason === "length",
      usage,
      streaming: !jsonResponse(response),
    };
  }
}

export function createLlamaCppProvider(options) {
  return new LlamaCppProvider(options);
}
