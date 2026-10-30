import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Download, ExternalLink, Sparkles, Undo2 } from "lucide-react";
import type {
  DocumentView,
  NotebookMode,
  NotebookState,
  SynthesisSuggestion,
} from "./types";
import type { NotebookProps } from "./Notebook";
import { api, obsidianUrl } from "./api";
import { DEFAULT_ORGANIZATION_MODEL } from "./model-defaults.mjs";
import { Markdown } from "./Markdown";
import { synthesisTabAction } from "./notebook-state.mjs";
import { useLiteratureEditor } from "./useLiteratureEditor";
import { DictationButton, useDictation } from "./useDictation";

export function SynthesisPane(
  props: NotebookProps & {
    active: boolean;
    view: DocumentView | null;
    onView: (view: DocumentView) => void;
    refresh: () => Promise<DocumentView>;
    position: NotebookState["synthesis"];
    update: (fn: (s: NotebookState) => NotebookState) => void;
    onEditorKey: (
      e: KeyboardEvent<HTMLTextAreaElement>,
      mode: NotebookMode,
    ) => void;
  },
) {
  const { view, active, onError } = props;
  const synthesis = props.config.synthesis || {
    provider: "ollama",
    model: DEFAULT_ORGANIZATION_MODEL,
    cloud: false,
  };
  const editor = useLiteratureEditor(view, props.onView, onError);
  const nativeEscape = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    focusedSuggestion = useRef<string | null>(null);
  const [preview, setPreview] = useState(false),
    [connecting, setConnecting] = useState(false),
    [path, setPath] = useState(""),
    [create, setCreate] = useState(false),
    [syncEnabled, setSyncEnabled] = useState(false),
    [method, setMethod] = useState<"bridge" | "closed-note">("bridge");
  const [busy, setBusy] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [interim, setInterim] = useState(""),
    [recoveryText, setRecoveryText] = useState("");
  const [resolutions, setResolutions] = useState<Record<number, string>>({});
  const speech = useDictation(onError);
  const doc = view?.document;
  const running = view?.run?.status === "running";
  const suggestions =
    view?.suggestions.filter((s) => s.status === "pending") || [];
  useEffect(() => {
    if (!active) speech.stop();
    else {
      setPreview(false);
      if (scroller.current) scroller.current.scrollTop = props.position.scroll;
      input.current?.setSelectionRange(
        props.position.start,
        props.position.end,
      );
    }
  }, [active, doc?.id]);
  useEffect(() => {
    if (!doc) return;
    try {
      setInterim(
        localStorage.getItem(`margin-document-interim:${doc.id}`) || "",
      );
    } catch {
      /* no interim */
    }
  }, [doc?.id]);
  useEffect(() => {
    setResolutions({});
  }, [doc?.conflict?.externalHash]);
  useEffect(() => {
    if (editor.recovery) setRecoveryText(editor.text);
  }, [editor.recovery]);
  useEffect(() => {
    const el = input.current?.closest(".working-notebook");
    const focus = () => {
      if (active) setPreview(false);
    };
    el?.addEventListener("margin-focus-writing", focus);
    return () => el?.removeEventListener("margin-focus-writing", focus);
  }, [active, doc?.id]);
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      if (live) void props.refresh().catch(() => {});
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running]);
  // Coalesce completed captures. No generation on keystrokes, provider changes, or an idle reload.
  const captureSignature =
    props.session.artifacts
      ?.filter(
        (a) =>
          a.origin === "user" &&
          (a.kind !== "question" || a.surface === "thoughts"),
      )
      .map((a) => `${a.id}:${a.revision || 0}`)
      .join(",") || "";
  const previousCaptures = useRef(captureSignature),
    lastAutomatic = useRef(0);
  useEffect(() => {
    const changed = previousCaptures.current !== captureSignature;
    previousCaptures.current = captureSignature;
    if (!changed || !doc?.organizeAsRead || running || synthesis.cloud) return;
    const timer = setTimeout(() => {
      if (Date.now() - lastAutomatic.current < 10000) return;
      lastAutomatic.current = Date.now();
      void organize(false, true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [captureSignature, doc?.organizeAsRead, synthesis.cloud]);
  const command = async (suffix: string, body: unknown) => {
    if (!doc) return;
    setBusy(true);
    try {
      await editor.flush();
      if (editor.current.current !== editor.base.current?.markdown)
        throw new Error(
          "Save or resolve your local draft before changing the document.",
        );
      const input =
        body && typeof body === "object" && "expectedRevision" in body
          ? { ...body, expectedRevision: editor.base.current?.revision }
          : body;
      const next = await api<DocumentView>(
        `/documents/${doc.id}/${suffix}`,
        input,
      );
      props.onView(next);
      if (
        ["undo", "accept-section"].includes(suffix) &&
        next.document.syncEnabled
      )
        props.onView(await api<DocumentView>(`/documents/${doc.id}/sync`, {}));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const organize = async (cloud = synthesis.cloud, background = false) => {
    if (!doc || running) return;
    try {
      await editor.flush();
      if (editor.current.current !== editor.base.current?.markdown)
        throw new Error(
          "Save or resolve your local draft before organizing it.",
        );
      await api(`/documents/${doc.id}/organize`, {
        retryKey: crypto.randomUUID(),
        cloud,
        background,
      });
      if (!background) await props.onChanged();
      await props.refresh();
    } catch (error) {
      if (!background) onError((error as Error).message);
    }
  };
  const exportMarkdown = () => {
    const url = URL.createObjectURL(
      new Blob([editor.text], { type: "text/markdown;charset=utf-8" }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download =
      doc?.notePath.split("/").pop() ||
      props.source.title.replace(/[\/:*?"<>|]/g, "-") + ".md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const review = async (
    suggestion: SynthesisSuggestion,
    action: "accept" | "dismiss",
    text?: string,
  ) => {
    if (!doc) return;
    await editor.flush();
    if (editor.current.current !== editor.base.current?.markdown)
      throw new Error(
        "Save or resolve the local draft before reviewing this suggestion.",
      );
    const next = await api<DocumentView>(
      `/documents/${doc.id}/suggestions/${suggestion.id}`,
      { action, expectedRevision: editor.base.current?.revision, text },
    );
    props.onView(next);
    if (action === "accept" && next.document.syncEnabled)
      props.onView(await api<DocumentView>(`/documents/${doc.id}/sync`, {}));
  };
  const connect = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      await editor.flush();
      if (editor.current.current !== editor.base.current?.markdown)
        throw new Error(
          "Save or resolve your local draft before connecting a note.",
        );
      const next = await api<DocumentView>(`/documents/${doc.id}/connect`, {
        path,
        create,
        syncEnabled,
        syncMethod: method,
        expectedRevision: editor.base.current?.revision,
      });
      props.onView(next);
      setConnecting(false);
      if (syncEnabled)
        props.onView(await api<DocumentView>(`/documents/${doc.id}/sync`, {}));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => {
    if (!doc?.conflict) return;
    let text = doc.conflict.text;
    for (let i = doc.conflict.conflicts.length - 1; i >= 0; i--) {
      const block = doc.conflict.conflicts[i];
      text =
        text.slice(0, block.start) +
        (resolutions[i] ?? block.local) +
        text.slice(block.end);
    }
    await command("resolve", {
      markdown: text,
      expectedRevision: doc.revision,
      externalHash: doc.conflict.externalHash,
    });
  };
  const renderSuggestion = (suggestion: SynthesisSuggestion) => (
    <Suggestion
      key={suggestion.id}
      suggestion={suggestion}
      onReview={review}
      onError={onError}
      onAnchor={props.onAnchor}
      onNote={props.onNote}
      onFocus={(id) => (focusedSuggestion.current = id)}
    />
  );
  const readingView = () => {
    const items = [...suggestions].sort((a, b) => a.target.end - b.target.end);
    let cursor = 0;
    const nodes = [];
    for (const suggestion of items) {
      const end =
        suggestion.baseRevision === doc?.revision ? suggestion.target.end : -1;
      if (end < cursor || end < 0) continue;
      nodes.push(
        <Markdown
          note
          noteTitle={doc?.title}
          key={`text-${suggestion.id}`}
          text={editor.text.slice(cursor, end)}
          onNote={props.onNote}
          onAnchor={props.onAnchor}
        />,
      );
      nodes.push(renderSuggestion(suggestion));
      cursor = end;
    }
    nodes.push(
      <Markdown
        note
        noteTitle={doc?.title}
        key="remaining"
        text={editor.text.slice(cursor)}
        onNote={props.onNote}
        onAnchor={props.onAnchor}
      />,
    );
    return nodes;
  };
  return (
    <div
      id="panel-synthesis"
      role="tabpanel"
      aria-labelledby="tab-synthesis"
      hidden={!active}
      className="notebook-pane synthesis-pane"
    >
      {!view || !doc ? (
        <p className="pane-loading">Opening literature note…</p>
      ) : (
        <>
          <div className="document-heading">
            <div>
              <h3>{doc.title}</h3>
              <span>{doc.notePath || "Local literature draft"}</span>
            </div>
            {doc.notePath && (
              <a
                className="icon-button"
                title="Open in Obsidian"
                aria-label="Open in Obsidian"
                href={obsidianUrl(
                  doc.vaultId,
                  doc.notePath,
                  props.config.bridge,
                )}
              >
                <ExternalLink size={16} />
              </a>
            )}
          </div>
          <div className="document-toolbar">
            <div className="mini-segmented">
              <button
                className={!preview ? "active" : ""}
                data-edit-note
                onClick={() => setPreview(false)}
              >
                Markdown
              </button>
              <button
                className={preview ? "active" : ""}
                onClick={() => setPreview(true)}
              >
                Read
              </button>
            </div>
            <span
              className={`document-status ${editor.status === "Conflict" ? "conflict" : ""}`}
              role="status"
            >
              {editor.status}
            </span>
            <details className="document-menu">
              <summary>Note options</summary>
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
                    setPath(doc.notePath);
                    setSyncEnabled(doc.syncEnabled);
                    setMethod(doc.syncMethod);
                    setConnecting(true);
                  }}
                >
                  {doc.notePath
                    ? "Connection & relink"
                    : "Connect literature note"}
                </button>
                {doc.notePath && (
                  <button onClick={() => void command("sync", {})}>
                    Sync now
                  </button>
                )}
                <button onClick={exportMarkdown}>
                  <Download size={14} /> Export Markdown
                </button>
                <button onClick={() => setShowHistory(!showHistory)}>
                  <Undo2 size={14} /> Revision history
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={doc.organizeAsRead}
                    disabled={synthesis.cloud}
                    onChange={(e) =>
                      void command("preferences", {
                        organizeAsRead: e.target.checked,
                      })
                    }
                  />{" "}
                  Organize as I read · local only
                </label>
                {synthesis.cloud && (
                  <p>
                    Automatic organization is paused while a cloud model is
                    selected.
                  </p>
                )}
                <button onClick={props.onSettings}>
                  Choose synthesis model in Settings
                </button>
              </div>
            </details>
          </div>
          <div
            className="document-content"
            ref={scroller}
            onScroll={(e) => {
              const top = e.currentTarget.scrollTop;
              props.update((s) => ({
                ...s,
                synthesis: { ...s.synthesis, scroll: top },
              }));
            }}
          >
            {connecting && (
              <div className="note-connection">
                <h4>Connect once, continue here</h4>
                <label>
                  Vault note path
                  <input
                    aria-label="Literature note path"
                    placeholder="Literature/Paper.md"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={create}
                    onChange={(e) => setCreate(e.target.checked)}
                  />{" "}
                  Create a new note / restore a missing note
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={syncEnabled}
                    onChange={(e) => setSyncEnabled(e.target.checked)}
                  />{" "}
                  Sync direct edits and accepted changes automatically
                </label>
                {syncEnabled && (
                  <label>
                    Obsidian coordination
                    <select
                      value={method}
                      onChange={(e) =>
                        setMethod(e.target.value as typeof method)
                      }
                    >
                      <option value="bridge">
                        Coordinate through Margin bridge
                      </option>
                      <option value="closed-note">
                        I will keep this note closed in Obsidian
                      </option>
                    </select>
                  </label>
                )}
                <button
                  className="primary"
                  disabled={busy || !path.trim()}
                  onClick={() => void connect()}
                >
                  Connect note
                </button>
                <button onClick={() => setConnecting(false)}>Cancel</button>
              </div>
            )}
            {editor.recovery && (
              <div className="notebook-error">
                <h4>Recover concurrent edits</h4>
                <p>
                  Your browser draft overlaps a newer local revision. Edit the
                  recovered text below, then save the resolved wording. Both
                  originals remain available.
                </p>
                <details>
                  <summary>Your browser draft</summary>
                  <pre>{editor.recovery.local}</pre>
                </details>
                <details>
                  <summary>Newer document</summary>
                  <pre>{editor.recovery.remote}</pre>
                </details>
                <textarea
                  aria-label="Resolve browser draft"
                  value={recoveryText}
                  onChange={(e) => setRecoveryText(e.target.value)}
                />
                <button onClick={() => editor.recover(recoveryText)}>
                  Save resolved wording
                </button>
                <button onClick={exportMarkdown}>Export recovered draft</button>
              </div>
            )}
            {doc.syncError && (
              <div className="notebook-error">
                <p>{doc.syncError}</p>
                <button onClick={() => void command("sync", {})}>
                  Retry sync
                </button>
                <button
                  onClick={() => {
                    setPath(doc.notePath);
                    setConnecting(true);
                  }}
                >
                  Relink / restore
                </button>
              </div>
            )}
            {doc.conflict && (
              <div className="document-conflicts">
                <h4>Resolve overlapping edits</h4>
                <p>
                  Changes elsewhere have been merged. Choose the wording for
                  each conflicting block.
                </p>
                {doc.conflict.conflicts.map((block, index) => (
                  <div className="conflict-block" key={index}>
                    <details>
                      <summary>Base version</summary>
                      <pre>{block.base}</pre>
                    </details>
                    <div className="conflict-versions">
                      <div>
                        <strong>Margin</strong>
                        <pre>{block.local}</pre>
                        <button
                          onClick={() =>
                            setResolutions((r) => ({
                              ...r,
                              [index]: block.local,
                            }))
                          }
                        >
                          Use Margin wording
                        </button>
                      </div>
                      <div>
                        <strong>Obsidian</strong>
                        <pre>{block.remote}</pre>
                        <button
                          onClick={() =>
                            setResolutions((r) => ({
                              ...r,
                              [index]: block.remote,
                            }))
                          }
                        >
                          Use Obsidian wording
                        </button>
                      </div>
                    </div>
                    <textarea
                      aria-label={`Resolve conflicting block ${index + 1}`}
                      value={resolutions[index] ?? block.local}
                      onChange={(e) =>
                        setResolutions((r) => ({
                          ...r,
                          [index]: e.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void resolve()}
                >
                  Save resolved blocks
                </button>
              </div>
            )}
            {!editor.text && !editor.recovery && (
              <div className="notebook-empty">
                <p>
                  Build your literature note as you read. Write freely, or
                  organize your captured thoughts.
                </p>
                <button
                  onClick={() =>
                    editor.write(
                      "## Summary\n\n## Understanding\n\n## Connections\n\n## Open questions\n",
                    )
                  }
                >
                  Start with four headings
                </button>
                {!doc.notePath && props.config.vault.root && (
                  <button onClick={() => setConnecting(true)}>
                    Connect existing literature note
                  </button>
                )}
              </div>
            )}
            {preview ? (
              <div className="document-reading-view">{readingView()}</div>
            ) : (
              <textarea
                ref={input}
                data-notebook-editor="synthesis"
                className="literature-editor"
                aria-label="Edit literature note Markdown"
                spellCheck={false}
                rows={Math.max(18, editor.text.split("\n").length + 2)}
                value={editor.text}
                readOnly={!!doc.conflict || !!editor.recovery}
                placeholder="Write your understanding here…"
                onChange={(e) => editor.write(e.target.value)}
                onSelect={(e) => {
                  const el = e.currentTarget;
                  props.update((s) => ({
                    ...s,
                    synthesis: {
                      ...s.synthesis,
                      start: el.selectionStart,
                      end: el.selectionEnd,
                    },
                  }));
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Escape") nativeEscape.current = true;
                  if (e.key === "Tab" && nativeEscape.current) {
                    nativeEscape.current = false;
                    props.onEditorKey(e, "synthesis");
                    return;
                  }
                  if (e.key !== "Escape") nativeEscape.current = false;
                  if (e.key === "Tab") {
                    const result = synthesisTabAction(
                      editor.text,
                      e.currentTarget.selectionStart,
                      e.currentTarget.selectionEnd,
                      e.shiftKey,
                    );
                    if (result) {
                      e.preventDefault();
                      editor.write(result.text);
                      requestAnimationFrame(() =>
                        input.current?.setSelectionRange(
                          result.start,
                          result.end,
                        ),
                      );
                      return;
                    }
                  }
                  props.onEditorKey(e, "synthesis");
                }}
              />
            )}
            {suggestions.length > 1 &&
              [...new Set(suggestions.map((s) => s.target.section))].map(
                (section) => {
                  const group = suggestions.filter(
                    (s) => s.target.section === section,
                  );
                  return (
                    group.length > 1 && (
                      <button
                        className="secondary"
                        key={section}
                        disabled={busy}
                        onClick={() =>
                          void command("accept-section", {
                            suggestionIds: group.map((s) => s.id),
                            expectedRevision: editor.base.current?.revision,
                          })
                        }
                      >
                        Keep {group.length} changes in {section}
                      </button>
                    )
                  );
                },
              )}
            {!preview && suggestions.length > 0 && (
              <div className="inline-suggestions">
                {suggestions.map(renderSuggestion)}
              </div>
            )}
            {interim && (
              <div className="dictation-interim">
                <span>Unfinished dictation: {interim}</span>
                <button
                  onClick={() => {
                    editor.write(editor.current.current + " " + interim);
                    setInterim("");
                    localStorage.removeItem(
                      `margin-document-interim:${doc.id}`,
                    );
                  }}
                >
                  Keep
                </button>
                <button
                  onClick={() => {
                    setInterim("");
                    localStorage.removeItem(
                      `margin-document-interim:${doc.id}`,
                    );
                  }}
                >
                  Discard
                </button>
              </div>
            )}
            {view.pending.length > 0 && (
              <details className="pending-material">
                <summary>Pending material · {view.pending.length}</summary>
                {view.pending.map((a) => (
                  <div key={a.id}>
                    <Markdown text={a.text} onNote={props.onNote} />
                    <button
                      className="text-button"
                      onClick={() =>
                        void command("reconsider", {
                          artifactRevisionId: a.artifactRevisionId,
                        })
                      }
                    >
                      Reconsider in next pass
                    </button>
                  </div>
                ))}
              </details>
            )}
            {view.suggestions.some((s) =>
              ["dismissed", "stale"].includes(s.status),
            ) && (
              <details className="pending-material">
                <summary>Dismissed & stale suggestions</summary>
                {view.suggestions
                  .filter((s) => ["dismissed", "stale"].includes(s.status))
                  .map((s) => (
                    <div key={s.id}>
                      <small>
                        {s.status} · {s.target.section}
                      </small>
                      <p>{s.text}</p>
                      <button
                        onClick={() =>
                          void command("reconsider", {
                            artifactRevisionId: s.artifactRevisionIds[0],
                          })
                        }
                      >
                        Reconsider material
                      </button>
                    </div>
                  ))}
              </details>
            )}
            {showHistory && (
              <div className="document-history">
                <h4>Revision history</h4>
                {view.revisions.map((r) => (
                  <details key={r.id}>
                    <summary>
                      Revision {r.revision} · {r.attribution.origin} ·{" "}
                      {new Date(r.createdAt).toLocaleString()}
                    </summary>
                    <pre>{r.markdown || "(empty note)"}</pre>
                    {r.parentRevision !== null && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void command("undo", {
                            revisionId: r.id,
                            expectedRevision: editor.base.current?.revision,
                          })
                        }
                      >
                        Undo this change
                      </button>
                    )}
                  </details>
                ))}
              </div>
            )}
            {!doc.legacyOffered && view.pending.length > 0 && (
              <div className="legacy-offer">
                <p>
                  Build from existing annotations. Proposed additions will
                  appear here for review.
                </p>
                <button
                  onClick={() => {
                    void organize();
                    void command("preferences", { legacyOffered: true });
                  }}
                >
                  Build from existing annotations
                  {synthesis.cloud ? " · Cloud" : ""}
                </button>
                <button
                  onClick={() =>
                    void command("preferences", { legacyOffered: true })
                  }
                >
                  Later
                </button>
              </div>
            )}
          </div>
          <div className="synthesis-destination">
            <span>
              {synthesis.cloud ? "Cloud" : "Local"} · {synthesis.model}
            </span>
            <button className="text-button" onClick={props.onSettings}>
              Change model
            </button>
          </div>
          <div className="synthesis-actions">
            <DictationButton
              active={speech.active}
              onClick={() => {
                if (preview) setPreview(false);
                const start =
                    input.current?.selectionStart ??
                    editor.current.current.length,
                  end = input.current?.selectionEnd ?? start;
                let cursor = start,
                  replaceEnd = end;
                speech.start(
                  (text) => {
                    const value = editor.current.current;
                    const insertion =
                      (cursor > 0 && !/\s$/.test(value.slice(0, cursor))
                        ? " "
                        : "") + text;
                    editor.write(
                      value.slice(0, cursor) +
                        insertion +
                        value.slice(replaceEnd),
                    );
                    cursor += insertion.length;
                    replaceEnd = cursor;
                  },
                  (text) => {
                    setInterim(text);
                    localStorage.setItem(
                      `margin-document-interim:${doc.id}`,
                      text,
                    );
                  },
                );
              }}
            />
            {running ? (
              <>
                <span role="status">
                  Organizing · {view.run?.selection.cloud ? "Cloud" : "Local"} ·{" "}
                  {view.run?.selection.model}
                </span>
                <button
                  onClick={() =>
                    void api(`/documents/${doc.id}/organize/cancel`, {})
                      .then(props.refresh)
                      .catch((e) => onError(e.message))
                  }
                >
                  Stop
                </button>
              </>
            ) : (
              <button
                className="secondary"
                disabled={busy || !!doc.conflict || !!editor.recovery}
                onClick={() => void organize()}
              >
                <Sparkles size={15} /> Organize new thoughts
                {synthesis.cloud ? " · Cloud" : ""}
              </button>
            )}
          </div>
          {view.run &&
            ["failed", "interrupted", "stale"].includes(view.run.status) && (
              <p className="synthesis-run-error" role="status">
                {view.run.error ||
                  (view.run.status === "stale"
                    ? "The note changed during organization. Captures are available to reconsider."
                    : "Organization was interrupted. Your note and captures are retained.")}
              </p>
            )}
        </>
      )}
    </div>
  );
}

function Suggestion({
  suggestion,
  onReview,
  onError,
  onAnchor,
  onNote,
  onFocus,
}: {
  suggestion: SynthesisSuggestion;
  onReview: (
    suggestion: SynthesisSuggestion,
    action: "accept" | "dismiss",
    text?: string,
  ) => Promise<void>;
  onError: (message: string) => void;
  onAnchor: NotebookProps["onAnchor"];
  onNote: NotebookProps["onNote"];
  onFocus: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(suggestion.text),
    [busy, setBusy] = useState(false);
  const review = async (action: "accept" | "dismiss") => {
    setBusy(true);
    try {
      await onReview(suggestion, action, editing ? text : undefined);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="synthesis-suggestion"
      tabIndex={0}
      aria-label={`Suggested change in ${suggestion.target.section}`}
      onFocus={() => onFocus(suggestion.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onFocus(null);
      }}
      onKeyDown={(e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          e.key === "Enter" &&
          !e.nativeEvent.isComposing &&
          e.keyCode !== 229 &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          void review("accept");
        }
      }}
    >
      <div className="suggestion-heading">
        <strong>
          {suggestion.operation === "replace" ? "Update" : "Add to"}{" "}
          {suggestion.target.section}
        </strong>
        <span>AI suggestion · unverified</span>
      </div>
      {editing ? (
        <textarea
          aria-label="Edit proposed wording"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <Markdown
          text={text}
          onNote={onNote}
          evidence={suggestion.inspectedEvidence}
          onAnchor={onAnchor}
        />
      )}
      <details>
        <summary>Inputs & evidence</summary>
        <p>{suggestion.rationale}</p>
        {suggestion.inputs.map((a) => (
          <div key={a.id}>
            <small>
              {a.origin === "user"
                ? "Researcher wording"
                : "AI explanation · unverified"}
            </small>
            <p>{a.text}</p>
            {a.anchor && (
              <button onClick={() => onAnchor(a.anchor!)}>
                Source · page {a.anchor.page}
              </button>
            )}
          </div>
        ))}
        {suggestion.inspectedEvidence.map((e) => (
          <blockquote key={e.id}>
            {e.text}
            <small>
              {e.title} · {e.page ? "page " + e.page : "note passage"}
            </small>
          </blockquote>
        ))}
        <small>
          {suggestion.selection.cloud ? "Cloud" : "Local"} ·{" "}
          {suggestion.selection.model}
        </small>
      </details>
      <div className="suggestion-actions">
        <button
          className="primary"
          disabled={busy || !text.trim()}
          onClick={() => void review("accept")}
        >
          {editing ? "Keep edited wording" : "Keep"}
        </button>
        <button disabled={busy} onClick={() => setEditing(!editing)}>
          Edit
        </button>
        <button disabled={busy} onClick={() => void review("dismiss")}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
