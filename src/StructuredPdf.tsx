import { useEffect, useState } from "react";
import { Download, Maximize2, RefreshCw, Square, X } from "lucide-react";
import type {
  Anchor,
  Config,
  Region,
  DocumentLayout,
  IntakeJob,
  ChunkContext,
} from "./types";
import { api, obsidianUrl } from "./api";
import PdfReader from "./PdfReader";
import { Markdown } from "./Markdown";
import {
  toggleRegions,
  selectedRegions,
  selectionAnchor,
} from "./region-geometry.mjs";

type State = {
  layout: DocumentLayout | null;
  job: IntakeJob | null;
  needsIntake?: boolean;
};
export default function StructuredPdf({
  sourceId,
  page,
  anchor,
  config,
  onAnchor,
  onNote,
  onAction,
}: {
  sourceId: string;
  page: number;
  anchor: Anchor;
  config: Config;
  onAnchor: (a: Anchor) => void;
  onNote: (path: string) => void;
  onAction: (tab: "thoughts" | "tutor") => void;
}) {
  const [multiSelect, setMultiSelect] = useState(false);
  const [focusedId, setFocusedId] = useState("");
  const [pollKey, setPollKey] = useState(0);
  const [state, setState] = useState<State>({ layout: null, job: null }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [showContext, setShowContext] = useState(false),
    [contexts, setContexts] = useState<ChunkContext[]>([]),
    [loadingContext, setLoadingContext] = useState(false),
    [extractor, setExtractor] = useState("native"),
    [model, setModel] = useState("");
  const running =
    !!state.job &&
    ["queued", "running", "cancelling"].includes(state.job.status);
  const regions = state.layout?.regions || [];
  const selections = selectedRegions(anchor, regions);
  const selected =
    selections.find((r) => r.id === focusedId) ||
    selections.find((r) => r.page === page) ||
    selections.at(-1);
  const selectableRegions = [
    ...regions,
    ...selections.filter((s) => !regions.some((r) => r.id === s.id)),
  ];
  const parent = regions.find((r) => r.id === selected?.parentId);
  const localModels = config.models.filter(
    (m) => !m.cloud && m.capabilities.includes("completion"),
  );
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    setContexts([]);
    setError("");
    let first = true;
    async function poll() {
      let stateAtEnd: State | undefined;
      try {
        let next = await api<State>(`/sources/${sourceId}/regions`);
        if (disposed) return;
        if (
          (!next.layout && !next.job) ||
          (next.needsIntake &&
            !["queued", "running", "cancelling"].includes(
              next.job?.status || "",
            ))
        ) {
          await api(`/sources/${sourceId}/intake`, {});
          next = await api<State>(`/sources/${sourceId}/regions`);
        }
        if (disposed) return;
        stateAtEnd = next;
        if (first && next.job) {
          setExtractor(next.job.extractor);
          setModel(next.job.model || "");
        }
        first = false;
        setState(next);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
      if (
        !disposed &&
        (!stateAtEnd ||
          ["queued", "running", "cancelling"].includes(
            stateAtEnd.job?.status || "",
          ))
      )
        timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sourceId, pollKey]);
  useEffect(() => {
    if (!selected || !showContext) {
      setContexts([]);
      return;
    }
    let live = true;
    setLoadingContext(true);
    api<{ contexts: ChunkContext[] }>(
      `/sources/${sourceId}/chunks?regionId=${encodeURIComponent(selected.id)}&revision=${encodeURIComponent(selected.revision || state.layout?.revision || "")}`,
    )
      .then((r) => {
        if (live) setContexts(r.contexts);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoadingContext(false);
      });
    return () => {
      live = false;
    };
  }, [
    sourceId,
    selected?.id,
    selected?.revision,
    showContext,
    state.job?.status,
    state.layout?.revision,
  ]);
  function choose(region: Region, additive = multiSelect) {
    const next = toggleRegions(selections, region, additive, selectableRegions);
    if (next.length > 64) {
      setError("Choose up to 64 regions in one selection.");
      return;
    }
    setFocusedId(
      next.some((r) => r.id === region.id) ? region.id : next.at(-1)?.id || "",
    );
    onAnchor(
      selectionAnchor(sourceId, region.page, next, state.layout?.revision),
    );
  }
  function remove(id: string) {
    onAnchor(
      selectionAnchor(
        sourceId,
        page,
        selections.filter((r) => r.id !== id),
        state.layout?.revision,
      ),
    );
  }
  async function start() {
    setBusy(true);
    setError("");
    try {
      const job = await api<IntakeJob>(`/sources/${sourceId}/intake`, {
        extractor,
        model,
      });
      setState((s) => ({ ...s, job }));
      setPollKey((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    try {
      const job = await api<IntakeJob>(
        `/sources/${sourceId}/intake/cancel`,
        {},
      );
      setState((s) => ({ ...s, job }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function download() {
    try {
      const data = await api(`/sources/${sourceId}/chunks`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `margin-${sourceId}-chunks.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const context =
    contexts.find((c) => c.model && !c.stale && c.status === "complete") ||
    contexts.find((c) => !c.stale) ||
    contexts[0];
  return (
    <div className="structured-reader">
      <div className="region-toolbar">
        <span>{regions.filter((r) => r.kind !== "page").length} regions</span>
        <button
          className="text-button"
          onClick={() => setSettings(!settings)}
          aria-expanded={settings}
        >
          Intake & context
        </button>
        <button
          className="icon-button"
          aria-label="Export chunk context JSON"
          onClick={() => void download()}
          disabled={!state.layout}
        >
          <Download size={14} />
        </button>
      </div>
      {settings && (
        <div className="intake-settings">
          <label>
            Extraction
            <select
              value={extractor}
              onChange={(e) => setExtractor(e.target.value)}
              disabled={running}
            >
              <option value="native">Native PDF · text & geometry</option>
              <option value="paddle">PaddleOCR · layout & equations</option>
            </select>
          </label>
          <label>
            Chunk processor
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={running}
            >
              <option value="">Find vault notes & region candidates</option>
              {localModels.map((m) => (
                <option key={m.name} value={m.name}>
                  Local agent · {m.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            {extractor === "paddle"
              ? "PaddleOCR runs locally through uv. First use installs its Python dependencies and downloads model weights. "
              : ""}
            Each chunk keeps its source anchor, note excerpts, and proposed
            connections. Local agent mode also saves summaries, assumptions, and
            questions.
          </p>
          <button
            className="secondary"
            disabled={busy || running}
            onClick={() => void start()}
          >
            <RefreshCw size={13} />
            Run / resume intake
          </button>
        </div>
      )}
      {state.job && (
        <div className={`intake-status ${state.job.status}`} role="status">
          <span>
            {state.job.message}
            {running && state.job.total > 0
              ? ` · ${state.job.done}/${state.job.total}`
              : ""}
          </span>
          {running && (
            <button
              className="text-button"
              onClick={() => void cancel()}
              disabled={state.job.status === "cancelling"}
            >
              <Square size={11} />
              Stop
            </button>
          )}
        </div>
      )}
      {error && <div className="notice">{error}</div>}
      {state.layout?.warnings
        .filter((w) => w.startsWith(`Page ${page} `))
        .map((w) => (
          <div className="notice" key={w}>
            {w}
          </div>
        ))}
      <PdfReader
        sourceId={sourceId}
        page={page}
        regions={selectableRegions}
        selectedIds={selections.map((r) => r.id)}
        additive={multiSelect}
        onRegion={choose}
      />
      <div className="region-selection">
        <button
          className={`text-button ${multiSelect ? "active" : ""}`}
          aria-pressed={multiSelect}
          onClick={() => setMultiSelect(!multiSelect)}
        >
          Multi-select {multiSelect ? "on" : "off"}
        </button>
        <span className="region-hint">
          {selections.length
            ? `${selections.length} selected`
            : "Cmd/Ctrl or Shift-click to add regions"}
        </span>
        <label className="sr-only" htmlFor={`region-${sourceId}`}>
          Select a PDF region
        </label>
        <select
          id={`region-${sourceId}`}
          aria-label="Select a PDF region"
          value={selected?.id || ""}
          onChange={(e) => {
            const r = selectableRegions.find((r) => r.id === e.target.value);
            if (r) choose(r);
          }}
        >
          <option value="">Hover a region, then click to select</option>
          {selectableRegions
            .filter(
              (r) =>
                r.page === page && (r.kind !== "page" || r.id === selected?.id),
            )
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.kind} · {r.text.slice(0, 75) || "Visual region"}
              </option>
            ))}
        </select>
        {selections.length > 0 && (
          <>
            {parent && (
              <button
                className="text-button"
                onClick={() => choose(parent, true)}
                title="Select enclosing region"
              >
                <Maximize2 size={13} />
                Expand to {parent.kind}
              </button>
            )}
            <button
              className="text-button"
              onClick={() => onAction("thoughts")}
            >
              Add note
            </button>
            <button className="text-button" onClick={() => onAction("tutor")}>
              Ask about this
            </button>
            <button
              className="text-button"
              onClick={() => setShowContext(!showContext)}
              aria-expanded={showContext}
            >
              Context
            </button>
            <button
              className="icon-button"
              aria-label="Clear region selection"
              onClick={() => onAnchor({ sourceId, page, quote: "" })}
            >
              <X size={13} />
            </button>
          </>
        )}
      </div>
      {selections.length > 1 && (
        <div className="selected-region-list" aria-label="Selected regions">
          {selections.map((r) => (
            <span key={r.id}>
              <button
                className="text-button"
                onClick={() => {
                  setFocusedId(r.id);
                  onAnchor({ ...anchor, page: r.page });
                }}
              >
                Page {r.page} · {r.kind}
                {r.lineCount && r.lineCount > 1 ? ` (${r.lineCount} rows)` : ""}
              </button>
              <button
                className="icon-button"
                aria-label={`Remove ${r.kind} on page ${r.page}`}
                onClick={() => remove(r.id)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {selected?.heuristic && (
        <p className="region-hint">
          Grouping inferred from headings and nearby blocks; adjust the
          selection if needed.
        </p>
      )}
      {selected && showContext && (
        <div className="chunk-context">
          <h3>{selected.kind} · saved context</h3>
          {loadingContext ? (
            <p>Reading chunk artifacts…</p>
          ) : !context ? (
            <p>No bundle saved yet. Run intake to process this region.</p>
          ) : (
            <>
              <p className="region-hint">
                {context.model
                  ? `AI proposals · ${context.model}`
                  : "Retrieved context · no model used"}{" "}
                · {context.stale ? "Vault changed; rerun intake" : "Unverified"}{" "}
                · {new Date(context.createdAt).toLocaleString()}
              </p>
              {context.error && <div className="notice">{context.error}</div>}
              {context.analysis && (
                <>
                  <Markdown text={context.analysis.summary} onNote={onNote} />
                  {context.analysis.assumptions.length > 0 && (
                    <>
                      <h4>Assumptions to retain</h4>
                      <ul>
                        {context.analysis.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {context.analysis.questions.length > 0 && (
                    <>
                      <h4>Questions to revisit</h4>
                      <ul>
                        {context.analysis.questions.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              <h4>Vault passages</h4>
              {context.notes.length === 0 && (
                <p>No relevant vault passages found.</p>
              )}
              {context.notes.map((n) => (
                <details key={n.path}>
                  <summary>
                    {n.title} · {n.section}
                  </summary>
                  <p>{n.reason}</p>
                  <blockquote>{n.excerpt}</blockquote>
                  <button
                    className="text-button"
                    onClick={() => onNote(n.path)}
                  >
                    Inspect note
                  </button>
                  <a
                    href={obsidianUrl(
                      config.vault.root,
                      n.path,
                      config.bridge,
                      n.section,
                      n.line,
                    )}
                  >
                    Open in Obsidian
                  </a>
                  {context.analysis?.noteLinks
                    .filter((l) => l.path === n.path)
                    .map((l, i) => (
                      <p key={i}>
                        Proposed connection: {l.reason}
                        <br />
                        Source: “{l.sourceQuote}”<br />
                        Note: “{l.targetQuote}”
                      </p>
                    ))}
                </details>
              ))}
              <h4>Related regions · proposed</h4>
              {context.candidates.length === 0 && (
                <p>No region candidates found.</p>
              )}
              {context.candidates.map((c) => (
                <details key={c.regionId}>
                  <summary>
                    Page {c.page} · {c.kind}
                  </summary>
                  <p>{c.reason}</p>
                  <blockquote>{c.text}</blockquote>
                  {context.analysis?.connections
                    .filter((l) => l.regionId === c.regionId)
                    .map((l, i) => (
                      <p key={i}>
                        {l.relation}: {l.reason}
                        <br />
                        Source: “{l.sourceQuote}”<br />
                        Target: “{l.targetQuote}”
                      </p>
                    ))}
                  <button
                    className="text-button"
                    onClick={() => {
                      const r = regions.find((r) => r.id === c.regionId);
                      if (r) choose(r);
                    }}
                  >
                    Go to region
                  </button>
                </details>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
