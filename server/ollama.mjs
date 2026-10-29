export function localEndpoint(value = "http://127.0.0.1:11434") {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Ollama must use an HTTP loopback address on this computer.",
    );
  return url.origin;
}

export class Ollama {
  constructor(url, fetchImpl = fetch) {
    this.url = localEndpoint(url);
    this.fetch = fetchImpl;
  }
  async request(path, body, timeout = 180_000, signal) {
    let response;
    try {
      response = await this.fetch(`${this.url}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error(
        error.name === "TimeoutError"
          ? "Ollama took too long. Your input is saved; try a smaller model or shorter passage."
          : "Cannot reach local Ollama. Start Ollama, then refresh models in Settings.",
      );
    }
    const result = await response.json();
    if (!response.ok || result.error)
      throw new Error(
        `Ollama: ${String(result.error || response.status).slice(0, 250)}`,
      );
    return result;
  }
  async models() {
    const { models = [] } = await this.request("tags", undefined, 5000);
    const found = await Promise.all(
      models.map(async (m) => {
        // Recent runtimes include capabilities in /tags (including MLX models).
        const details = m.capabilities?.length
          ? m
          : await this.request("show", { model: m.name }, 5000).catch(
              () => ({}),
            );
        return {
          name: m.name,
          size: m.size,
          capabilities: details.capabilities || [],
          cloud: !!(
            m.remote_model ||
            m.remote_host ||
            details.remote_model ||
            details.remote_host ||
            /(?::|-|\.)cloud$/.test(m.name)
          ),
        };
      }),
    );
    return found;
  }
  async chat(model, instructions, content) {
    const result = await this.request("chat", {
      model,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: { temperature: 0.2, num_ctx: 8192, num_predict: 1200 },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content },
      ],
    });
    if (!result.message?.content?.trim())
      throw new Error("Ollama returned no answer. Your input is saved.");
    return {
      text: result.message.content,
      truncated: result.done_reason === "length",
    };
  }
  async embed(model, input) {
    const result = await this.request("embed", {
      model,
      input,
      truncate: true,
      keep_alive: "5m",
    });
    if (
      !Array.isArray(result.embeddings) ||
      result.embeddings.length !== input.length ||
      result.embeddings.some(
        (v) =>
          !Array.isArray(v) || !v.length || v.some((x) => !Number.isFinite(x)),
      )
    )
      throw new Error("Ollama returned invalid embeddings.");
    return result.embeddings;
  }
}
