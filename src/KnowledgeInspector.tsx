import { useEffect, useState } from "react";
import { api, obsidianUrl } from "./api";
import { Markdown } from "./Markdown";
import { Modal } from "./ui";
import type { Anchor, Config, Source } from "./types";
import type {
  KnowledgeAnchor,
  KnowledgeCard,
  KnowledgeEntry,
  KnowledgeSettings,
  KnowledgeView,
} from "./knowledge-types";
import "./knowledge.css";

export function KnowledgeInspector({
  source,
  config,
  onClose,
  onAnchor,
  onNote,
}: {
  source: Source;
  config: Config;
  onClose: () => void;
  onAnchor: (anchor: Anchor) => void;
  onNote: (path: string) => void;
}) {
  const [view, setView] = useState<KnowledgeView | null>(null),
    [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [query, setQuery] = useState(""),
    [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entityId, setEntityId] = useState(""),
    [model, setModel] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pages, setPages] = useState("");
  const load = async () => {
    const next = await api<KnowledgeView>(
      entityId
        ? `/knowledge/entities/${entityId}`
        : `/sources/${source.id}/knowledge`,
    );
    setView(next);
  };
  useEffect(() => {
    let live = true;
    void api<KnowledgeSettings>("/knowledge/settings")
      .then((s) => {
        if (live) {
          setSettings(s);
          setModel(s.model);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setView(null);
    const refresh = () =>
      void api<KnowledgeView>(
        entityId
          ? `/knowledge/entities/${entityId}`
          : `/sources/${source.id}/knowledge`,
      )
        .then((v) => {
          if (live) setView(v);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [entityId, source.id]);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () =>
        void api<{ entries: KnowledgeEntry[] }>(
          `/knowledge/search?q=${encodeURIComponent(query)}`,
        )
          .then((r) => {
            if (live) setEntries(r.entries);
          })
          .catch((e) => {
            if (live) setError(e.message);
          }),
      250,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const active = view?.jobs.find((j) =>
    ["queued", "running", "cancelling"].includes(j.status),
  );
  const openAnchor = (a: KnowledgeAnchor) => {
    if (a.origin === "source" && a.sourceId && a.page) {
      // Source anchors carry extraction revisions. The reader selects the exact
      // retained region even when its page text differs from native extraction.
      onAnchor({
        sourceId: a.sourceId,
        page: a.page,
        quote: a.text,
        regionId: a.regionId,
        revision: a.revision,
        box: a.box,
      });
      onClose();
    }
  };
  const currentSource = !entityId || view?.entity.sourceIds.includes(source.id);
  return (
    <Modal title="Living knowledge" onClose={onClose} wide>
      <p className="muted">
        Persistent preparation is separate from your literature note. Source
        passages, note interpretations, and AI proposals keep their own origins.
        Acceptance does not verify mathematics.
      </p>
      {error && (
        <p role="alert" className="notebook-error">
          {error}
        </p>
      )}
      <div className="knowledge-layout">
        <aside className="knowledge-catalog">
          <button onClick={() => setEntityId("")}>Current paper</button>
          <label>
            Find skills
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Result, concept, MOC…"
            />
          </label>
          <div className="knowledge-results">
            {entries.map((e) => (
              <button
                key={e.entityId}
                className={view?.entity.id === e.entityId ? "active" : ""}
                onClick={() => setEntityId(e.entityId)}
              >
                <strong>{e.title}</strong>
                <small>
                  {e.type} · {e.freshness}
                </small>
                <span>{e.description}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="knowledge-content" aria-live="polite">
          {!view ? (
            <p>Loading knowledge…</p>
          ) : (
            <>
              <h3>{view.entity.title}</h3>
              {view.entity.notePath && (
                <button onClick={() => onNote(view.entity.notePath!)}>
                  Open current note
                </button>
              )}
              <a
                className="knowledge-export"
                href={`/api/knowledge/entities/${view.entity.id}/export`}
                download
              >
                Export Markdown snapshot and reviews
              </a>
              {!!view.navigation.nodes.length && (
                <details>
                  <summary>Explicit note and MOC routes</summary>
                  <p className="fine-print">
                    Existing note links; authorship is not inferred. Opening a
                    route loads only that skill.
                  </p>
                  {view.navigation.nodes.map((n) => (
                    <button
                      key={n.entityId}
                      onClick={() => setEntityId(n.entityId)}
                    >
                      {n.title} · {n.type}
                    </button>
                  ))}
                  {view.navigation.truncated && (
                    <p className="fine-print">
                      More routes are available through direct search.
                    </p>
                  )}
                </details>
              )}
              {view.navigation.links
                .filter((l) => l.unresolved)
                .map((l, i) => (
                  <p className="fine-print" key={i}>
                    {l.unresolved} · {l.status}
                  </p>
                ))}
              {currentSource && source.kind === "pdf" && (
                <fieldset disabled={busy || !!active}>
                  <legend>Prepare this paper</legend>
                  <label>
                    Local preparation model
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      <option value="">
                        Extraction map only · no model calls
                      </option>
                      {config.models
                        .filter(
                          (m) =>
                            !m.cloud && m.capabilities.includes("completion"),
                        )
                        .map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Pages (optional, comma separated)
                    <input
                      value={pages}
                      onChange={(e) => setPages(e.target.value)}
                      placeholder="1, 2, 3"
                    />
                  </label>
                  <button
                    onClick={() =>
                      void act(async () => {
                        const selected = pages.trim()
                          ? pages.split(",").map((p) => Number(p.trim()))
                          : [];
                        if (selected.some((p) => !Number.isInteger(p) || p < 1))
                          throw new Error(
                            "Enter positive page numbers separated by commas.",
                          );
                        return api(`/sources/${source.id}/knowledge/prepare`, {
                          model,
                          pages: selected,
                          maxUnits: settings?.maxUnits || 8,
                          maxCalls: settings?.maxCalls ?? 12,
                          maxComparisons: settings?.maxComparisons ?? 3,
                        });
                      })
                    }
                  >
                    {model
                      ? "Prepare with local model"
                      : "Build extraction map"}
                  </button>
                </fieldset>
              )}
              {active && (
                <div className="knowledge-status">
                  <p role="status">
                    {active.message} · {active.done}/{active.total} units ·{" "}
                    {active.modelCalls} model calls
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api(`/knowledge/jobs/${active.id}/cancel`, {}),
                      )
                    }
                  >
                    Stop preparation
                  </button>
                </div>
              )}
              {!active && view.jobs[0] && (
                <p className="fine-print">
                  {view.jobs[0].status} · {view.jobs[0].message}
                </p>
              )}
              {view.snapshot ? (
                <>
                  <p
                    className={
                      view.snapshot.freshness === "current"
                        ? "knowledge-status"
                        : "notebook-error"
                    }
                  >
                    {view.snapshot.origin} preparation ·{" "}
                    {view.snapshot.freshness} · mathematically unverified
                  </p>
                  <p>
                    Coverage: {view.snapshot.coverage.coveredPages.length} of{" "}
                    {view.snapshot.coverage.totalPages} pages in selected units;{" "}
                    {view.snapshot.coverage.selectedUnits} of{" "}
                    {view.snapshot.coverage.availableUnits} available units.{" "}
                    {view.snapshot.coverage.preparation}.
                  </p>
                  {!!view.snapshot.coverage.missingPages.length && (
                    <p className="notebook-error">
                      No extracted text on pages{" "}
                      {view.snapshot.coverage.missingPages.join(", ")}. Analysis
                      cannot cover those pages.
                    </p>
                  )}
                  {[
                    ...view.snapshot.coverage.warnings,
                    ...view.snapshot.issues,
                  ].map((s, i) => (
                    <p className="fine-print" key={i}>
                      {s}
                    </p>
                  ))}
                  <details open>
                    <summary>
                      Paper overview · {view.snapshot.generation}
                    </summary>
                    {view.snapshot.overviewCoverage && (
                      <p className="fine-print">
                        Overview scope: excerpts from{" "}
                        {view.snapshot.overviewCoverage.unitIds.length} units
                        {view.snapshot.overviewCoverage.omittedUnits
                          ? `; ${view.snapshot.overviewCoverage.omittedUnits} additional units omitted`
                          : ""}
                        . This does not establish complete paper analysis.
                      </p>
                    )}
                    {view.snapshot.generationCompletion && (
                      <p className="fine-print">
                        Unit preparation:{" "}
                        {view.snapshot.generationCompletion.generatedUnits}{" "}
                        generated ·{" "}
                        {view.snapshot.generationCompletion.failedUnits} failed
                        · {view.snapshot.generationCompletion.ungeneratedUnits}{" "}
                        not generated.
                      </p>
                    )}
                    <Markdown text={view.snapshot.markdown} />
                  </details>
                  <h4>Meaningful units</h4>
                  {view.snapshot.units.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      config={config}
                      onAnchor={openAnchor}
                    />
                  ))}
                  <h4>Comparison proposals</h4>
                  {!view.snapshot.connections.length && (
                    <p className="muted">
                      No supported comparisons retained yet.
                    </p>
                  )}
                  {view.snapshot.connections.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      config={config}
                      onAnchor={openAnchor}
                      onReview={(state, correction) =>
                        act(() =>
                          api(`/knowledge/connections/${card.id}/review`, {
                            state,
                            correction,
                          }),
                        )
                      }
                    />
                  ))}
                </>
              ) : (
                <p>
                  This skill has a lightweight manifest. Deeper preparation has
                  not been generated.
                </p>
              )}
              {(view.comparisons || [])
                .filter(
                  (card) =>
                    !view.snapshot?.connections.some((c) => c.id === card.id),
                )
                .map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    config={config}
                    onAnchor={openAnchor}
                    onReview={(state, correction) =>
                      act(() =>
                        api(`/knowledge/connections/${card.id}/review`, {
                          state,
                          correction,
                        }),
                      )
                    }
                  />
                ))}
              {view.comparisonsTruncated && (
                <p className="fine-print">
                  Showing the first twenty comparisons for this skill.
                </p>
              )}
            </>
          )}
          {settings && (
            <details className="knowledge-settings">
              <summary>Background preparation settings</summary>
              <p>
                Uses this explicitly selected local model after intake. Tutor
                and Synthesis model choices do not enable preparation. Each job
                is bounded by the limits below.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) =>
                    setSettings({ ...settings, enabled: e.target.checked })
                  }
                />{" "}
                Enable local background preparation
              </label>
              <label>
                Local model
                <select
                  value={settings.model}
                  onChange={(e) =>
                    setSettings({ ...settings, model: e.target.value })
                  }
                >
                  <option value="">Choose a local model</option>
                  {config.models
                    .filter(
                      (m) => !m.cloud && m.capabilities.includes("completion"),
                    )
                    .map((m) => (
                      <option key={m.name}>{m.name}</option>
                    ))}
                </select>
              </label>
              {(
                [
                  ["maxUnits", "Units per job", 64],
                  ["maxCalls", "Model calls per job", 80],
                  ["maxComparisons", "Comparisons per job", 8],
                ] as const
              ).map(([key, title, max]) => (
                <label key={key}>
                  {title}
                  <input
                    type="number"
                    min={key === "maxUnits" ? 1 : 0}
                    max={max}
                    value={settings[key]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setSettings(
                      await api<KnowledgeSettings>(
                        "/knowledge/settings",
                        settings,
                      ),
                    ),
                  )
                }
              >
                Save preparation settings
              </button>
            </details>
          )}
        </section>
      </div>
    </Modal>
  );
}

function Card({
  card,
  config,
  onAnchor,
  onReview,
}: {
  card: KnowledgeCard;
  config: Config;
  onAnchor: (anchor: KnowledgeAnchor) => void;
  onReview?: (state: string, correction: string) => Promise<void>;
}) {
  const [correction, setCorrection] = useState(card.review?.correction || "");
  return (
    <details className="knowledge-card">
      <summary>
        {card.title} · {card.kind || card.relation} · {card.freshness}
        {onReview ? ` · ${card.review.state}` : ""}
      </summary>
      <p className="fine-print">
        {card.origin} · {card.generation || "proposal"} · unverified
        {card.freshness !== "current"
          ? " · historical guidance; inspect current inputs before use"
          : ""}
      </p>
      {card.review.correction && (
        <p className="knowledge-correction">
          Retained human correction: {card.review.correction}
        </p>
      )}
      <Markdown text={card.markdown} />
      {card.issues?.map((s, i) => (
        <p key={i} className="fine-print">
          {s}
        </p>
      ))}
      <details>
        <summary>Exact retained evidence excerpts</summary>
        {card.anchors.map((a, i) => (
          <div key={i} className="knowledge-anchor">
            <strong>
              {a.origin === "source"
                ? `Original source · page ${a.page}`
                : `Note passage · ${a.authorship || "authorship not inferred"} · ${a.path}`}
            </strong>
            <pre>{a.text}</pre>
            {a.origin === "source" ? (
              <button onClick={() => onAnchor(a)}>Open source passage</button>
            ) : (
              <a
                href={obsidianUrl(
                  config.vault.root,
                  a.path!,
                  config.bridge,
                  "",
                  a.lineStart || 1,
                )}
              >
                Open current note in Obsidian
              </a>
            )}
          </div>
        ))}
      </details>
      {onReview && (
        <div className="knowledge-review">
          <label>
            Correction or qualification
            <textarea
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
            />
          </label>
          <div>
            {(
              [
                ["accepted", "Accept proposal"],
                ["rejected", "Reject"],
                ["corrected", "Save correction"],
                ["proposed", "Reopen"],
              ] as const
            ).map(([state, label]) => (
              <button
                key={state}
                disabled={state === "corrected" && !correction.trim()}
                onClick={() => void onReview(state, correction)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </details>
  );
}
