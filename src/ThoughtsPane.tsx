import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, MoreHorizontal } from "lucide-react";
import type {
  Artifact,
  NotebookDraft,
  NotebookMode,
  NotebookState,
} from "./types";
import type { NotebookProps } from "./Notebook";
import { api } from "./api";
import { freezeDraft } from "./notebook-state.mjs";
import { Markdown } from "./Markdown";
import { DictationButton, useDictation } from "./useDictation";

export function ThoughtsPane(
  props: NotebookProps & {
    active: boolean;
    draft: NotebookDraft;
    update: (fn: (s: NotebookState) => NotebookState) => void;
    onEditorKey: (
      e: KeyboardEvent<HTMLTextAreaElement>,
      mode: NotebookMode,
    ) => void;
    saveStatus: string;
    onUseInNote: (a: Artifact) => Promise<void>;
    onCaptured: () => void;
  },
) {
  const { active, draft, anchor, session, update, onError } = props;
  const input = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    captureKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [edited, setEdited] = useState("");
  const [history, setHistory] = useState<{
    id: string;
    revisions: { revision: number; text: string }[];
  } | null>(null);
  const speech = useDictation(onError);
  const thoughts = (session.artifacts || []).filter(
    (a) =>
      a.origin === "user" &&
      (a.kind !== "question" || a.surface === "thoughts"),
  );
  useEffect(() => {
    if (!active) speech.stop();
    else {
      if (scroll.current) scroll.current.scrollTop = draft.scroll;
      const el = input.current;
      el?.setSelectionRange(draft.start, draft.end);
    }
  }, [active]);
  const write = (text: string) =>
    update((s) => ({ ...s, thoughts: freezeDraft(s.thoughts, text, anchor) }));
  const capture = async () => {
    if (busy || !draft.text.trim()) return;
    setBusy(true);
    speech.stop();
    const submitted = draft.text;
    captureKey.current ||= crypto.randomUUID();
    try {
      await api(`/sessions/${session.id}/artifacts`, {
        text: submitted,
        anchor: draft.anchor || anchor,
        kind: "thought",
        surface: "thoughts",
        captureKey: captureKey.current,
      });
      update((s) => ({
        ...s,
        thoughts:
          s.thoughts.text === submitted
            ? {
                text: "",
                anchor: null,
                start: 0,
                end: 0,
                scroll: s.thoughts.scroll,
                interim: s.thoughts.interim,
              }
            : s.thoughts,
      }));
      captureKey.current = null;
      await props.onChanged();
      props.onCaptured();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      id="panel-thoughts"
      role="tabpanel"
      aria-labelledby="tab-thoughts"
      hidden={!active}
      className="notebook-pane thoughts-pane"
    >
      <div
        className="thought-list"
        ref={scroll}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          update((s) => ({ ...s, thoughts: { ...s.thoughts, scroll: top } }));
        }}
      >
        {!thoughts.length && (
          <p className="notebook-empty">
            Select a passage or begin a thought. Your words and source location
            stay together.
          </p>
        )}
        {thoughts.map((a) => (
          <article className="thought-entry" key={a.id}>
            <div className="thought-entry-header">
              <button
                className="anchor-link"
                onClick={() => a.anchor && props.onAnchor(a.anchor)}
              >
                {a.anchor?.scope === "paper"
                  ? "Paper-level thought"
                  : a.anchor
                    ? `${a.anchor.section || "Page " + a.anchor.page}${a.anchor.regions?.length ? " · " + a.anchor.regions.length + " regions" : ""}`
                    : "Paper-level thought"}
              </button>
              <details className="entry-menu">
                <summary aria-label="Annotation actions">
                  <MoreHorizontal size={17} />
                </summary>
                <div
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button")) {
                      const menu = event.currentTarget.closest("details");
                      if (menu) menu.open = false;
                    }
                  }}
                >
                  <button
                    onClick={() => {
                      setEditing(a.id);
                      setEdited(a.text);
                    }}
                  >
                    Edit thought
                  </button>
                  <button onClick={() => void props.onUseInNote(a)}>
                    Use in note{props.config.synthesis?.cloud ? " · Cloud" : ""}
                  </button>
                  <button
                    onClick={() =>
                      void api<{
                        revisions: { revision: number; text: string }[];
                      }>(`/artifacts/${a.id}/revisions`)
                        .then((r) =>
                          setHistory({ id: a.id, revisions: r.revisions }),
                        )
                        .catch((e) => onError(e.message))
                    }
                  >
                    Original & revisions
                  </button>
                  <button onClick={() => props.onPromote([a])}>
                    Create a concept / theorem note…
                  </button>
                  <label>
                    Learning status
                    <select
                      value={a.status}
                      onChange={(e) =>
                        void api(
                          `/artifacts/${a.id}`,
                          { status: e.target.value },
                          "PATCH",
                        )
                          .then(props.onChanged)
                          .catch((e) => onError(e.message))
                      }
                    >
                      <option value="open">Still exploring</option>
                      <option value="revisit">Revisit</option>
                      <option value="understood">I can explain this</option>
                    </select>
                  </label>
                  <button
                    onClick={() =>
                      void api(
                        `/artifacts/${a.id}`,
                        { anchor, expectedRevision: a.revision || 0 },
                        "PATCH",
                      )
                        .then(props.onChanged)
                        .catch((e) => onError(e.message))
                    }
                  >
                    Move to current selection
                  </button>
                </div>
              </details>
            </div>
            {editing === a.id ? (
              <div className="thought-edit">
                <textarea
                  aria-label="Edit thought"
                  value={edited}
                  onChange={(e) => setEdited(e.target.value)}
                />
                <button
                  className="primary"
                  onClick={() =>
                    void api(
                      `/artifacts/${a.id}`,
                      { text: edited, expectedRevision: a.revision || 0 },
                      "PATCH",
                    )
                      .then(props.onChanged)
                      .then(() => setEditing(null))
                      .catch((e) => onError(e.message))
                  }
                >
                  Save revision
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <Markdown text={a.text} onNote={props.onNote} />
            )}
            {history?.id === a.id && (
              <details open className="annotation-history">
                <summary>
                  Retained wording{" "}
                  <button onClick={() => setHistory(null)}>Close</button>
                </summary>
                {history.revisions.length ? (
                  history.revisions
                    .sort((a, b) => a.revision - b.revision)
                    .map((r) => (
                      <div key={r.revision}>
                        <small>
                          {r.revision === 0
                            ? "Original capture"
                            : `Revision ${r.revision}`}
                        </small>
                        <pre>{r.text}</pre>
                      </div>
                    ))
                ) : (
                  <p>This is the original capture.</p>
                )}
              </details>
            )}
          </article>
        ))}
      </div>
      <div className="writing-area">
        <div className="draft-scope">
          <span>
            {draft.anchor?.scope === "paper"
              ? "Paper-level thought"
              : `Thought · page ${draft.anchor?.page || anchor.page}`}
          </span>
          <details>
            <summary>Source</summary>
            <div>
              <button
                onClick={() =>
                  update((s) => ({
                    ...s,
                    thoughts: {
                      ...s.thoughts,
                      anchor: structuredClone(anchor),
                    },
                  }))
                }
              >
                Use current selection
              </button>
              <button
                onClick={() =>
                  update((s) => ({
                    ...s,
                    thoughts: {
                      ...s.thoughts,
                      anchor: {
                        sourceId: session.sourceId,
                        page: 1,
                        quote: "",
                        scope: "paper",
                      },
                    },
                  }))
                }
              >
                Make paper-level
              </button>
              {draft.anchor?.quote && (
                <blockquote>{draft.anchor.quote.slice(0, 500)}</blockquote>
              )}
            </div>
          </details>
        </div>
        <textarea
          ref={input}
          data-notebook-editor="thoughts"
          aria-label="Write a thought"
          placeholder="What are you thinking?"
          value={draft.text}
          onChange={(e) => write(e.target.value)}
          onSelect={(e) => {
            const el = e.currentTarget;
            update((s) => ({
              ...s,
              thoughts: {
                ...s.thoughts,
                start: el.selectionStart,
                end: el.selectionEnd,
              },
            }));
          }}
          onCompositionStart={() =>
            update((s) => ({
              ...s,
              thoughts: {
                ...s.thoughts,
                anchor: s.thoughts.anchor || structuredClone(anchor),
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
              void capture();
            } else props.onEditorKey(e, "thoughts");
          }}
        />
        {draft.interim && (
          <div className="dictation-interim">
            <span>Unfinished dictation: {draft.interim}</span>
            <button
              onClick={() => {
                write(draft.text + (draft.text ? " " : "") + draft.interim);
                update((s) => ({
                  ...s,
                  thoughts: { ...s.thoughts, interim: "" },
                }));
              }}
            >
              Keep
            </button>
            <button
              onClick={() =>
                update((s) => ({
                  ...s,
                  thoughts: { ...s.thoughts, interim: "" },
                }))
              }
            >
              Discard
            </button>
          </div>
        )}
        <div className="writing-actions">
          <DictationButton
            active={speech.active}
            onClick={() => {
              update((s) => ({
                ...s,
                thoughts: {
                  ...s.thoughts,
                  anchor: s.thoughts.anchor || structuredClone(anchor),
                },
              }));
              speech.start(
                (text) =>
                  update((s) => ({
                    ...s,
                    thoughts: {
                      ...s.thoughts,
                      text:
                        s.thoughts.text + (s.thoughts.text ? " " : "") + text,
                      anchor: s.thoughts.anchor || structuredClone(anchor),
                    },
                  })),
                (text) =>
                  update((s) => ({
                    ...s,
                    thoughts: { ...s.thoughts, interim: text },
                  })),
              );
            }}
          />
          <span role="status">{props.saveStatus}</span>
          <button
            className="primary"
            disabled={busy || !draft.text.trim()}
            onClick={() => void capture()}
          >
            Capture <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
