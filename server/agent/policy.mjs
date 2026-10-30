import { z } from "zod";

const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const FORBIDDEN_TOOL_NAME =
  /(?:^|[._-])(shell|bash|exec|terminal|filesystem|file|write|edit|delete|remove|patch|process|command)(?:$|[._-])/i;

export const DEFAULT_AGENT_BUDGETS = Object.freeze({
  maxModelCalls: 3,
  maxToolCalls: 20,
  maxInvalidCalls: 1,
  maxSeconds: 300,
  contextTokens: 8192,
  outputTokens: 1200,
  toolResultBytes: 12_000,
  maxTools: 16,
});

const HARD_LIMITS = Object.freeze({
  maxModelCalls: 8,
  maxToolCalls: 20,
  maxInvalidCalls: 1,
  maxSeconds: 300,
  contextTokens: 32_768,
  outputTokens: 4096,
  toolResultBytes: 32_000,
  maxTools: 24,
});

export class AgentPolicyError extends Error {
  constructor(message, code = "policy_rejected") {
    super(message);
    this.name = "AgentPolicyError";
    this.code = code;
  }
}

export function resolveBudgets(overrides = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_AGENT_BUDGETS)) {
    const value = Number(overrides?.[key]);
    result[key] = Number.isFinite(value)
      ? Math.max(1, Math.min(HARD_LIMITS[key], Math.floor(value)))
      : fallback;
  }
  result.contextTokens = Math.max(512, result.contextTokens);
  result.outputTokens = Math.min(
    result.outputTokens,
    result.contextTokens - 256,
  );
  return Object.freeze(result);
}

export function assertProviderScope(provider, localOnly = true) {
  const normalized = String(provider || "").toLowerCase();
  if (!["ollama", "llama.cpp", "openai"].includes(normalized))
    throw new AgentPolicyError(
      `Unsupported provider: ${normalized || "(empty)"}.`,
    );
  if (localOnly && normalized === "openai")
    throw new AgentPolicyError(
      "OpenAI requires an explicit cloud selection; local-only runs cannot use it.",
      "provider_scope_denied",
    );
  return normalized;
}

export function validateToolDefinitions(
  tools = [],
  budgets = DEFAULT_AGENT_BUDGETS,
) {
  if (!Array.isArray(tools))
    throw new AgentPolicyError("Tools must be an array.");
  if (tools.length > HARD_LIMITS.maxTools)
    throw new AgentPolicyError(
      `At most ${HARD_LIMITS.maxTools} registered tools may be considered.`,
    );
  const byName = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object")
      throw new AgentPolicyError("Each tool must be an object.");
    const name = String(tool.name || "");
    if (!TOOL_NAME.test(name))
      throw new AgentPolicyError(`Invalid tool name: ${name || "(empty)"}.`);
    if (FORBIDDEN_TOOL_NAME.test(name))
      throw new AgentPolicyError(
        `Tool ${name} is outside the research read-only policy.`,
      );
    if (byName.has(name))
      throw new AgentPolicyError(`Duplicate tool name: ${name}.`);
    if (typeof tool.description !== "string" || tool.description.length > 1200)
      throw new AgentPolicyError(`Tool ${name} needs a short description.`);
    if (!tool.schema || typeof tool.schema.safeParse !== "function")
      throw new AgentPolicyError(`Tool ${name} needs a Zod schema.`);
    if (typeof tool.execute !== "function")
      throw new AgentPolicyError(`Tool ${name} needs an execute function.`);
    byName.set(name, tool);
  }
  return byName;
}

export function selectRelevantTools(
  tools,
  {
    question = "",
    mode = "discuss",
    requestedNames,
    maxTools = DEFAULT_AGENT_BUDGETS.maxTools,
  } = {},
) {
  if (!(tools instanceof Map))
    throw new TypeError("Tool selection requires a validated tool map.");
  if (Array.isArray(requestedNames) && requestedNames.length) {
    const selected = new Map();
    for (const name of requestedNames) {
      const tool = tools.get(name);
      if (!tool)
        throw new AgentPolicyError(`Requested tool ${name} is not registered.`);
      selected.set(name, tool);
    }
    if (selected.size > maxTools)
      throw new AgentPolicyError(
        `The selected tool subset exceeds the ${maxTools}-tool limit.`,
      );
    return selected;
  }

  const text = `${question} ${mode}`.toLocaleLowerCase();
  const referenceTask =
    /\b(citation|citations|reference|references|bibliograph|doi|citekey)\b|\[\s*\d{1,3}\s*\]/u.test(
      text,
    );
  const historyTask =
    /\b(previous|previously|history|earlier|resume|resum|last session|what did we|my prior|our prior)\b/u.test(
      text,
    );
  const graphTask =
    mode === "connect" ||
    /\b(link|links|graph|related|connection|connections|outline|structure)\b/u.test(
      text,
    );
  const proposalTask =
    mode === "edit" ||
    /\b(propose|proposal|draft|save|add to note|update note)\b/u.test(text);
  const desired = [
    "source.search",
    "source.read",
    "vault.search",
    "vault.read",
    "vault.resolve_link",
    "workspace.get_context",
    "knowledge.search",
    "knowledge.load",
    "knowledge.connections",
    "knowledge.children",
  ];
  if (referenceTask)
    desired.push(
      "source.outline",
      "source.references",
      "library.search",
      "library.get_item",
      "reference.resolve",
    );
  if (graphTask) desired.push("source.outline", "vault.outline", "vault.links");
  if (historyTask)
    desired.push("history.search", "history.read", "research.get_state");
  if (proposalTask)
    desired.push("proposal.create", "history.search", "history.read");

  const selected = new Map();
  for (const name of desired) {
    if (tools.has(name) && !selected.has(name))
      selected.set(name, tools.get(name));
    if (selected.size >= maxTools) break;
  }
  if (!selected.size) {
    // Preserve applications with a smaller custom read-only tool vocabulary.
    for (const [name, tool] of tools) {
      selected.set(name, tool);
      if (selected.size >= maxTools) break;
    }
  }
  return selected;
}

export function parseToolArguments(tool, rawArguments) {
  let value = rawArguments;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AgentPolicyError(
        `Arguments for ${tool.name} were not valid JSON.`,
        "invalid_tool_arguments",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AgentPolicyError(
      `Arguments for ${tool.name} must be an object.`,
      "invalid_tool_arguments",
    );
  const parsed = tool.schema.safeParse(value);
  if (!parsed.success)
    throw new AgentPolicyError(
      `Arguments for ${tool.name} failed schema validation: ${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
      "invalid_tool_arguments",
    );
  return parsed.data;
}

export function toJsonSchema(schema) {
  try {
    // Zod refinements cannot be represented in JSON Schema. They remain
    // enforced by safeParse immediately before execution.
    return z.toJSONSchema(schema, {
      target: "draft-7",
      unrepresentable: "any",
    });
  } catch {
    return undefined;
  }
}

export function boundToolResult(
  result,
  maxBytes = DEFAULT_AGENT_BUDGETS.toolResultBytes,
) {
  let serialized;
  try {
    serialized = JSON.stringify(result === undefined ? null : result);
  } catch {
    serialized = JSON.stringify({
      error: "Tool result could not be serialized.",
    });
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  const summary = JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, Math.max(0, maxBytes - 160)),
    originalBytes: Buffer.byteLength(serialized, "utf8"),
  });
  return summary;
}
