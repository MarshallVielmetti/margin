export const DEFAULT_LOCAL_MODEL = "qwen3.8:27b-mlx";

// The models endpoint includes embeddings, image, speech, and realtime models.
// Only text-generation families supported by our Responses transport belong here.
export function isTextModel(name) {
  return (
    /^(gpt-|chatgpt-|o[1-9](?:-|$)|ft:(?:gpt-|o[1-9]))/.test(name) &&
    !/(image|audio|realtime|transcrib|tts|search|instruct|moderation)/i.test(
      name,
    )
  );
}

export async function openAIModels(key, fetchImpl = fetch) {
  if (!key) return [];
  const response = await fetchImpl("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `OpenAI model discovery failed (${response.status}). Check OPENAI_API_KEY and refresh models.`,
    );
  const result = await response.json();
  return (result.data || [])
    .filter(
      (m) =>
        isTextModel(m.id) &&
        (!m.shutdown_date ||
          m.shutdown_date > new Date().toISOString().slice(0, 10)),
    )
    .map((m) => ({ name: m.id, provider: "openai", cloud: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
