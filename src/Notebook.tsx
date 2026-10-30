import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Expand, Minimize, Settings2 } from "lucide-react";
import type {
  Anchor,
  Artifact,
  Config,
  DocumentView,
  NotebookMode,
  Session,
  Source,
} from "./types";
import { api } from "./api";
import { useNotebookState } from "./useNotebookState";
import { nextNotebookMode, notebookModes } from "./notebook-state.mjs";
import { ThoughtsPane } from "./ThoughtsPane";
import { TutorPane } from "./TutorPane";
import { SynthesisPane } from "./SynthesisPane";
import { ContextInspector } from "./ContextInspector";
import { RunInspector } from "./RunInspector";
import "./agent.css";

export interface NotebookProps {
  session: Session;
  source: Source;
  anchor: Anchor;
  config: Config;
  onChanged: () => Promise<void>;
  onPromote: (artifacts: Artifact[]) => void;
  onAnchor: (anchor: Anchor) => void;
  onNote: (title: string) => void;
  onError: (message: string) => void;
  onSettings: () => void;
  onWide: () => void;
  wide: boolean;
  composeAction?: {
    mode: NotebookMode;
    nonce: number;
    sourceId: string;
  } | null;
}
export function Notebook(props: NotebookProps) {
  const { session, source, anchor, config, onError } = props;
  const { state, current, update, status, ready } = useNotebookState(
    source.id,
    session.id,
  );
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [inspector, setInspector] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]),
    [excluded, setExcluded] = useState<string[]>([]);
  const [dataBusy, setDataBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const nativeTab = useRef(false),
    shell = useRef<HTMLElement>(null);
  const labels: Record<NotebookMode, string> = {
    thoughts: "Thoughts",
    tutor: "Tutor",
    synthesis: "Synthesis",
  };
  const refreshDocument = async () => {
    const next = document
      ? await api<DocumentView>(`/documents/${document.document.id}`)
      : await api<DocumentView>(`/sources/${source.id}/notebook`);
    setDocument(next);
    return next;
  };
  useEffect(() => {
    let live = true;
    void api<DocumentView>(`/sources/${source.id}/notebook`)
      .then((next) => {
        if (live) setDocument(next);
      })
      .catch((e) => onError(e.message));
    return () => {
      live = false;
    };
  }, [source.id]);
  const chooseMode = (mode: NotebookMode, focus = true) => {
    update((s) => ({ ...s, mode }));
    if (focus)
      requestAnimationFrame(() =>
        shell.current
          ?.querySelector<HTMLTextAreaElement>(
            `[data-notebook-editor="${mode}"]`,
          )
          ?.focus(),
      );
  };
  useEffect(() => {
    if (props.composeAction?.sourceId === source.id)
      chooseMode(props.composeAction.mode);
  }, [props.composeAction?.nonce]);
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || documentHasDialog()) return;
      const digit =
        event.code.match(/^(?:Digit|Numpad)([123])$/)?.[1] || event.key;
      if (
        event.ctrlKey &&
        event.altKey &&
        !event.metaKey &&
        ["1", "2", "3"].includes(digit)
      ) {
        event.preventDefault();
        chooseMode(notebookModes[Number(digit) - 1]);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "j"
      ) {
        event.preventDefault();
        shell.current?.dispatchEvent(new Event("margin-focus-writing"));
        requestAnimationFrame(() =>
          shell.current
            ?.querySelector<HTMLTextAreaElement>(
              `[data-notebook-editor="${current.current.mode}"]`,
            )
            ?.focus(),
        );
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const editorKey = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    mode: NotebookMode,
  ) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      nativeTab.current = true;
      return;
    }
    if (event.key === "Tab") {
      if (nativeTab.current) {
        nativeTab.current = false;
        return;
      }
      if (state.tabCycles) {
        event.preventDefault();
        chooseMode(nextNotebookMode(mode, event.shiftKey));
      }
    } else nativeTab.current = false;
  };
  const useInNote = async (artifact: Artifact) => {
    chooseMode("synthesis");
    if (!document) return;
    try {
      await api(`/documents/${document.document.id}/organize`, {
        retryKey: crypto.randomUUID(),
        artifactIds: [artifact.id],
        cloud: !!config.synthesis?.cloud,
        ...(artifact.selectedText
          ? {
              excerpt: { artifactId: artifact.id, text: artifact.selectedText },
            }
          : {}),
      });
      await refreshDocument();
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const evidence = [
    ...new Map(
      (session.artifacts || [])
        .flatMap((a) => a.evidence || [])
        .map((e) => [e.id, e]),
    ).values(),
  ];
  return (
    <section
      className="notebook working-notebook"
      aria-label="Notebook"
      ref={shell}
    >
      <div className="notebook-title-row">
        <h2>Notebook</h2>
        <div>
          <button
            className="icon-button"
            title={props.wide ? "Restore split view" : "Wider notebook"}
            aria-label={props.wide ? "Restore split view" : "Wider notebook"}
            onClick={props.onWide}
          >
            {props.wide ? <Minimize size={16} /> : <Expand size={16} />}
          </button>
          <button
            className="icon-button"
            aria-label="Notebook preferences and inspector"
            aria-expanded={inspector}
            onClick={() => setInspector(!inspector)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>
      <div className="notebook-mode-strip">
        <div
          role="tablist"
          aria-label="Notebook modes"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const mode =
              event.key === "Home"
                ? "thoughts"
                : event.key === "End"
                  ? "synthesis"
                  : nextNotebookMode(state.mode, event.key === "ArrowLeft");
            chooseMode(mode, false);
            shell.current
              ?.querySelector<HTMLButtonElement>(`#tab-${mode}`)
              ?.focus();
          }}
        >
          {notebookModes.map((mode) => (
            <button
              key={mode}
              id={`tab-${mode}`}
              role="tab"
              aria-selected={state.mode === mode}
              aria-controls={`panel-${mode}`}
              tabIndex={state.mode === mode ? 0 : -1}
              className={state.mode === mode ? "active" : ""}
              onClick={() => chooseMode(mode)}
            >
              {labels[mode]}
            </button>
          ))}
        </div>
        <span
          className="mode-hint"
          title="Tab cycles modes while writing. Escape then Tab leaves the editor. Ctrl+Alt+1/2/3 selects a mode."
        >
          {state.tabCycles ? "Tab to switch" : "Ctrl+Alt+1/2/3"}
        </span>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {labels[state.mode]} mode
      </span>
      {inspector && (
        <div className="notebook-inspector">
          <label>
            <input
              type="checkbox"
              checked={state.tabCycles}
              onChange={(e) =>
                update((s) => ({ ...s, tabCycles: e.target.checked }))
              }
            />{" "}
            Tab cycles notebook modes while writing
          </label>
          <p>
            Escape, then Tab leaves the editor. Ctrl+Alt+1/2/3 selects a mode.
            Cmd/Ctrl+J focuses writing.
          </p>
          <ContextInspector
            evidence={evidence}
            pinned={pinned}
            excluded={excluded}
            onChange={(p, e) => {
              setPinned(p);
              setExcluded(e);
            }}
          />
          {config.features?.agentHarness && (
            <RunInspector
              sessionId={session.id}
              onChanged={props.onChanged}
              onError={onError}
            />
          )}
          <details>
            <summary>Session data</summary>
            <p>
              Deleting session history preserves the shared literature note,
              revisions, suggestions, and provenance.
            </p>
            <button
              disabled={dataBusy}
              onClick={() => {
                setDataBusy(true);
                void api(`/sessions/${session.id}/diagnostics/purge`, {})
                  .then(props.onChanged)
                  .catch((e) => onError(e.message))
                  .finally(() => setDataBusy(false));
              }}
            >
              Clear diagnostics
            </button>
            <button onClick={() => setConfirmDelete(!confirmDelete)}>
              Delete session history…
            </button>
            {confirmDelete && (
              <div className="notebook-error">
                <p>
                  Permanently delete this session’s annotations and tutor
                  history?
                </p>
                <button
                  disabled={dataBusy}
                  onClick={() => {
                    setDataBusy(true);
                    void api(
                      `/sessions/${session.id}/research-history/delete`,
                      {},
                    )
                      .then(props.onChanged)
                      .then(() => setConfirmDelete(false))
                      .catch((e) => onError(e.message))
                      .finally(() => setDataBusy(false));
                  }}
                >
                  Delete history
                </button>
                <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            )}
          </details>
        </div>
      )}
      {!ready && <p className="pane-loading">Recovering notebook…</p>}
      {ready && (
        <>
          <ThoughtsPane
            {...props}
            active={state.mode === "thoughts"}
            draft={state.thoughts}
            update={update}
            onEditorKey={editorKey}
            saveStatus={status}
            onUseInNote={useInNote}
            onCaptured={() => {
              void refreshDocument().catch((e) => onError(e.message));
            }}
          />
          <TutorPane
            {...props}
            active={state.mode === "tutor"}
            draft={state.tutor}
            activeThread={state.activeThread}
            update={update}
            onEditorKey={editorKey}
            saveStatus={status}
            pinned={pinned}
            excluded={excluded}
            onUseInNote={useInNote}
          />
          <SynthesisPane
            {...props}
            active={state.mode === "synthesis"}
            view={document}
            onView={setDocument}
            refresh={refreshDocument}
            position={state.synthesis}
            update={update}
            onEditorKey={editorKey}
          />
        </>
      )}
    </section>
  );
}
function documentHasDialog() {
  return !!window.document.querySelector('[role="dialog"]');
}
