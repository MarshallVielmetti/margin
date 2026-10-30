import { useState } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import type { Config } from "./types";
import { api } from "./api";
import { DEFAULT_ORGANIZATION_MODEL } from "./model-defaults.mjs";

export function ModelPicker({
  config,
  disabled,
  onChanged,
  onError,
  onBusyChange,
  purpose = "tutor",
}: {
  config: Config;
  disabled?: boolean;
  onChanged: () => Promise<unknown>;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  purpose?: "tutor" | "synthesis";
}) {
  const [saving, setSaving] = useState(false);
  const selection =
    purpose === "synthesis"
      ? config.synthesis || {
          provider: "ollama",
          model: DEFAULT_ORGANIZATION_MODEL,
          cloud: false,
        }
      : config;
  const choices = config.chatModels.filter(
    (m) => purpose !== "synthesis" || m.name !== "auto-local",
  );
  const value = JSON.stringify([selection.provider, selection.model]);
  const available = choices.some(
    (m) => m.provider === selection.provider && m.name === selection.model,
  );
  async function change(next: string) {
    const [provider, model] = JSON.parse(next) as [Config["provider"], string];
    setSaving(true);
    onBusyChange?.(true);
    try {
      await api(
        "/settings",
        purpose === "synthesis"
          ? { synthesis: { provider, model } }
          : provider === "ollama"
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
        <span>{purpose === "synthesis" ? "Synthesis model" : "Model"}</span>
        <select
          aria-label={
            purpose === "synthesis" ? "Synthesis model" : "Tutor model"
          }
          value={value}
          disabled={disabled || saving}
          onChange={(e) => void change(e.target.value)}
        >
          {!available && (
            <option value={value} disabled>
              {selection.model} · unavailable
            </option>
          )}
          {[
            {
              label: "Local · Ollama",
              models: choices.filter((m) => !m.cloud),
            },
            {
              label: "Cloud · Ollama",
              models: choices.filter((m) => m.cloud && m.provider === "ollama"),
            },
            {
              label: "Cloud · OpenAI",
              models: choices.filter((m) => m.provider === "openai"),
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
      <details className="model-picker-refresh">
        <summary
          aria-label={
            purpose === "synthesis"
              ? "Synthesis model options"
              : "Model options"
          }
          className="icon-button"
        >
          <MoreHorizontal size={16} />
        </summary>
        <div>
          <button disabled={disabled || saving} onClick={() => void refresh()}>
            <RefreshCw size={14} className={saving ? "model-refreshing" : ""} />{" "}
            Refresh available models
          </button>
          {selection.cloud && (
            <p>
              {purpose === "synthesis"
                ? "Manual synthesis sends the note, selected thoughts, and supporting passages"
                : "Questions send the selected source, recent reasoning, and retrieved passages"}{" "}
              to {selection.provider}.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
