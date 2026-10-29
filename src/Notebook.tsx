import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Mic,
  MicOff,
  Plus,
  Sparkles,
  X,
  Flag,
  Bookmark,
} from "lucide-react";
import type { Anchor, Artifact, Config, Session } from "./types";
import { Markdown } from "./Markdown";
import { api } from "./api";
import { Tag } from "./ui";
import { AgentActivity } from "./AgentActivity";
import { ContextInspector } from "./ContextInspector";
import { isTerminalRun, type AgentRun } from "./agent-types";
import "./agent.css";
import { ModelPicker } from "./ModelPicker";

interface SpeechResult {
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
  resultIndex: number;
}
interface SpeechEngine {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechResult) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechEngine;
  webkitSpeechRecognition?: new () => SpeechEngine;
};

export function Notebook({
  session,
  anchor,
  config,
  onChanged,
  onPromote,
  onAnchor,
  onNote,
  onError,
  onSettings,
  composeAction,
}: {
  session: Session;
  anchor: Anchor;
  config: Config;
  onChanged: () => Promise<void>;
  onPromote: (artifacts: Artifact[]) => void;
  onAnchor: (anchor: Anchor) => void;
  onNote: (title: string) => void;
  onError: (message: string) => void;
  onSettings: () => void;
  composeAction?: { tab: "capture" | "tutor"; nonce: number } | null;
}) {
  const draftKey = `margin-draft-${session.id}`;
  const [draft, setDraft] = useState(
      () => localStorage.getItem(draftKey) || "",
    ),
    [kind, setKind] = useState("thought"),
    [tab, setTab] = useState("capture"),
    [mode, setMode] = useState("discuss"),
    [busy, setBusy] = useState(false),
    [modelBusy, setModelBusy] = useState(false),
    [assumptions, setAssumptions] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [dictating, setDictating] = useState(false),
    [showAssumptions, setShowAssumptions] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [resumption, setResumption] = useState<{
    openQuestions: Artifact[];
    nextStep: string;
    takeaway: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]),
    [excluded, setExcluded] = useState<string[]>([]);
  const submittingKey = useRef<string | null>(null);
  const activeRun = runs.some((run) => !isTerminalRun(run));
  const contextEvidence = [
    ...new Map(
      (session.artifacts || [])
        .flatMap((a) => a.evidence || [])
        .map((item) => [item.id, item]),
    ).values(),
  ];
  async function refreshRuns() {
    if (config.features?.agentHarness) {
      const [nextRuns, nextResearch] = await Promise.all([
        api<AgentRun[]>(`/sessions/${session.id}/runs`),
        api<{ openQuestions: Artifact[]; nextStep: string; takeaway: string }>(
          `/sessions/${session.id}/research`,
        ),
      ]);
      setRuns(nextRuns);
      setResumption(nextResearch);
    }
  }
  useEffect(() => {
    void refreshRuns().catch((e) => onError(e.message));
  }, [session.id, session.artifacts?.length]);
  async function continueRun(run: AgentRun) {
    const next = await api<AgentRun>(`/runs/${run.id}/continue`, {
      idempotencyKey: crypto.randomUUID(),
      budgets: { maxModelCalls: 8, maxToolCalls: 20, maxSeconds: 240 },
      contextOverrides: {
        pinnedEvidenceIds: pinned,
        excludedEvidenceIds: excluded,
      },
    });
    setRuns((list) => [next, ...list]);
    await onChanged();
  }
  const end = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    speech = useRef<SpeechEngine | null>(null);
  const artifacts = session.artifacts || [];
  useEffect(() => {
    localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [artifacts.length]);
  useEffect(() => () => speech.current?.stop(), []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (composeAction) {
      setTab(composeAction.tab);
      input.current?.focus();
    }
  }, [composeAction]);
  async function submit() {
    if (!draft.trim() || busy || modelBusy || (tab === "tutor" && activeRun))
      return;
    if (
      tab === "tutor" &&
      !config.aiEnabled &&
      !config.features?.agentHarness
    ) {
      onSettings();
      return;
    }
    setBusy(true);
    try {
      if (tab === "tutor" && config.features?.agentHarness) {
        submittingKey.current ||= crypto.randomUUID();
        const run = await api<AgentRun>(`/sessions/${session.id}/runs`, {
          text: draft,
          anchor,
          mode,
          idempotencyKey: submittingKey.current,
          contextOverrides: {
            pinnedEvidenceIds: pinned,
            excludedEvidenceIds: excluded,
          },
        });
        setRuns((list) => [run, ...list.filter((item) => item.id !== run.id)]);
        submittingKey.current = null;
      } else
        await api(
          `/sessions/${session.id}/${tab === "tutor" ? "tutor" : "artifacts"}`,
          {
            text: draft,
            kind,
            anchor,
            mode,
            assumptions: assumptions || undefined,
          },
        );
      setDraft("");
      setAssumptions("");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function prompt(mode: string) {
    setBusy(true);
    try {
      await api(`/sessions/${session.id}/prompt`, { mode, anchor });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function dictate() {
    if (dictating) {
      speech.current?.stop();
      setDictating(false);
      return;
    }
    const engine =
      (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition;
    if (!engine) {
      onError(
        "Browser dictation is unavailable here. You can use macOS dictation in the text field, or open Margin in Chrome.",
      );
      return;
    }
    const recognition = new engine();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal)
          setDraft((d) => `${d}${d ? " " : ""}${e.results[i][0].transcript}`);
    };
    recognition.onerror = (e) => {
      setDictating(false);
      onError(
        `Dictation stopped: ${e.error}. Your captured text is preserved.`,
      );
    };
    recognition.onend = () => setDictating(false);
    speech.current = recognition;
    try {
      recognition.start();
      setDictating(true);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <section className="notebook" aria-label="Working notebook">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">YOUR THINKING, PRESERVED</span>
          <h2>Working notebook</h2>
        </div>
        <BookOpen size={19} />
      </div>
      <div className="notebook-tabs">
        <button
          className={tab === "capture" ? "active" : ""}
          onClick={() => setTab("capture")}
        >
          Capture
        </button>
        <button
          className={tab === "tutor" ? "active" : ""}
          onClick={() => setTab("tutor")}
        >
          <Sparkles size={13} /> Research tutor
        </button>
        <span>
          {artifacts.filter((a) => a.origin === "user").length} entries
        </span>
      </div>
      <div className="entries">
        {!artifacts.length && (
          <div className="notebook-welcome">
            <div className="handdrawn">
              a little room
              <br />
              for your thinking.
            </div>
            <p>
              Questions, unfinished proofs, moments of clarity. Keep the path
              that led you there.
            </p>
            <button
              className="prompt-card"
              disabled={busy}
              onClick={() => void prompt("assumptions")}
            >
              <Sparkles size={17} />
              <span>
                <strong>Start with a good question</strong>
                <small>Separate the assumptions from the guarantee.</small>
              </span>
              <ArrowUpRight size={17} />
            </button>
          </div>
        )}
        {artifacts.map((a) => (
          <article
            key={a.id}
            className={`entry ${a.origin === "user" ? "own-entry" : "tutor-entry"} ${selected.includes(a.id) ? "selected" : ""}`}
          >
            <div className="entry-meta">
              <span>
                {a.origin === "user"
                  ? "YOU"
                  : a.origin === "prompt"
                    ? "READING PROMPT"
                    : a.origin === "tool"
                      ? "SOURCE EXTRACTION"
                      : "AI SUGGESTION"}
              </span>
              <span>{a.kind.replaceAll("-", " ")}</span>
              <time>
                {new Date(a.createdAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              {a.origin === "user" && (
                <input
                  aria-label={`Select entry: ${a.text.slice(0, 45)}`}
                  type="checkbox"
                  checked={selected.includes(a.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, a.id]
                        : v.filter((id) => id !== a.id),
                    )
                  }
                />
              )}
            </div>
            {a.anchor && (
              <button
                className="anchor-link"
                onClick={() => onAnchor(a.anchor!)}
              >
                <Bookmark size={11} />
                {a.anchor.section || `Page ${a.anchor.page}`}
              </button>
            )}
            <Markdown
              text={a.text}
              onNote={onNote}
              evidence={
                config.features?.citations === false
                  ? undefined
                  : a.evidence?.filter((item) => item.loadedInPrompt !== false)
              }
              citationContext={{
                vaultRoot: config.vault.root,
                vaultId: config.vaultId,
                bridge: config.bridge,
                sourceId: a.anchor?.sourceId || session.sourceId,
              }}
              onAnchor={onAnchor}
            />
            {a.runStatus && a.runStatus !== "completed" && (
              <p className="run-result-status">
                {a.runStatus} · this answer is incomplete
              </p>
            )}
            {a.referenceResults && (
              <details className="evidence">
                <summary>Reference identification details</summary>
                {a.referenceResults.map((result) => (
                  <div key={result.label}>
                    <p>
                      [{result.label}] Entry: {result.status}.
                      {result.reason ? ` ${result.reason}` : ""} Library match:{" "}
                      {result.metadataMatch?.status || "unavailable"}
                      {result.metadataMatch?.title
                        ? ` · ${result.metadataMatch.title}`
                        : ""}
                      {result.metadataMatch?.matchedBy
                        ? ` (${result.metadataMatch.matchedBy.replaceAll("_", " ")})`
                        : ""}
                      . Full text and cited claims require a separate read.
                    </p>
                    {(
                      result.candidates ||
                      (result.status !== "found" && result.text
                        ? [{ text: result.text, page: result.page || 1 }]
                        : [])
                    ).map((candidate, index) => (
                      <p key={index}>
                        <small>Unresolved extracted candidate:</small>{" "}
                        {candidate.text}
                      </p>
                    ))}
                    {[
                      ...new Set(
                        result.pages || (result.page ? [result.page] : []),
                      ),
                    ].map((page) => (
                      <button
                        key={page}
                        onClick={() =>
                          onAnchor({
                            sourceId: a.anchor?.sourceId || session.sourceId,
                            page,
                            quote: "",
                          })
                        }
                      >
                        Inspect source · page {page}
                      </button>
                    ))}
                  </div>
                ))}
              </details>
            )}
            {a.assumptions && (
              <details className="assumptions">
                <summary>Associated assumptions</summary>
                <Markdown text={a.assumptions} />
              </details>
            )}
            {a.model && (
              <p className="fine-print">
                {a.cloud || a.provider === "openai" ? "Cloud" : "Local"} ·{" "}
                {a.provider} · {a.model}
                {a.routing && (
                  <>
                    <br />
                    Auto · local · {a.routing.reason}
                    {a.routing.fallback ? " (fallback)" : ""}
                  </>
                )}
              </p>
            )}
            {a.retrievalWarning && (
              <p className="fine-print">{a.retrievalWarning}</p>
            )}
            {a.evidence && (
              <details className="evidence">
                <summary>Source context · {a.evidence.length} passages</summary>
                {a.evidence.map((e) => (
                  <div key={e.id}>
                    <strong>
                      [{e.id}] {e.title}
                    </strong>
                    <p>{e.text.slice(0, 700)}</p>
                    {e.path ? (
                      <button
                        className="text-button"
                        onClick={() => onNote(e.path!)}
                      >
                        Inspect note
                      </button>
                    ) : (
                      <span>Page {e.page}</span>
                    )}
                  </div>
                ))}
              </details>
            )}
            {a.origin === "user" ? (
              <div className="entry-actions">
                <button className="text-button" onClick={() => onPromote([a])}>
                  Promote <ArrowUpRight size={12} />
                </button>
                <select
                  aria-label="Self-reported learning status"
                  value={a.status}
                  onChange={(e) =>
                    void api(
                      `/artifacts/${a.id}`,
                      { status: e.target.value },
                      "PATCH",
                    )
                      .then(onChanged)
                      .catch((e) => onError(e.message))
                  }
                >
                  <option value="open">Still exploring</option>
                  <option value="revisit">Revisit this</option>
                  <option value="understood">I can explain this</option>
                </select>
              </div>
            ) : (
              <div className="entry-footnote">
                {a.origin === "prompt"
                  ? "Local reflection prompt · your answer stays in your words"
                  : a.origin === "tool"
                    ? "Extracted from the source bibliography · citation targets checked"
                    : "AI-generated · verify against the original source"}
              </div>
            )}
          </article>
        ))}
        {runs.slice(0, 3).map((run) => (
          <AgentActivity
            key={run.id}
            run={run}
            onChanged={async () => {
              await onChanged();
              await refreshRuns();
            }}
            onContinue={continueRun}
            onError={onError}
          />
        ))}
        {config.features?.agentHarness && (
          <ContextInspector
            evidence={contextEvidence}
            pinned={pinned}
            excluded={excluded}
            onChange={(nextPinned, nextExcluded) => {
              setPinned(nextPinned);
              setExcluded(nextExcluded);
            }}
          />
        )}
        {resumption?.openQuestions.length ||
        session.nextStep ||
        session.takeaway ? (
          <details className="resumption-card">
            <summary>Resume inquiry · page {session.page}</summary>
            {resumption?.openQuestions.at(-1) && (
              <p>Last open question: {resumption.openQuestions.at(-1)?.text}</p>
            )}
            {(session.nextStep || session.takeaway) && (
              <p>{session.nextStep || session.takeaway}</p>
            )}
          </details>
        ) : null}
        {config.features?.agentHarness && (
          <details className="context-inspector">
            <summary>Saved research data</summary>
            <p className="fine-print">
              Export saved runs and evidence from Settings. Clear diagnostic
              details to keep answers and citations while removing tool
              arguments, transcripts, and progress events.
            </p>
            <button
              disabled={activeRun || dataBusy}
              onClick={() => {
                setDataBusy(true);
                void api(`/sessions/${session.id}/diagnostics/purge`, {})
                  .then(refreshRuns)
                  .catch((e) => onError(e.message))
                  .finally(() => setDataBusy(false));
              }}
            >
              Clear diagnostic details
            </button>
            {confirmDelete ? (
              <div>
                <p>
                  Delete all saved notebook entries, runs, and research state in
                  this session? Vault notes and source files stay in place. This
                  cannot be undone.
                </p>
                <button
                  disabled={activeRun || dataBusy}
                  onClick={() => {
                    setDataBusy(true);
                    void api(
                      `/sessions/${session.id}/research-history/delete`,
                      {},
                    )
                      .then(async () => {
                        setPinned([]);
                        setExcluded([]);
                        setSelected([]);
                        setConfirmDelete(false);
                        await onChanged();
                        await refreshRuns();
                      })
                      .catch((e) => onError(e.message))
                      .finally(() => setDataBusy(false));
                  }}
                >
                  Delete saved history
                </button>
                <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            ) : (
              <button
                disabled={activeRun || dataBusy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete notebook history…
              </button>
            )}
          </details>
        )}
        <div ref={end} />
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length} selected</span>
          <button
            onClick={() =>
              onPromote(artifacts.filter((a) => selected.includes(a.id)))
            }
          >
            Prepare promotion <ArrowUpRight size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Clear selected entries"
            onClick={() => setSelected([])}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="composer">
        <div className="composer-context">
          <Bookmark size={12} />
          <span>
            {anchor.quote
              ? `“${anchor.quote.slice(0, 90)}${anchor.quote.length > 90 ? "…" : ""}”`
              : anchor.section || `Anchored to page ${anchor.page}`}
          </span>
        </div>
        {tab === "tutor" && !config.aiEnabled && (
          <div className="inline-notice">
            {config.features?.agentHarness
              ? "Bibliography lookups work locally. For other questions, choose a model below or enable tutoring in "
              : "Choose an available model below, or enable tutoring in "}
            <button onClick={onSettings}>Settings</button>.
          </div>
        )}
        {tab === "tutor" && (
          <>
            {config.cloud && (
              <p className="fine-print">
                Cloud run context: the selected source and this workspace’s
                papers, retrieved vault passages, and workspace history.
              </p>
            )}
            <ModelPicker
              config={config}
              disabled={busy}
              onChanged={onChanged}
              onError={onError}
              onBusyChange={setModelBusy}
            />
            {(config.modelError || config.cloudModelError) && (
              <p className="model-notice">
                {config.modelError || config.cloudModelError}
              </p>
            )}
          </>
        )}
        <textarea
          ref={input}
          aria-label={
            tab === "tutor" ? "Ask the research tutor" : "Capture your thinking"
          }
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            submittingKey.current = null;
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            tab === "tutor"
              ? "What would you like to work through?"
              : "What are you thinking? Write freely…"
          }
          rows={tab === "tutor" ? 3 : 4}
        />
        {showAssumptions && (
          <textarea
            aria-label="Assumptions attached to this thought"
            rows={2}
            value={assumptions}
            onChange={(e) => setAssumptions(e.target.value)}
            placeholder="Assumptions this claim depends on…"
          />
        )}
        <div className="composer-tools">
          {tab === "tutor" ? (
            <select
              className="tutor-action"
              aria-label="Tutor action"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="discuss">Answer</option>
              {config.features?.agentHarness && (
                <option value="investigate">Investigate</option>
              )}
              <option value="recall">Tutor · recall & feedback</option>
              <option value="assumptions">Check assumptions</option>
              <option value="connect">Compare related concepts</option>
              <option value="proof">Next proof hint</option>
              <option value="synthesize">Synthesis checkpoint</option>
              <option value="edit">Draft from my words</option>
            </select>
          ) : (
            <select
              aria-label="Entry type"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="thought">Thought</option>
              <option value="question">Open question</option>
              <option value="proof">Proof attempt</option>
              <option value="example">Example</option>
              <option value="claim">Claim / conjecture</option>
              <option value="summary">My summary</option>
            </select>
          )}
          <button
            className={`icon-button ${showAssumptions ? "active" : ""}`}
            title="Attach assumptions"
            aria-label="Attach assumptions"
            onClick={() => setShowAssumptions(!showAssumptions)}
          >
            <Plus size={16} />
          </button>
          <button
            className={`icon-button ${dictating ? "recording" : ""}`}
            aria-label={
              dictating ? "Stop dictation" : "Start browser dictation"
            }
            title="Browser dictation may use your browser's speech service"
            onClick={dictate}
          >
            {dictating ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <button
            className="send-button"
            aria-label={tab === "tutor" ? "Send to tutor" : "Save thought"}
            disabled={!draft.trim() || busy || (tab === "tutor" && modelBusy)}
            onClick={() => void submit()}
          >
            {busy ? <span className="small-spinner" /> : <ArrowUp size={18} />}
          </button>
        </div>
        <div className="composer-hint">
          {dictating
            ? "Listening · microphone active"
            : tab === "tutor"
              ? config.model === "auto-local"
                ? "Auto · local · Qwen 3.8 / 3.6"
                : `${config.cloud ? "Cloud" : "Local"} · ${config.model}`
              : "Draft kept on this device"}
          <span>⌘ ↵ to {tab === "tutor" ? "ask" : "save"}</span>
        </div>
        {tab === "tutor" && config.cloud && (
          <p className="model-notice">
            The selected page, question, recent reasoning, and relevant vault
            passages will be sent to{" "}
            {config.provider === "openai" ? "OpenAI" : "Ollama Cloud"}.
          </p>
        )}
      </div>
      <div className="notebook-bottom">
        <button disabled={busy} onClick={() => void prompt("synthesize")}>
          <Flag size={13} /> Synthesis checkpoint
        </button>
        <button disabled={busy} onClick={() => void prompt("recall")}>
          Recall prompt <ChevronDown size={12} />
        </button>
      </div>
    </section>
  );
}
