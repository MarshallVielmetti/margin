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
