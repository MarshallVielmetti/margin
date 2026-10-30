import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";
import type {
  Artifact,
  NotebookDraft,
  NotebookMode,
  NotebookState,
} from "./types";
import type { NotebookProps } from "./Notebook";
import { api } from "./api";
import { freezeDraft, tutorThreads } from "./notebook-state.mjs";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { AgentActivity } from "./AgentActivity";
import { isTerminalRun, type AgentRun } from "./agent-types";
import { DictationButton, useDictation } from "./useDictation";

export function TutorPane(
  props: NotebookProps & {
    active: boolean;
    draft: NotebookDraft;
    activeThread: string;
    update: (fn: (s: NotebookState) => NotebookState) => void;
    onEditorKey: (
      e: KeyboardEvent<HTMLTextAreaElement>,
      mode: NotebookMode,
    ) => void;
    saveStatus: string;
    pinned: string[];
    excluded: string[];
    onUseInNote: (a: Artifact) => Promise<void>;
  },
) {
  const { session, anchor, draft, active, update, config, onError } = props;
  const input = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    retryKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false),
    [modelBusy, setModelBusy] = useState(false),
    [command, setCommand] = useState("discuss");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const speech = useDictation(onError);
  const threads = tutorThreads(session.artifacts || []);
  const thread =
    threads.find((t) => t.id === props.activeThread) || threads.at(-1);
  const activeRun = runs.some((r) => !isTerminalRun(r));
  const refreshRuns = async () => {
    if (config.features?.agentHarness)
      setRuns(await api<AgentRun[]>(`/sessions/${session.id}/runs`));
  };
  useEffect(() => {
    void refreshRuns().catch((e) => onError(e.message));
  }, [session.id, session.artifacts?.length]);
  useEffect(() => {
    if (!activeRun) return;
    const timer = setInterval(() => void refreshRuns().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [activeRun]);
  useEffect(() => {
    if (!active) speech.stop();
    else {
      if (scroll.current) scroll.current.scrollTop = draft.scroll;
      input.current?.setSelectionRange(draft.start, draft.end);
    }
  }, [active]);
  const write = (text: string) =>
    update((s) => ({ ...s, tutor: freezeDraft(s.tutor, text, anchor) }));
  const ask = async () => {
    if (!draft.text.trim() || busy || modelBusy || activeRun) return;
    setBusy(true);
    speech.stop();
    const submitted = draft.text;
    try {
      retryKey.current ||= crypto.randomUUID();
      if (config.features?.agentHarness) {
        const run = await api<AgentRun>(`/sessions/${session.id}/runs`, {
          text: submitted,
          anchor: draft.anchor || anchor,
          mode: command,
          idempotencyKey: retryKey.current,
          contextOverrides: {
            pinnedEvidenceIds: props.pinned,
            excludedEvidenceIds: props.excluded,
          },
        });
        setRuns((list) => [run, ...list.filter((r) => r.id !== run.id)]);
        update((s) => ({ ...s, activeThread: run.id }));
      } else
        await api(`/sessions/${session.id}/tutor`, {
          text: submitted,
          anchor: draft.anchor || anchor,
          mode: command,
        });
      retryKey.current = null;
      update((s) => ({
        ...s,
        tutor:
          s.tutor.text === submitted
            ? {
                text: "",
                anchor: null,
                start: 0,
                end: 0,
                scroll: 0,
                interim: s.tutor.interim,
              }
            : s.tutor,
      }));
      await props.onChanged();
    } catch (error) {
      onError((error as Error).message);
      await props.onChanged();
    } finally {
      setBusy(false);
    }
  };
  const continueRun = async (run: AgentRun) => {
    const next = await api<AgentRun>(`/runs/${run.id}/continue`, {
      idempotencyKey: crypto.randomUUID(),
      budgets: { maxModelCalls: 8, maxToolCalls: 20, maxSeconds: 240 },
      contextOverrides: {
        pinnedEvidenceIds: props.pinned,
        excludedEvidenceIds: props.excluded,
      },
    });
    setRuns((list) => [next, ...list]);
    update((s) => ({ ...s, activeThread: next.id }));
    await props.onChanged();
  };
  const run =
    runs.find((r) => r.id === thread?.id) ||
    runs.find((r) => !isTerminalRun(r));
  return (
    <div
      id="panel-tutor"
      role="tabpanel"
      aria-labelledby="tab-tutor"
      hidden={!active}
      className="notebook-pane tutor-pane"
    >
      {threads.length > 0 && (
        <div className="thread-selector">
          <label>
            Question
            <select
              aria-label="Tutor question thread"
              value={thread?.id || ""}
              onChange={(e) =>
                update((s) => ({ ...s, activeThread: e.target.value }))
              }
            >
              {[...threads].reverse().map((t) => (
                <option key={t.id} value={t.id}>
                  {t.question?.text.slice(0, 95) || "Earlier explanation"}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div
        className="tutor-conversation"
        ref={scroll}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          update((s) => ({ ...s, tutor: { ...s.tutor, scroll: top } }));
        }}
      >
        {!thread && !run && (
          <p className="notebook-empty">
            Ask about the passage, work through a proof, or check an assumption.
          </p>
        )}
        {thread?.question && (
          <article className="tutor-question">
            <span className="authorship">You asked</span>
            <Markdown text={thread.question.text} onNote={props.onNote} />
            {thread.question.anchor && (
              <button
                className="anchor-link"
                onClick={() => props.onAnchor(thread.question!.anchor!)}
              >
                Page {thread.question.anchor.page} ·{" "}
                {thread.question.anchor.section || "Source passage"}
              </button>
            )}
          </article>
        )}
        {thread?.answers.map((answer) => (
          <article className="tutor-answer" key={answer.id}>
            <div className="answer-heading">
              <span className="authorship">
                {answer.origin === "tool"
                  ? "Source extraction"
                  : `AI · ${answer.cloud || answer.provider === "openai" ? "Cloud" : "Local"} · ${answer.model || "Tutor"}`}
              </span>
              <button
                className="text-button"
                onClick={() => {
                  const selection = window.getSelection();
                  const selected = selection?.toString().trim();
                  const element = selection?.anchorNode?.parentElement;
                  void props.onUseInNote(
                    selected && element?.closest(`[data-answer="${answer.id}"]`)
                      ? { ...answer, selectedText: selected }
                      : answer,
                  );
                }}
              >
                Use in note{props.config.synthesis?.cloud ? " · Cloud" : ""}
              </button>
            </div>
            <div data-answer={answer.id}>
              <Markdown
                text={answer.text}
                onNote={props.onNote}
                evidence={
                  config.features?.citations === false
                    ? undefined
                    : answer.evidence?.filter((e) => e.loadedInPrompt !== false)
                }
                citationContext={{
                  vaultRoot: config.vault.root,
                  vaultId: config.vaultId,
                  bridge: config.bridge,
                  sourceId: answer.anchor?.sourceId || session.sourceId,
                }}
                onAnchor={props.onAnchor}
              />
            </div>
            {answer.runStatus && answer.runStatus !== "completed" && (
              <p className="notebook-error">
                {answer.runStatus} · incomplete answer
              </p>
            )}
            <details className="answer-details">
              <summary>
                Answer details · {answer.evidence?.length || 0} passages
              </summary>
              <p>
                {answer.origin === "tool"
                  ? "Extracted from the source."
                  : "AI-assisted explanation · source verification and understanding remain separate."}
              </p>
              {answer.routing && (
                <p>
                  Auto · local: {answer.routing.reason}
                  {answer.routing.fallback ? " (fallback)" : ""}
                </p>
              )}
              {answer.retrievalWarning && <p>{answer.retrievalWarning}</p>}
              {answer.evidence?.map((e) => (
                <div key={e.id}>
                  <strong>
                    {e.title}
                    {e.page ? ` · page ${e.page}` : ""}
                  </strong>
                  <p>{e.text.slice(0, 800)}</p>
                  {e.path && (
                    <button onClick={() => props.onNote(e.path!)}>
                      Open note
                    </button>
                  )}
                </div>
              ))}
              {answer.referenceResults?.map((r) => (
                <p key={r.label}>
                  [{r.label}] {r.status} ·{" "}
                  {r.reason ||
                    r.metadataMatch?.status ||
                    "Full text requires a separate read."}
                </p>
              ))}
            </details>
          </article>
        ))}
        {run && (
          <AgentActivity
            key={run.id}
            run={run}
            onChanged={async () => {
              await props.onChanged();
              await refreshRuns();
            }}
            onContinue={continueRun}
            onError={onError}
            compact
          />
        )}
      </div>
      <div className="writing-area tutor-writing">
        <div className="draft-scope">
          <span>Ask · page {draft.anchor?.page || anchor.page}</span>
          <button
            className="text-button"
            onClick={() =>
              update((s) => ({
                ...s,
                tutor: { ...s.tutor, anchor: structuredClone(anchor) },
              }))
            }
          >
            Use current selection
          </button>
        </div>
        {draft.anchor?.quote && (
          <details className="composer-selection">
            <summary>Attached passage</summary>
            <blockquote>{draft.anchor.quote.slice(0, 650)}</blockquote>
          </details>
        )}
        <textarea
          ref={input}
          data-notebook-editor="tutor"
          aria-label="Ask the tutor"
          placeholder="What would you like to understand?"
          value={draft.text}
          onChange={(e) => write(e.target.value)}
          onSelect={(e) => {
            const el = e.currentTarget;
            update((s) => ({
              ...s,
              tutor: {
                ...s.tutor,
                start: el.selectionStart,
                end: el.selectionEnd,
              },
            }));
          }}
          onCompositionStart={() =>
            update((s) => ({
              ...s,
              tutor: {
                ...s.tutor,
                anchor: s.tutor.anchor || structuredClone(anchor),
              },
            }))
          }
          onKeyDown={(e) => {
            if (
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter"
            ) {
              e.preventDefault();
              void ask();
            } else props.onEditorKey(e, "tutor");
          }}
        />
        {draft.interim && (
          <div className="dictation-interim">
            <span>Unfinished dictation: {draft.interim}</span>
            <button
              onClick={() => {
                write(draft.text + (draft.text ? " " : "") + draft.interim);
                update((s) => ({ ...s, tutor: { ...s.tutor, interim: "" } }));
              }}
            >
              Keep
            </button>
            <button
              onClick={() =>
                update((s) => ({ ...s, tutor: { ...s.tutor, interim: "" } }))
              }
            >
              Discard
            </button>
          </div>
        )}
        <ModelPicker
          config={config}
          disabled={busy || activeRun}
          onChanged={props.onChanged}
          onError={onError}
          onBusyChange={setModelBusy}
        />
        <div className="writing-actions">
          <DictationButton
            active={speech.active}
            onClick={() => {
              update((s) => ({
                ...s,
                tutor: {
                  ...s.tutor,
                  anchor: s.tutor.anchor || structuredClone(anchor),
                },
              }));
              speech.start(
                (text) =>
                  update((s) => ({
                    ...s,
                    tutor: {
                      ...s.tutor,
                      text: s.tutor.text + (s.tutor.text ? " " : "") + text,
                      anchor: s.tutor.anchor || structuredClone(anchor),
                    },
                  })),
                (text) =>
                  update((s) => ({
                    ...s,
                    tutor: { ...s.tutor, interim: text },
                  })),
              );
            }}
          />
          <select
            aria-label="Tutor command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          >
            <option value="discuss">Answer directly</option>
            <option value="recall">Recall practice</option>
            <option value="assumptions">Check assumptions</option>
            <option value="proof">Proof hint</option>
            <option value="connect">Connections</option>
            {config.features?.agentHarness && (
              <option value="investigate">Investigate</option>
            )}
          </select>
          <span className="provider-destination">
            {config.cloud ? "Cloud" : "Local"}
          </span>
          <button
            className="primary"
            disabled={busy || activeRun || modelBusy || !draft.text.trim()}
            onClick={() => void ask()}
          >
            Ask <ArrowUp size={15} />
          </button>
        </div>
        <div className="writing-status" role="status">
          {props.saveStatus}
        </div>
      </div>
    </div>
  );
}
