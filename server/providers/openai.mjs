import { createHash } from "node:crypto";
import { normalizedUsage, responseError, throwIfAborted } from "./common.mjs";

function wireToolName(name) {
  // Margin names are meaningful to the application (for example vault.search),
  // while provider function names use a narrower namespace. A stable opaque
  // alias keeps the application name out of the wire contract and avoids
  // collisions between punctuation-normalized names.
  return `m_${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;
}

function toResponseInput(messages = [], wireNames = new Map()) {
  const instructions =
    messages.find((message) => message.role === "system")?.content || "";
  const input = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content)
        input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls)
        input.push({
          type: "function_call",
          call_id: call.id,
          name: wireNames.get(call.name) || call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      continue;
    }
    input.push({ role: message.role, content: message.content || "" });
  }
  return { instructions, input };
}

function responseTools(tools = [], wireNames = new Map()) {
  return tools.map((tool) => ({
    type: "function",
    name: wireNames.get(tool.name) || tool.name,
    description: tool.description,
    parameters: tool.jsonSchema || {},
    // Zod schemas may contain optional properties. Margin validates the full
    // schema immediately before execution, so provider-side best-effort mode
    // is safer than claiming strict mode for an incompatible schema.
    strict: false,
  }));
}

function readOutput(result, namesByWire = new Map()) {
  const output = result.output || [];
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n");
  const toolCalls = output
    .filter((item) => item.type === "function_call")
    .map((item, index) => {
      let args = item.arguments || "{}";
      try {
        args = JSON.parse(args);
      } catch {
        // Preserve the malformed value so the shared tool policy can reject it.
      }
      return {
        id: item.call_id || `openai-tool-${index + 1}`,
        name: namesByWire.get(item.name) || item.name,
        arguments: args,
      };
    });
  return { text, toolCalls };
}

export class OpenAIResponsesProvider {
  constructor({ apiKey, fetchImpl = fetch }) {
    if (!apiKey)
      throw new Error(
        "OpenAI requires an explicitly selected account API key.",
      );
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.id = "openai";
    this.capabilities = Object.freeze({
      streaming: false,
      tools: "provider-supported",
      structuredOutput: "provider-supported",
      liveTested: false,
      localOnly: false,
    });
  }

  async probe(signal) {
    return {
      reachable: null,
      toolsTested: false,
      streamingTested: false,
      liveTested: false,
      reason: "No probe request is sent until an explicit cloud run.",
    };
  }

  async generate({
    model,
    messages,
    tools = [],
    actionEnvelope,
    signal,
    budgets = {},
    onEvent,
  }) {
    throwIfAborted(signal);
    const wireNames = new Map(
      tools.map((tool) => [tool.name, wireToolName(tool.name)]),
    );
    const namesByWire = new Map(
      [...wireNames].map(([name, wire]) => [wire, name]),
    );
    const { instructions, input } = toResponseInput(messages, wireNames);
    const body = {
      model,
      store: false,
      instructions,
      max_output_tokens: budgets.outputTokens || 1200,
      input,
    };
    if (actionEnvelope) {
      body.text = {
        format: {
          type: "json_schema",
          name: "margin_agent_action",
          strict: false,
          schema: actionEnvelope,
        },
      };
    } else if (tools.length) body.tools = responseTools(tools, wireNames);
    const response = await this.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await responseError(response, "OpenAI Responses");
    const result = await response.json();
    throwIfAborted(signal);
    const { text, toolCalls } = readOutput(result, namesByWire);
    if (text)
      await onEvent?.({ type: "text.delta", delta: text, provider: this.id });
    return {
      text,
      toolCalls,
      finishReason: result.status === "incomplete" ? "length" : "stop",
      truncated:
        result.status === "incomplete" ||
        result.incomplete_details?.reason === "max_output_tokens",
      usage: normalizedUsage(
        result.usage?.input_tokens,
        result.usage?.output_tokens,
      ),
      streaming: false,
    };
  }
}

export function createOpenAIProvider(options) {
  return new OpenAIResponsesProvider(options);
}
