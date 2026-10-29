import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FileText,
  Search,
  Undo2,
  Plus,
} from "lucide-react";
import { diffLines } from "diff";
import { api, obsidianUrl } from "./api";
import type {
  Artifact,
  Config,
  Note,
  Promotion,
  Session,
  Source,
} from "./types";
import { Modal, Spinner, Tag, useSearch } from "./ui";
import { Markdown } from "./Markdown";

export function ImportDialog({
  initialPath,
  onClose,
  onAdded,
  onError,
}: {
  initialPath?: string;
  onClose: () => void;
  onAdded: (s: Source) => Promise<void>;
  onError: (s: string) => void;
}) {
  const [tab, setTab] = useState("vault"),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [q, setQ] = useState(""),
    [kind, setKind] = useState("source-excerpt"),
    [busy, setBusy] = useState("");
  const {
    items: notes,
    loading,
    error,
  } = useSearch<Note>(
    `/notes?q=${encodeURIComponent(q)}${q ? "" : "&type=literature"}`,
  );
  const [attachments, setAttachments] = useState<
    { id: string; title: string; available: boolean; error?: string }[]
  >([]);
  const [notePath, setNotePath] = useState(initialPath || "");
  const [localError, setLocalError] = useState("");
  useEffect(() => {
    if (initialPath) void importNote(initialPath);
  }, [initialPath]);
  async function finish(path: string, attachmentId?: string, noteOnly = false) {
    setBusy("Opening local source…");
    try {
      await onAdded(
        await api<Source>("/sources/from-note", {
          path,
          attachmentId,
          noteOnly,
        }),
      );
      onClose();
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function importNote(path: string) {
    setNotePath(path);
    setLocalError("");
    setBusy("Finding the Zotero PDF…");
    try {
      const choices = await api<typeof attachments>(
        `/zotero/attachments?path=${encodeURIComponent(path)}`,
      );
      setAttachments(choices);
      if (choices.length === 1 && choices[0].available)
        await finish(path, choices[0].id);
      else if (!choices.length)
        setLocalError(
          "No local PDF found. Check the citation key and attachment in Zotero, or open the reading note below.",
        );
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal title="Bring a source to your desk" onClose={onClose}>
      <p className="muted">
        A paper, a passage, or a note you want to think through.
      </p>
      <div className="segmented">
        {[
          ["text", "Paste a passage"],
          ["vault", "Zotero / literature note"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            disabled={!!busy}
          >
            {label}
          </button>
        ))}
      </div>
      {localError && <p className="error-text">{localError}</p>}
      {!busy && notePath && (
        <div className="pick-list">
          {attachments.map((a) => (
            <button
              key={a.id}
              disabled={!a.available}
              onClick={() => void finish(notePath, a.id)}
            >
              <FileText size={18} />
              <span>
                {a.title}
                <small>{a.error || "Open existing Zotero PDF"}</small>
              </span>
            </button>
          ))}
          <button onClick={() => void finish(notePath, undefined, true)}>
            Open reading note only
          </button>
          <button onClick={() => void importNote(notePath)}>
            Retry Zotero lookup
          </button>
        </div>
      )}
      {busy ? (
        <Spinner label={busy} />
      ) : tab === "text" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy("Saving passage…");
            void api<Source>("/sources/text", { title, text, kind })
              .then(onAdded)
              .then(onClose)
              .catch((e) => onError(e.message))
              .finally(() => setBusy(""));
          }}
        >
          <label className="field">
            Source title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="Paper, chapter, or theorem"
            />
          </label>
          <label className="field">
            Provenance
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="source-excerpt">
                Passage copied from an original source
              </option>
              <option value="reading-note">
                My reading notes / transcription
              </option>
            </select>
          </label>
          <label className="field">
            Passage <span className="muted">Markdown and LaTeX supported</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              required
              placeholder="Paste the passage you want to explore…"
            />
          </label>
          <div className="modal-actions">
            <button className="primary" type="submit">
              Open at my desk <ArrowRight size={16} />
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="searchbox">
            <Search size={16} />
            <input
              aria-label="Find a source note"
              placeholder="Find a literature note or concept…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="pick-list">
            {loading ? (
              <Spinner />
            ) : (
              notes.map((n) => (
                <button key={n.path} onClick={() => void importNote(n.path)}>
                  <FileText size={18} />
                  <span>
                    <strong>{n.title}</strong>
                    <small>{n.path}</small>
                  </span>
                  <Plus size={16} />
                </button>
              ))
            )}
            {error && <p className="error-text">{error}</p>}
            {!loading && !notes.length && (
              <p className="muted">
                No matching notes. Connect a vault in Settings.
              </p>
            )}
          </div>
          <p className="fine-print">
            Keep Zotero open with Better BibTeX enabled. PDFs are read directly
            from local storage; no upload or duplicate copy is needed.
          </p>
        </>
      )}
    </Modal>
  );
}

export function PromotionDialog({
  artifacts,
  session,
  config,
  onClose,
  onChanged,
  onError,
}: {
  artifacts: Artifact[];
  session: Session;
  config: Config;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (s: string) => void;
}) {
  const [text, setText] = useState(
      artifacts
        .map(
          (a) =>
            a.text + (a.assumptions ? `\n\nAssumptions: ${a.assumptions}` : ""),
        )
        .join("\n\n"),
    ),
    [mode, setMode] = useState("append"),
    [q, setQ] = useState(""),
    [path, setPath] = useState(""),
    [title, setTitle] = useState(""),
    [heading, setHeading] = useState("Intuition"),
    [noteType, setNoteType] = useState("idea"),
    [links, setLinks] = useState<string[]>([]),
    [draft, setDraft] = useState<Promotion | null>(null),
    [busy, setBusy] = useState(false);
  const { items: notes } = useSearch<Note>(`/notes?q=${encodeURIComponent(q)}`);
  async function prepare() {
    setBusy(true);
    try {
      const d = await api<Promotion>("/promotions", {
        sessionId: session.id,
        artifactIds: artifacts.map((a) => a.id),
        text,
        mode,
        path: mode === "new" ? path || `${title}.md` : path,
        title,
        heading,
        noteType,
        links,
      });
      setDraft(d);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (draft)
    return (
      <PromotionReview
        draft={draft}
        config={config}
        onClose={onClose}
        onChanged={onChanged}
        onError={onError}
        onBack={async () => {
          await api(`/promotions/${draft.id}/discard`, {});
          setDraft(null);
          await onChanged();
        }}
      />
    );
  return (
    <Modal title="Give this insight a home" onClose={onClose} wide>
      <div className="promotion-intro">
        <Tag tone="green">Your words</Tag>
        <span>
          {artifacts.length} captured{" "}
          {artifacts.length === 1 ? "entry" : "entries"} · original history
          preserved
        </span>
      </div>
      <div className="promotion-grid">
        <div>
          <label className="field">
            What belongs in your permanent notes?
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
            />
          </label>
          <p className="fine-print">
            Keep the assumptions, refine your wording, and leave the full
            exploration in your session history.
          </p>
        </div>
        <div>
          <label className="field">
            Destination
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setPath("");
              }}
            >
              <option value="append">Add to an existing note</option>
              <option value="summary">Update a literature summary</option>
              <option value="new">Create a connected note</option>
            </select>
          </label>
          {mode === "new" && (
            <>
              <label className="field">
                New note title
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                Note path
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={`${title || "New insight"}.md`}
                />
              </label>
              <label className="field">
                Note type
                <select
                  value={noteType}
                  onChange={(e) => setNoteType(e.target.value)}
                >
                  <option value="idea">Idea</option>
                  <option value="theorem">Theorem</option>
                  <option value="definition">Definition</option>
                  <option value="MOC">MOC</option>
                  <option value="literature_note">Literature</option>
                </select>
              </label>
            </>
          )}
          <label className="field">
            {mode === "new"
              ? "Connect to existing knowledge"
              : "Find an existing note"}
            <div className="searchbox">
              <Search size={14} />
              <input
                aria-label="Find promotion destination"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search titles and aliases…"
              />
            </div>
          </label>
          <div className="destination-list">
            {notes.slice(0, 8).map((n) => (
              <button
                className={
                  (mode === "new" ? links.includes(n.path) : path === n.path)
                    ? "chosen"
                    : ""
                }
                key={n.path}
                onClick={() =>
                  mode === "new"
                    ? setLinks((v) =>
                        v.includes(n.path)
                          ? v.filter((p) => p !== n.path)
                          : [...v, n.path],
                      )
                    : setPath(n.path)
                }
              >
                <span>
                  <strong>{n.title}</strong>
                  <small>{n.type}</small>
                </span>
                {(mode === "new"
                  ? links.includes(n.path)
                  : path === n.path) && <Check size={15} />}
              </button>
            ))}
          </div>
          {path && mode !== "new" && <p className="selected-path">{path}</p>}
          {mode === "append" && (
            <label className="field">
              Section
              <input
                value={heading}
                onChange={(e) => setHeading(e.target.value)}
              />
            </label>
          )}
          {mode === "summary" && (
            <p className="fine-print">
              Updates the existing Summary section or summary property. Other
              sections are preserved.
            </p>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Keep in notebook
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            !text.trim() ||
            (mode === "new" ? !title.trim() || !links.length : !path)
          }
          onClick={() => void prepare()}
        >
          {busy ? "Preparing…" : "Preview note changes"}
          <ArrowRight size={16} />
        </button>
      </div>
    </Modal>
  );
}

export function PromotionReview({
  draft: initial,
  config,
  onClose,
  onChanged,
  onError,
  onBack,
}: {
  draft: Promotion;
  config: Config;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (s: string) => void;
  onBack?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [full, setFull] = useState(false);
  async function act(action: string) {
    setBusy(true);
    try {
      setDraft(await api<Promotion>(`/promotions/${draft.id}/${action}`, {}));
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const changes = diffLines(draft.before || "", draft.after || "");
  return (
    <Modal
      title={
        draft.status === "applied"
          ? "An insight, connected."
          : "Review your note changes"
      }
      onClose={onClose}
      wide
    >
      <div className="review-header">
        <div>
          <Tag tone={draft.status === "applied" ? "green" : ""}>
            {draft.status}
          </Tag>
          <p>{draft.path}</p>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
          />{" "}
          Show unchanged text
        </label>
      </div>
      <div className="diff" aria-label="Proposed changes">
        {changes.map((part, i) =>
          part.added || part.removed || full ? (
            <pre
              key={i}
              className={
                part.added ? "added" : part.removed ? "removed" : "unchanged"
              }
            >
              <span>{part.added ? "+" : part.removed ? "−" : " "}</span>
              {part.value}
            </pre>
          ) : (
            <div key={i} className="diff-context">
              {part.count} unchanged lines
            </div>
          ),
        )}
      </div>
      <p className="fine-print">
        The original is saved with this promotion. Undo is available while the
        note still matches the applied version.
      </p>
      <div className="modal-actions">
        {draft.status === "draft" ? (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (onBack) void onBack().catch((e) => onError(e.message));
                else onClose();
              }}
            >
              {onBack ? "Back to wording" : "Close preview"}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void act("apply")}
            >
              <Check size={16} />
              {busy ? "Applying…" : "Approve & save to Obsidian"}
            </button>
          </>
        ) : draft.status === "applied" ? (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void act("undo")}
            >
              <Undo2 size={15} />
              Undo this promotion
            </button>
            <a
              className="primary"
              href={obsidianUrl(
                config.vault.root,
                draft.path,
                config.bridge,
                draft.heading,
              )}
            >
              <ExternalLink size={15} />
              Open in Obsidian
            </a>
          </>
        ) : (
          <button className="primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </Modal>
  );
}

export function NoteDialog({
  note,
  config,
  onClose,
  onNote,
  onRead,
  onConnect,
}: {
  note: Note;
  config: Config;
  onClose: () => void;
  onNote: (path: string) => void;
  onRead: (path: string) => void;
  onConnect?: (note: Note) => void;
}) {
  return (
    <Modal title={note.title} onClose={onClose} wide>
      <div className="note-meta">
        <Tag>{note.type}</Tag>
        <span>{note.path}</span>
        <a
          className="text-button"
          href={obsidianUrl(
            config.vault.root,
            note.path,
            config.bridge,
            "",
            note.line || 1,
          )}
        >
          Open in Obsidian <ExternalLink size={13} />
        </a>
      </div>
      <div className="note-preview">
        <Markdown
          text={note.body || note.content || note.excerpt || ""}
          onNote={onNote}
        />
      </div>
      {!!note.backlinks?.length && (
        <details className="backlinks">
          <summary>Referenced in {note.backlinks.length} passages</summary>
          {note.backlinks.slice(0, 20).map((link, i) => (
            <button key={i} onClick={() => onNote(link.path)}>
              {link.title}
              <small>{link.section}</small>
            </button>
          ))}
        </details>
      )}
      <div className="modal-actions">
        {onConnect && (
          <button className="secondary" onClick={() => onConnect(note)}>
            Record a connection
          </button>
        )}
        <button className="primary" onClick={() => onRead(note.path)}>
          Read at my desk <ArrowRight size={15} />
        </button>
      </div>
    </Modal>
  );
}
