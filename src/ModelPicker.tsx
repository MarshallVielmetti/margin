import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Config } from "./types";
import { api } from "./api";

export function ModelPicker({
  config,
  disabled,
  onChanged,
  onError,
  onBusyChange,
}: {
  config: Config;
  disabled?: boolean;
  onChanged: () => Promise<unknown>;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const value = JSON.stringify([config.provider, config.model]);
  const available = config.chatModels.some(
    (m) => m.provider === config.provider && m.name === config.model,
  );
  async function change(next: string) {
    const [provider, model] = JSON.parse(next) as [Config["provider"], string];
    setSaving(true);
    onBusyChange?.(true);
    try {
      await api(
        "/settings",
        provider === "ollama"
          ? { provider, ollamaModel: model, localAiEnabled: true }
          : { provider, model, aiEnabled: true },
      );
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  async function refresh() {
    setSaving(true);
    onBusyChange?.(true);
    try {
      await api("/models/refresh", {});
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="model-picker">
      <label>
        <span>Model</span>
        <select
          aria-label="Tutor model"
          value={value}
          disabled={disabled || saving}
          onChange={(e) => void change(e.target.value)}
        >
          {!available && (
            <option value={value} disabled>
              {config.model} · unavailable
            </option>
          )}
          {[
            {
              label: "Local · Ollama",
              models: config.chatModels.filter((m) => !m.cloud),
            },
            {
              label: "Cloud · Ollama",
              models: config.chatModels.filter(
                (m) => m.cloud && m.provider === "ollama",
              ),
            },
            {
              label: "Cloud · OpenAI",
              models: config.chatModels.filter((m) => m.provider === "openai"),
            },
          ].map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.models.length ? (
                group.models.map((m) => (
                  <option
                    key={JSON.stringify([m.provider, m.name])}
                    value={JSON.stringify([m.provider, m.name])}
                  >
                    {m.name === "auto-local"
                      ? "Auto · local (Qwen 3.8 / 3.6)"
                      : m.name}
                  </option>
                ))
              ) : (
                <option disabled>
                  {group.label === "Cloud · OpenAI" && !config.openaiConfigured
                    ? "Set OPENAI_API_KEY in .env"
                    : "No models available"}
                </option>
              )}
            </optgroup>
          ))}
        </select>
      </label>
      <button
        className="icon-button"
        aria-label="Refresh available models"
        title="Refresh available models"
        disabled={disabled || saving}
        onClick={() => void refresh()}
      >
        <RefreshCw size={14} className={saving ? "model-refreshing" : ""} />
      </button>
    </div>
  );
}
