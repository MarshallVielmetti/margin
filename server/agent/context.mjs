const UTF8_BYTES_PER_TOKEN = 3;
const DEFAULT_SAFETY_FRACTION = 0.15;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(text, "utf8") / UTF8_BYTES_PER_TOKEN),
  );
}

export function estimateMessageTokens(messages, toolSchemas = []) {
  return estimateTokens({ messages, toolSchemas });
}

function cleanSource(source = {}) {
  const allowed = [
    "id",
    "title",
    "kind",
    "authors",
    "year",
    "citekey",
    "notePath",
    "path",
    "revision",
    "fingerprint",
    "doi",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => source?.[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function normalizeEvidence(items = []) {
  if (!Array.isArray(items)) return { inventory: [], loaded: [] };
  const inventory = [];
  const loaded = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || `evidence-${index + 1}`);
    const text = item.text ?? item.excerpt ?? item.content;
    const hasText = typeof text === "string" && item.loaded !== false;
    const metadata = {
      id,
      title: String(item.title || item.name || "Untitled evidence"),
      kind: String(item.kind || "unknown"),
      locator: item.locator ?? {
        ...(item.page !== undefined ? { page: item.page } : {}),
        ...(item.section !== undefined ? { section: item.section } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
      },
      status: hasText ? "loaded" : String(item.status || "available"),
      loadedInPrompt: hasText,
      pinned: !!item.pinned,
      priority: Number.isFinite(Number(item.priority))
        ? Number(item.priority)
        : 0,
    };
    inventory.push(metadata);
    if (hasText) {
      loaded.push({
        ...metadata,
        text,
        ...(item.provenance ? { provenance: item.provenance } : {}),
      });
    }
  }
  return { inventory, loaded };
}

function compactPayload(payload, systemPrompt, toolSchemas, budgets) {
  const safety = Math.ceil(budgets.contextTokens * DEFAULT_SAFETY_FRACTION);
  const usable = budgets.contextTokens - budgets.outputTokens - safety;
  const fixed = {
    question: payload.question,
    mode: payload.mode,
    source: payload.source,
    anchor: payload.anchor,
    selection: payload.selection,
    researchQuestion: payload.researchQuestion,
    evidenceInventory: payload.evidenceInventory.slice(0, 100),
    omissions: [],
    history: [],
    evidence: [],
  };
  const fixedCost =
    estimateTokens(systemPrompt) +
    estimateTokens(fixed) +
    estimateTokens(toolSchemas);
  if (fixedCost > usable)
    throw new Error(
      `Pinned prompt context needs about ${fixedCost} tokens, above the ${usable}-token input budget.`,
    );

  let remaining = usable - fixedCost;
  const history = [...payload.history].reverse();
  for (const entry of history) {
    const cost = estimateTokens(entry);
    if (cost <= remaining) {
      fixed.history.unshift(entry);
      remaining -= cost;
    } else {
      fixed.omissions.push({
        kind: "history",
        reason: "input-budget",
        id: entry.id,
      });
    }
  }

  const evidence = [...payload.evidence].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority,
  );
  for (const entry of evidence) {
    const cost = estimateTokens(entry);
    if (cost <= remaining) {
      fixed.evidence.push(entry);
      remaining -= cost;
    } else {
      fixed.omissions.push({
        kind: "evidence",
        reason: "input-budget",
        id: entry.id,
      });
    }
  }
  fixed.evidence.sort(
    (a, b) =>
      payload.evidence.findIndex((item) => item.id === a.id) -
      payload.evidence.findIndex((item) => item.id === b.id),
  );
  const prompt = JSON.stringify(fixed);
  const estimatedInputTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(prompt) +
    estimateTokens(toolSchemas);
  if (estimatedInputTokens > usable)
    throw new Error(
      "The context estimator could not fit the pinned task data within the configured budget.",
    );
  return {
    prompt,
    payload: fixed,
    estimatedInputTokens,
    usableInputTokens: usable,
  };
}

export function buildInitialContext({
  question,
  mode = "discuss",
  source = {},
  anchor = {},
  history = [],
  researchQuestion = "",
  evidence = [],
  selection = {},
  systemPrompt,
  toolSchemas = [],
  budgets,
}) {
  // Content enters the model context only through registered evidence. Reading
  // source.pages here could bypass run exclusions or duplicate snapshots.
  const normalized = normalizeEvidence(evidence);
  const historyItems = Array.isArray(history)
    ? history
        .slice(-12)
        .map((item, index) => ({
          id: String(item?.id || `history-${index + 1}`),
          origin: String(item?.origin || item?.role || "unknown"),
          kind: String(item?.kind || "artifact"),
          text: String(item?.text || ""),
          ...(item?.assumptions
            ? { assumptions: String(item.assumptions) }
            : {}),
        }))
        .filter((item) => item.text)
    : [];
  const payload = {
    question: String(question || ""),
    mode: String(mode),
    researchQuestion: String(researchQuestion || ""),
    source: cleanSource(source),
    anchor: anchor && typeof anchor === "object" ? anchor : {},
    selection: {
      provider: selection.provider,
      model: selection.model,
      contextTokens: selection.contextTokens,
      capabilities: selection.capabilities,
    },
    evidenceInventory: normalized.inventory.slice(0, 100),
    evidence: normalized.loaded,
    history: historyItems,
  };
  const compacted = compactPayload(payload, systemPrompt, toolSchemas, budgets);
  const loadedIds = new Set(compacted.payload.evidence.map((item) => item.id));
  const inventory = normalized.inventory.map((item) => ({
    ...item,
    loadedInPrompt: loadedIds.has(item.id),
    status: loadedIds.has(item.id)
      ? "loaded"
      : item.status === "loaded"
        ? "evicted"
        : item.status,
  }));
  return {
    ...compacted,
    inventory,
    omittedEvidence: compacted.payload.omissions.filter(
      (item) => item.kind === "evidence",
    ),
    estimatedInputTokens: compacted.estimatedInputTokens,
  };
}

function groupTranscript(messages = []) {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const group = [message];
    if (
      message?.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length
    ) {
      const ids = new Set(message.toolCalls.map((call) => call.id));
      while (
        index + 1 < messages.length &&
        messages[index + 1]?.role === "tool"
      ) {
        const next = messages[index + 1];
        if (ids.size && !ids.has(next.toolCallId)) break;
        group.push(next);
        index += 1;
        ids.delete(next.toolCallId);
        if (!ids.size) break;
      }
    }
    groups.push(group);
  }
  return groups;
}

export function compactTranscript(
  messages,
  { maxTokens, toolSchemas = [], outputTokens = 0 } = {},
) {
  if (!Array.isArray(messages))
    throw new TypeError("Transcript must be an array.");
  const groups = groupTranscript(messages);
  const pinned = [];
  const removable = [];
  let initialUserPinned = false;
  for (const group of groups) {
    if (group.some((message) => message.role === "system")) {
      pinned.push(group);
    } else if (!initialUserPinned && group[0]?.role === "user") {
      pinned.push(group);
      initialUserPinned = true;
    } else removable.push(group);
  }
  const current = [...pinned, ...removable];
  const estimate = () =>
    estimateMessageTokens(current.flat(), toolSchemas) + outputTokens;
  const removedGroups = [];
  while (estimate() > maxTokens && removable.length) {
    const oldest = removable.shift();
    const at = current.indexOf(oldest);
    if (at >= 0) current.splice(at, 1);
    removedGroups.push(oldest);
  }
  return {
    messages: current.flat(),
    estimatedTokens: estimateMessageTokens(current.flat(), toolSchemas),
    removedGroups: removedGroups.length,
    overflow: estimate() > maxTokens,
  };
}

export function serializeTranscript(messages) {
  if (!Array.isArray(messages))
    throw new TypeError("Transcript must be an array.");
  return JSON.stringify({ version: 1, messages });
}

export function loadTranscript(serialized) {
  const data =
    typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  if (data?.version !== 1 || !Array.isArray(data.messages))
    throw new TypeError("Unsupported transcript format.");
  for (const message of data.messages) {
    if (
      !message ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    )
      throw new TypeError("Transcript contains an invalid message role.");
    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      !Array.isArray(message.toolCalls)
    )
      throw new TypeError("Transcript contains invalid assistant tool calls.");
  }
  return data.messages;
}
