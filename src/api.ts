let token = "";
export function setToken(value: string) {
  token = value;
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: {
      ...(body !== undefined && !form
        ? { "Content-Type": "application/json" }
        : {}),
      ...(body !== undefined ? { "X-Margin-Token": token } : {}),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
export function obsidianUrl(
  root: string,
  path: string,
  bridge = false,
  heading = "",
  line = 1,
) {
  const vault = root.split("/").filter(Boolean).pop() || "";
  return bridge
    ? `obsidian://margin?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}&heading=${encodeURIComponent(heading)}&line=${line}`
    : `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}
export const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

// Fetch-based SSE keeps the mutation/session token in a header, never in a URL.
export async function streamRunEvents(
  id: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: import("./agent-types").AgentEvent) => void,
) {
  const response = await fetch(`/api/runs/${encodeURIComponent(id)}/events`, {
    headers: { "X-Margin-Token": token, "Last-Event-ID": String(after) },
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `Activity stream unavailable (${response.status}).`;
    try {
      message = (await response.json()).error || message;
    } catch {
      /* Use HTTP status when no JSON body is available. */
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder
        .decode(value, { stream: true })
        .replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) onEvent(JSON.parse(data));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
