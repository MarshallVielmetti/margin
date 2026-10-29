export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

export async function* responseLines(response, signal) {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader?.();
  const iterator =
    !reader && response.body[Symbol.asyncIterator]
      ? response.body[Symbol.asyncIterator]()
      : null;
  const onAbort = () => {
    if (reader) void reader.cancel(signal?.reason).catch(() => {});
    if (iterator?.return) void iterator.return().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const next = reader ? await reader.read() : await iterator?.next();
      if (!next || next.done) break;
      const bytes =
        next.value instanceof Uint8Array
          ? next.value
          : new Uint8Array(next.value);
      buffer += decoder.decode(bytes, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (reader) reader.releaseLock?.();
  }
}

export async function responseError(response, label) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.error || body?.message || "";
  } catch {
    try {
      detail = await response.text();
    } catch {
      // The status code is still useful when a server returns no readable body.
    }
  }
  throw new Error(
    `${label} request failed (${response.status})${detail ? `: ${String(detail).slice(0, 300)}` : "."}`,
  );
}

export function jsonResponse(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  return !response.body || contentType.includes("application/json");
}

export function parseArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizedUsage(promptTokens, outputTokens) {
  const input = Number.isFinite(Number(promptTokens))
    ? Number(promptTokens)
    : undefined;
  const output = Number.isFinite(Number(outputTokens))
    ? Number(outputTokens)
    : undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(input !== undefined || output !== undefined
      ? { totalTokens: (input || 0) + (output || 0) }
      : {}),
  };
}
