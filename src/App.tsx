import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Columns3,
  Compass,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Layers3,
  Library,
  Link2,
  ListFilter,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Sprout,
  X,
} from "lucide-react";
import type {
  Anchor,
  Artifact,
  Bootstrap,
  Config,
  Note,
  NotebookMode,
  Promotion,
  Relationship,
  Session,
  Source,
  View,
} from "./types";
import { api, date, obsidianUrl, setToken } from "./api";
import { Empty, Modal, Spinner, Tag, useSearch } from "./ui";
import { Markdown } from "./Markdown";
import { Notebook } from "./Notebook";
import { ModelPicker } from "./ModelPicker";
import {
  ImportDialog,
  NoteDialog,
  PromotionDialog,
  PromotionReview,
} from "./Dialogs";
const StructuredPdf = lazy(() => import("./StructuredPdf"));
const nav: { id: View; label: string; icon: typeof BookOpen }[] = [
  { id: "desk", label: "Reading desk", icon: BookOpen },
  { id: "library", label: "Source library", icon: Library },
  { id: "vault", label: "Knowledge vault", icon: GitBranch },
  { id: "history", label: "Learning history", icon: History },
  { id: "promotions", label: "Promotions", icon: ArrowUpRight },
];

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [fatal, setFatal] = useState(""),
    [view, setView] = useState<View>("desk"),
    [workspaceId, setWorkspaceId] = useState(""),
    [sessionId, setSessionId] = useState(
      () => new URLSearchParams(location.search).get("session") || "",
    ),
    [session, setSession] = useState<Session | null>(null),
    [source, setSource] = useState<Source | null>(null),
    [anchor, setAnchor] = useState<Anchor | null>(null),
    [toast, setToast] = useState(""),
    [importing, setImporting] = useState(
      !!new URLSearchParams(location.search).get("note"),
    ),
    [importPath, setImportPath] = useState(
      new URLSearchParams(location.search).get("note") || "",
    ),
    [promoting, setPromoting] = useState<Artifact[] | null>(null),
    [review, setReview] = useState<Promotion | null>(null),
    [note, setNote] = useState<Note | null>(null),
    [inspector, setInspector] = useState(false),
    [newWorkspace, setNewWorkspace] = useState(false),
    [checkpoint, setCheckpoint] = useState(false),
    [connection, setConnection] = useState<Note | null>(null),
    [search, setSearch] = useState("");
  const [composeAction, setComposeAction] = useState<{
    mode: NotebookMode;
    nonce: number;
    sourceId: string;
  } | null>(null);
  const [notebookWide, setNotebookWide] = useState(false);
  const [mobilePane, setMobilePane] = useState("notebook");
  const [readerShare, setReaderShare] = useState(
    () => Number(localStorage.getItem("margin-reader-share")) || 52,
  );
  const resizing = useRef(false);
  const pendingCitation = useRef<Anchor | null>(null);
  const booted = useRef(false),
    loadSequence = useRef(0);
  const notify = (message: string) => setToast(message);
  async function refresh() {
    const result = await api<Bootstrap>("/bootstrap");
    setToken(result.token);
    setData(result);
    return result;
  }
  async function refreshSession() {
    await refresh();
    if (sessionId) {
      const result = await api<Session>(`/sessions/${sessionId}`);
      setSession(result);
    }
  }
  useEffect(() => {
    let live = true;
    api<Bootstrap>("/bootstrap")
      .then((result) => {
        if (!live) return;
        setToken(result.token);
        setData(result);
        const requested = new URLSearchParams(location.search).get("session");
        const active =
          result.sessions.find((s) => s.id === requested) || result.sessions[0];
        setWorkspaceId(active?.workspaceId || result.workspaces[0]?.id || "");
        setSessionId(active?.id || "");
        booted.current = true;
      })
      .catch((e) => {
        if (live) setFatal(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!data || !sessionId) return;
    const sequence = ++loadSequence.current;
    setSession(null);
    setSource(null);
    setAnchor(null);
    setComposeAction(null);
    api<Session>(`/sessions/${sessionId}`)
      .then(async (s) => {
        const src = await api<Source>(`/sources/${s.sourceId}`);
        if (sequence !== loadSequence.current) return;
        setSession(s);
        setSource(src);
        let linkedAnchor: Anchor | null = null;
        try {
          const parsed = JSON.parse(
            new URLSearchParams(location.search).get("anchor") || "null",
          );
          if (
            parsed?.sourceId === src.id &&
            Number.isInteger(parsed.page) &&
            parsed.page >= 1 &&
            parsed.page <= src.pageCount
          )
            linkedAnchor = { ...parsed, quote: "" };
        } catch {
          /* An invalid deep link falls back to the saved reading position. */
        }
        if (linkedAnchor && linkedAnchor.page !== s.page) {
          s = { ...s, page: linkedAnchor.page };
          setSession(s);
        }
        setAnchor(
          pendingCitation.current?.sourceId === src.id
            ? pendingCitation.current
            : linkedAnchor || { sourceId: src.id, page: s.page, quote: "" },
        );
        pendingCitation.current = null;
      })
      .catch((e) => {
        if (sequence === loadSequence.current) notify(e.message);
      });
    const url = new URL(location.href);
    url.searchParams.set("session", sessionId);
    history.replaceState(null, "", url);
  }, [sessionId, !!data]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 10000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setView("vault");
        setTimeout(() => document.getElementById("vault-search")?.focus(), 50);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const workspace =
    data?.workspaces.find((w) => w.id === workspaceId) || data?.workspaces[0];
  const currentSessions =
    data?.sessions.filter((s) => s.workspaceId === workspace?.id) || [];
  function chooseSession(s: Session) {
    setWorkspaceId(s.workspaceId);
    setSessionId(s.id);
    setView("desk");
  }
  async function openSource(src: Source) {
    try {
      const existing = data?.sessions.find(
        (s) =>
          s.sourceId === src.id &&
          s.workspaceId === workspace?.id &&
          s.status !== "complete",
      );
      if (existing) {
        chooseSession(existing);
        return;
      }
      const s = await api<Session>("/sessions", {
        sourceId: src.id,
        workspaceId: workspace?.id,
      });
      await refresh();
      chooseSession(s);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function openNote(target: string) {
    try {
      const query = target.replace(/\.md$/i, "");
      if (target.endsWith(".md")) {
        setNote(await api<Note>(`/note?path=${encodeURIComponent(target)}`));
        return;
      }
      const found = await api<Note[]>(`/notes?q=${encodeURIComponent(query)}`);
      const match = found.filter((n) =>
        [
          n.title,
          n.path.replace(/\.md$/i, ""),
          n.path.split("/").pop()?.replace(/\.md$/i, ""),
          ...(n.aliases || []),
        ].some((v) => v?.toLowerCase() === query.toLowerCase()),
      );
      if (match.length !== 1) {
        setNote(null);
        setSearch(query);
        setView("vault");
        notify(
          match.length > 1
            ? "Several notes share this name. Choose the intended note."
            : "Choose the matching concept from your vault.",
        );
        return;
      }
      setNote(
        await api<Note>(`/note?path=${encodeURIComponent(match[0].path)}`),
      );
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function readNote(path: string) {
    setNote(null);
    setImportPath(path);
    setImporting(true);
  }
  async function navigateAnchor(a: Anchor) {
    if (session && a.sourceId !== session.sourceId) {
      try {
        const targetSource = await api<Source>(
          `/sources/${encodeURIComponent(a.sourceId)}`,
        );
        if (a.page < 1 || a.page > targetSource.pageCount)
          throw new Error("This citation page is no longer available.");
        const target =
          data?.sessions.find(
            (item) =>
              item.sourceId === a.sourceId &&
              item.workspaceId === session.workspaceId,
          ) ||
          (await api<Session>("/sessions", {
            sourceId: a.sourceId,
            workspaceId: session.workspaceId,
          }));
        await api(`/sessions/${target.id}`, { page: a.page }, "PATCH");
        pendingCitation.current = a;
        await refresh();
        chooseSession(target);
      } catch (error) {
        notify((error as Error).message);
      }
      return;
    }
    setAnchor(a);
    if (session && a.page !== session.page) {
      setSession({ ...session, page: a.page });
      try {
        await api(`/sessions/${session.id}`, { page: a.page }, "PATCH");
      } catch (e) {
        notify((e as Error).message);
      }
    }
  }
  if (fatal)
    return (
      <div className="boot">
        <Sprout size={36} />
        <h1>Margin couldn’t connect.</h1>
        <p>{fatal}</p>
        <button className="primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="boot">
        <Sprout size={36} />
        <h1>Making room to think.</h1>
        <Spinner label="Opening your research workspace…" />
      </div>
    );
  const drafts = data.promotions.filter((p) => p.status === "draft").length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setView("desk");
          }}
        >
          <div className="brand-mark">
            <Sprout size={24} strokeWidth={1.3} />
          </div>
          <span>
            margin<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-label">YOUR RESEARCH SPACE</div>
        <button
          className="quick-search"
          onClick={() => {
            setView("vault");
            setTimeout(
              () => document.getElementById("vault-search")?.focus(),
              0,
            );
          }}
        >
          <Search size={15} />
          <span>Find something</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
            >
              <item.icon size={18} strokeWidth={1.65} />
              <span>{item.label}</span>
              {item.id === "promotions" && drafts > 0 && (
                <b className="nav-count">{drafts}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section-title">
          <span>RESEARCH INQUIRIES</span>
          <button
            className="icon-button"
            aria-label="Create a research inquiry"
            onClick={() => setNewWorkspace(true)}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="inquiries">
          {data.workspaces.map((w) => (
            <button
              key={w.id}
              className={w.id === workspace?.id ? "selected" : ""}
              onClick={() => {
                setWorkspaceId(w.id);
                const s = data.sessions.find((s) => s.workspaceId === w.id);
                setSessionId(s?.id || "");
                if (!s) {
                  setSession(null);
                  setSource(null);
                }
                setView("desk");
              }}
            >
              <span className="inquiry-dot" />
              {w.title}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-state">
            <span className="status-dot" />
            <span>
              Local workspace
              <small>
                {data.config.vault.count.toLocaleString()} notes indexed
              </small>
            </span>
          </div>
          <button
            className={`settings-nav ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <Settings2 size={17} />
            <span>Settings & connections</span>
          </button>
          <div className="profile">
            <span className="avatar">M</span>
            <div>
              My research<small>A little further, every day.</small>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span>WORKSPACE</span>
            <ChevronRight size={13} />
            <strong>{workspace?.title}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span className="status-dot" />
              Saved on this device
            </span>
            <button
              className="icon-button"
              aria-label="Help and setup"
              onClick={() => setView("settings")}
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        {view === "desk" ? (
          <div className="desk-view">
            <div className="desk-heading">
              <div>
                <span className="eyebrow">READ · REASON · CONNECT</span>
                <h1>Your reading desk</h1>
              </div>
              <div className="desk-actions">
                <button
                  className="secondary"
                  aria-label="Toggle connections"
                  onClick={() => setInspector(!inspector)}
                >
                  <Columns3 size={15} />
                  <span>Connections</span>
                </button>
                <button className="primary" onClick={() => setImporting(true)}>
                  <Plus size={16} />
                  Add source
                </button>
              </div>
            </div>
            {session && source && anchor ? (
              <>
                <div className="session-bar">
                  <div className="session-select">
                    <span className="status-dot" />
                    <select
                      aria-label="Current reading session"
                      value={session.id}
                      onChange={(e) => {
                        const s = data.sessions.find(
                          (s) => s.id === e.target.value,
                        );
                        if (s) chooseSession(s);
                      }}
                    >
                      {currentSessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                    <Tag>
                      {session.status === "complete"
                        ? "Checkpoint saved"
                        : session.status === "paused"
                          ? "Resumed reading"
                          : "In progress"}
                    </Tag>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setCheckpoint(true)}
                  >
                    <Bookmark size={14} />
                    Leave a takeaway
                  </button>
                </div>
                {session.nextStep && (
                  <div className="resume-note">
                    <Clock3 size={14} />
                    <span>
                      <strong>Where you left off:</strong> {session.nextStep}
                    </span>
                  </div>
                )}
                <div
                  className="mobile-pane-switch"
                  role="group"
                  aria-label="Reading desk view"
                >
                  <button
                    aria-pressed={mobilePane === "reader"}
                    onClick={() => setMobilePane("reader")}
                  >
                    Source
                  </button>
                  <button
                    aria-pressed={mobilePane === "notebook"}
                    onClick={() => setMobilePane("notebook")}
                  >
                    Notebook
                  </button>
                </div>
                <div
                  className={`desk-panels redesigned-desk ${inspector ? "with-inspector" : ""} ${notebookWide ? "note-wide" : ""} mobile-${mobilePane}`}
                  style={
                    { "--reader-share": `${readerShare}%` } as CSSProperties
                  }
                >
                  <Reader
                    source={source}
                    session={session}
                    anchor={anchor}
                    onAnchor={(a) => void navigateAnchor(a)}
                    onNote={(t) => void openNote(t)}
                    config={data.config}
                    onRegionAction={(mode) => {
                      setComposeAction({
                        mode,
                        nonce: Date.now(),
                        sourceId: source.id,
                      });
                      setMobilePane("notebook");
                    }}
                  />
                  <div
                    className="desk-divider"
                    role="separator"
                    aria-label="Resize source and notebook"
                    aria-orientation="vertical"
                    aria-valuemin={30}
                    aria-valuemax={70}
                    aria-valuenow={Math.round(readerShare)}
                    tabIndex={0}
                    onPointerDown={(event) => {
                      resizing.current = true;
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!resizing.current) return;
                      const bounds =
                        event.currentTarget.parentElement!.getBoundingClientRect();
                      const next = Math.max(
                        30,
                        Math.min(
                          70,
                          ((event.clientX - bounds.left) / bounds.width) * 100,
                        ),
                      );
                      setReaderShare(next);
                      localStorage.setItem("margin-reader-share", String(next));
                    }}
                    onPointerUp={() => (resizing.current = false)}
                    onPointerCancel={() => (resizing.current = false)}
                    onKeyDown={(event) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      ) {
                        event.preventDefault();
                        const next =
                          event.key === "Home"
                            ? 30
                            : event.key === "End"
                              ? 70
                              : Math.max(
                                  30,
                                  Math.min(
                                    70,
                                    readerShare +
                                      (event.key === "ArrowLeft" ? -3 : 3),
                                  ),
                                );
                        setReaderShare(next);
                        localStorage.setItem(
                          "margin-reader-share",
                          String(next),
                        );
                      }
                    }}
                  />
                  <Notebook
                    key={session.id}
                    session={session}
                    source={source}
                    anchor={anchor}
                    config={data.config}
                    onChanged={refreshSession}
                    onPromote={setPromoting}
                    onAnchor={(a) => void navigateAnchor(a)}
                    onNote={(t) => void openNote(t)}
                    onError={notify}
                    composeAction={composeAction}
                    onSettings={() => setView("settings")}
                    wide={notebookWide}
                    onWide={() => setNotebookWide(!notebookWide)}
                  />
                  {inspector && (
                    <Inspector
                      source={source}
                      anchor={anchor}
                      question={workspace?.question || ""}
                      relationships={data.relationships.filter(
                        (r) => r.sessionId === session.id,
                      )}
                      onNote={(t) => void openNote(t)}
                      onClose={() => setInspector(false)}
                      onPrompt={async (mode) => {
                        try {
                          await api(`/sessions/${session.id}/prompt`, {
                            mode,
                            anchor,
                          });
                          await refreshSession();
                        } catch (e) {
                          notify((e as Error).message);
                        }
                      }}
                    />
                  )}
                </div>
              </>
            ) : sessionId ? (
              <Spinner label="Opening your last reading position…" />
            ) : (
              <div className="desk-empty">
                <div className="desk-empty-art">
                  <BookOpen size={56} strokeWidth={1} />
                  <span className="orbit-dot" />
                  <span className="orbit-dot second" />
                </div>
                <span className="eyebrow">BEGIN WITH A QUESTION</span>
                <h2>
                  What would you like
                  <br />
                  to understand?
                </h2>
                <p>
                  {workspace?.question ||
                    "Bring a source, follow a question, and keep the path your thinking takes."}
                </p>
                <button className="primary" onClick={() => setImporting(true)}>
                  Bring a source to your desk <ArrowRight size={16} />
                </button>
              </div>
            )}
          </div>
        ) : view === "library" ? (
          <div className="page">
            <PageHeading
              eyebrow="A SHELF FOR YOUR CURIOSITY"
              title="Source library"
              description="Original sources and reading notes, with their provenance intact."
              action={
                <button className="primary" onClick={() => setImporting(true)}>
                  <Plus size={16} />
                  Add source
                </button>
              }
            />
            <div className="library-grid">
              {data.sources.map((s, i) => {
                const reading = data.sessions.filter(
                  (x) => x.sourceId === s.id,
                );
                return (
                  <button
                    className="source-card"
                    key={s.id}
                    onClick={() => void openSource(s)}
                  >
                    <div className={`source-cover cover-${i % 3}`}>
                      <div className="cover-number">
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <span>
                        {s.kind === "pdf"
                          ? "PAPER"
                          : s.kind === "reading-note"
                            ? "READING NOTES"
                            : "SOURCE PASSAGE"}
                      </span>
                      <h2>{s.title}</h2>
                      <div className="cover-bottom">
                        <span>{s.authors || "Research source"}</span>
                        <span>{s.year || <BookOpen size={20} />}</span>
                      </div>
                    </div>
                    <div className="source-card-info">
                      <Tag>
                        {s.kind === "reading-note"
                          ? "Your transcription"
                          : s.kind === "pdf"
                            ? "Original PDF"
                            : "Pasted excerpt"}
                      </Tag>
                      <p>
                        {reading.length
                          ? `${reading.length} reading ${reading.length === 1 ? "session" : "sessions"}`
                          : "Ready to explore"}{" "}
                        <ArrowUpRight size={16} />
                      </p>
                    </div>
                  </button>
                );
              })}
              <button
                className="add-source-card"
                onClick={() => setImporting(true)}
              >
                <Plus size={28} strokeWidth={1} />
                <strong>A new starting point</strong>
                <span>PDF, source passage, or vault note</span>
              </button>
            </div>
          </div>
        ) : view === "vault" ? (
          <VaultView
            config={data.config}
            search={search}
            setSearch={setSearch}
            onNote={(t) => void openNote(t)}
            onRefresh={async () => {
              try {
                await api("/reindex", {});
                await refresh();
                notify("Vault index refreshed.");
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          />
        ) : view === "history" ? (
          <HistoryView
            sessions={data.sessions}
            onSession={chooseSession}
            onNote={(t) => void openNote(t)}
          />
        ) : view === "promotions" ? (
          <div className="page">
            <PageHeading
              eyebrow="FROM EXPLORATION TO UNDERSTANDING"
              title="Knowledge, made permanent"
              description="Small, deliberate additions to the notes you already know."
            />
            <div className="stats-line">
              <span>
                <b>{drafts}</b> awaiting review
              </span>
              <span>
                <b>
                  {data.promotions.filter((p) => p.status === "applied").length}
                </b>{" "}
                connected insights
              </span>
            </div>
            {data.promotions.length ? (
              <div className="promotion-list">
                {data.promotions.map((p) => (
                  <button
                    key={p.id}
                    onClick={() =>
                      void api<Promotion>(`/promotions/${p.id}`)
                        .then(setReview)
                        .catch((e) => notify(e.message))
                    }
                  >
                    <div className="row-icon">
                      <ArrowUpRight size={20} />
                    </div>
                    <div>
                      <strong>
                        {p.path.split("/").pop()?.replace(/\.md$/, "")}
                      </strong>
                      <p>
                        {p.text.slice(0, 140)}
                        {p.text.length > 140 ? "…" : ""}
                      </p>
                      <small>
                        {p.mode === "summary"
                          ? "Literature summary"
                          : p.mode === "new"
                            ? "New connected note"
                            : "Addition to existing note"}{" "}
                        · {date(p.createdAt)}
                      </small>
                    </div>
                    <Tag tone={p.status === "applied" ? "green" : ""}>
                      {p.status}
                    </Tag>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                icon={<Sprout size={32} />}
                title="Let understanding come first."
              >
                <p>
                  Capture a thought at your desk, then choose “Promote” when you
                  want to give it a permanent home.
                </p>
                <button className="secondary" onClick={() => setView("desk")}>
                  Return to reading
                </button>
              </Empty>
            )}
          </div>
        ) : (
          <SettingsView
            config={data.config}
            onRefresh={refresh}
            notify={notify}
          />
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {importing && (
        <ImportDialog
          initialPath={importPath}
          onClose={() => {
            setImporting(false);
            setImportPath("");
            const url = new URL(location.href);
            url.searchParams.delete("note");
            history.replaceState(null, "", url);
          }}
          onAdded={async (s) => {
            await refresh();
            await openSource(s);
          }}
          onError={notify}
        />
      )}
      {promoting && session && (
        <PromotionDialog
          artifacts={promoting}
          session={session}
          config={data.config}
          onClose={() => setPromoting(null)}
          onChanged={refreshSession}
          onError={notify}
        />
      )}
      {review && (
        <PromotionReview
          draft={review}
          config={data.config}
          onClose={() => setReview(null)}
          onChanged={async () => {
            await refresh();
          }}
          onError={notify}
        />
      )}
      {note && (
        <NoteDialog
          note={note}
          config={data.config}
          onClose={() => setNote(null)}
          onNote={(t) => void openNote(t)}
          onRead={(p) => void readNote(p)}
          onConnect={
            session
              ? (n) => {
                  setNote(null);
                  setConnection(n);
                }
              : undefined
          }
        />
      )}
      {newWorkspace && (
        <InquiryDialog
          onClose={() => setNewWorkspace(false)}
          onSave={async (title, question) => {
            try {
              const w = await api<{ id: string }>("/workspaces", {
                title,
                question,
              });
              await refresh();
              setWorkspaceId(w.id);
              setSessionId("");
              setSession(null);
              setSource(null);
              setView("desk");
              setNewWorkspace(false);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
      )}
      {checkpoint && session && (
        <CheckpointDialog
          session={session}
          onClose={() => setCheckpoint(false)}
          onSave={async (values) => {
            try {
              await api(`/sessions/${session.id}`, values, "PATCH");
              if (values.takeaway?.trim())
                await api(`/sessions/${session.id}/artifacts`, {
                  text: values.takeaway,
                  kind: "checkpoint",
                  anchor,
                  status: "open",
                });
              await refreshSession();
              setCheckpoint(false);
              notify(
                "Checkpoint saved. Your next step will be here when you return.",
              );
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
      )}
      {connection && session && (
        <ConnectionDialog
          note={connection}
          onClose={() => setConnection(null)}
          onSave={async (relation, evidence) => {
            try {
              await api("/relationships", {
                sessionId: session.id,
                notePath: connection.path,
                relation,
                evidence,
                anchor,
              });
              await refresh();
              setConnection(null);
              notify(
                "Connection saved with its evidence in your research history.",
              );
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function Reader({
  source,
  session,
  anchor,
  onAnchor,
  onNote,
  config,
  onRegionAction,
}: {
  source: Source;
  session: Session;
  anchor: Anchor;
  onAnchor: (a: Anchor) => void;
  onNote: (t: string) => void;
  config: Config;
  onRegionAction: (tab: "thoughts" | "tutor") => void;
}) {
  const [format, setFormat] = useState(source.kind === "pdf" ? "pdf" : "text"),
    [outline, setOutline] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFormat(source.kind === "pdf" ? "pdf" : "text");
    setOutline(false);
  }, [source.id]);
  useEffect(() => {
    if (scroll.current)
      scroll.current.scrollTop = Number(
        localStorage.getItem(`margin-scroll-${session.id}-${session.page}`) ||
          0,
      );
  }, [session.id, session.page]);
  const text = source.pages?.[session.page - 1] || "";
  function selection() {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !content.current?.contains(selection.anchorNode)
    )
      return;
    const quote = selection.toString().trim();
    if (!quote) return;
    let section = "";
    content.current.querySelectorAll("h1,h2,h3,h4").forEach((h) => {
      if (
        selection.anchorNode &&
        h.compareDocumentPosition(selection.anchorNode) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
        section = h.textContent || "";
    });
    onAnchor({
      sourceId: source.id,
      page: session.page,
      quote: quote.slice(0, 10000),
      section: section || undefined,
    });
  }
  return (
    <section className="reader" aria-label="Source reader">
      <div className="reader-toolbar">
        <div>
          <FileText size={15} />
          <span>
            {source.kind === "pdf"
              ? "ORIGINAL SOURCE"
              : source.kind === "reading-note"
                ? "YOUR READING NOTES"
                : "SOURCE EXCERPT"}
          </span>
        </div>
        <div>
          {source.kind === "pdf" && (
            <div className="mini-segmented">
              <button
                className={format === "pdf" ? "active" : ""}
                onClick={() => setFormat("pdf")}
              >
                PDF
              </button>
              <button
                className={format === "text" ? "active" : ""}
                onClick={() => setFormat("text")}
              >
                Text
              </button>
            </div>
          )}
          <button
            className="icon-button"
            aria-label="Source details"
            onClick={() => setOutline(!outline)}
          >
            <ListFilter size={16} />
          </button>
        </div>
      </div>
      {outline && (
        <div className="source-details">
          <strong>Source & provenance</strong>
          <p>
            {source.kind === "reading-note"
              ? "Snapshot of your vault reading note. Statements and equations may be incomplete; verify against the original paper."
              : source.kind === "pdf"
                ? "The uploaded PDF is preserved locally. Text extraction may alter mathematical notation; use the original page to check it."
                : "A user-supplied excerpt. Its title and source attribution have not been independently verified."}
          </p>
          {source.notePath && (
            <a
              href={obsidianUrl(
                config.vault.root,
                source.notePath,
                config.bridge,
              )}
            >
              Open original note <ExternalLink size={13} />
            </a>
          )}
          {source.zotero && /^(zotero|https?):\/\//.test(source.zotero) && (
            <a href={source.zotero}>
              Open in Zotero <ExternalLink size={13} />
            </a>
          )}
        </div>
      )}
      <div
        className="reader-scroll"
        ref={scroll}
        onScroll={(e) =>
          localStorage.setItem(
            `margin-scroll-${session.id}-${session.page}`,
            String(e.currentTarget.scrollTop),
          )
        }
      >
        <div
          className="paper"
          ref={content}
          onMouseUp={selection}
          onKeyUp={(e) => {
            if (e.shiftKey) selection();
          }}
        >
          {format === "pdf" ? (
            <Suspense fallback={<Spinner label="Rendering source page…" />}>
              <StructuredPdf
                key={source.id}
                sourceId={source.id}
                page={session.page}
                anchor={anchor}
                config={config}
                onAnchor={onAnchor}
                onNote={onNote}
                onAction={onRegionAction}
              />
            </Suspense>
          ) : (
            <>
              <div className="paper-kicker">
                <span>{source.authors || "RESEARCH MATERIAL"}</span>
                {source.year && <span>{source.year}</span>}
              </div>
              <h2 className="paper-title">{source.title}</h2>
              <div className="paper-rule" />
              {source.kind === "reading-note" && (
                <div className="transcription-label">
                  <NotebookPen size={12} />
                  Reading-note transcription · not source-verified
                </div>
              )}
              {text ? (
                <Markdown text={text} onNote={onNote} />
              ) : (
                <Empty title="This page has no extractable text.">
                  <p>Switch to the PDF to read a scanned or image-only page.</p>
                </Empty>
              )}
            </>
          )}
        </div>
      </div>
      <div className="reader-footer">
        <span>
          <span className="tiny-selection" />
          Hover or select a passage to anchor your thinking
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Previous source page"
            disabled={session.page <= 1}
            onClick={() =>
              onAnchor({
                sourceId: source.id,
                page: session.page - 1,
                ...(anchor.regions?.length
                  ? {
                      regions: anchor.regions,
                      quote: anchor.quote,
                      section: anchor.section,
                    }
                  : { quote: "" }),
              })
            }
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            {session.page} <span className="muted">/ {source.pageCount}</span>
          </span>
          <button
            className="icon-button"
            aria-label="Next source page"
            disabled={session.page >= source.pageCount}
            onClick={() =>
              onAnchor({
                sourceId: source.id,
                page: session.page + 1,
                ...(anchor.regions?.length
                  ? {
                      regions: anchor.regions,
                      quote: anchor.quote,
                      section: anchor.section,
                    }
                  : { quote: "" }),
              })
            }
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}

function Inspector({
  source,
  anchor,
  question,
  relationships,
  onNote,
  onClose,
  onPrompt,
}: {
  source: Source;
  anchor: Anchor;
  question: string;
  relationships: Relationship[];
  onNote: (path: string) => void;
  onClose: () => void;
  onPrompt: (mode: string) => Promise<void>;
}) {
  const { items, error, loading } = useSearch<Note>(
    `/related?sourceId=${source.id}&q=${encodeURIComponent(anchor.quote || source.title)}`,
  );
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">FOLLOW THE THREAD</span>
          <h2>Connections</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close connections"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="inspector-scroll">
        <div className="inquiry-card">
          <Compass size={18} />
          <span className="eyebrow">YOUR RESEARCH QUESTION</span>
          <p>{question || "Let your source lead you to a question."}</p>
        </div>
        {relationships.length > 0 && (
          <>
            <h3 className="small-heading">
              Your recorded connections <span>{relationships.length}</span>
            </h3>
            {relationships.map((r) => (
              <button
                key={r.id}
                className="connection-card"
                onClick={() => onNote(r.notePath)}
              >
                <Tag tone="green">{r.relation.replaceAll("-", " ")}</Tag>
                <h4>
                  {r.notePath.split("/").pop()?.replace(/\.md$/, "")}
                  <ArrowUpRight size={14} />
                </h4>
                <p>{r.evidence}</p>
                <small>Your interpretation · source position retained</small>
              </button>
            ))}
          </>
        )}
        <h3 className="small-heading">
          Already in your vault <span>{items.length}</span>
        </h3>
        <p className="fine-print">
          Passage matches and your explicit links. Mathematical relationships
          still need checking.
        </p>
        {loading ? (
          <Spinner />
        ) : (
          items.slice(0, 7).map((n) => (
            <button
              className="connection-card"
              key={n.path}
              onClick={() => onNote(n.path)}
            >
              <Tag>{n.type}</Tag>
              <h4>
                {n.title}
                <ArrowUpRight size={14} />
              </h4>
              <p>{n.excerpt?.replace(/[#*$>]/g, "").slice(0, 110)}…</p>
              <small>{n.reason}</small>
            </button>
          ))
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="revisit-card">
          <Sparkles size={18} />
          <h3>Make the connection yours.</h3>
          <p>Compare the assumptions before connecting the conclusions.</p>
          <button
            className="text-button"
            onClick={() => void onPrompt("connect")}
          >
            Explore a connection <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function VaultView({
  config,
  search,
  setSearch,
  onNote,
  onRefresh,
}: {
  config: Config;
  search: string;
  setSearch: (s: string) => void;
  onNote: (p: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [type, setType] = useState(""),
    [refreshing, setRefreshing] = useState(false);
  const { items, loading, error } = useSearch<Note>(
    `/notes?q=${encodeURIComponent(search)}&type=${type}`,
  );
  return (
    <div className="page">
      <PageHeading
        eyebrow="KNOWLEDGE YOU CAN RETURN TO"
        title="Your living knowledge base"
        description="Existing ideas, connected in your own way. Obsidian remains their home."
        action={
          <button
            className="secondary"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void onRefresh().finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            Refresh index
          </button>
        }
      />
      <div className="vault-stats">
        <div>
          <b>{config.vault.count.toLocaleString()}</b>
          <span>notes in your vault</span>
        </div>
        <div>
          <b>{config.vault.links.toLocaleString()}</b>
          <span>explicit passage links</span>
        </div>
        <div>
          <b>{config.vault.types.MOC || 0}</b>
          <span>maps of content</span>
        </div>
        <div className="vault-stat-note">
          <GitBranch size={28} strokeWidth={1} />
          <p>
            Definitions, theorems, sources.
            <br />A structure that stays yours.
          </p>
        </div>
      </div>
      <div className="vault-filters">
        <div className="searchbox">
          <Search size={17} />
          <input
            id="vault-search"
            aria-label="Search your knowledge vault"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ideas, aliases, or passages…"
          />
          {search && (
            <button
              className="icon-button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="filter-tabs">
          {[
            ["", "All notes"],
            ["MOC", "MOCs"],
            ["definition", "Definitions"],
            ["theorem", "Theorems"],
            ["literature", "Literature"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={type === id ? "active" : ""}
              onClick={() => setType(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <Spinner />
      ) : items.length ? (
        <div className="note-table">
          <div className="note-table-header">
            <span>IDEA / NOTE</span>
            <span>TYPE</span>
            <span>PASSAGE CONTEXT</span>
          </div>
          {items.map((n) => (
            <button key={n.path} onClick={() => onNote(n.path)}>
              <div>
                <span className="note-file-icon">
                  <FileText size={17} />
                </span>
                <span>
                  <strong>{n.title}</strong>
                  <small>{n.path}</small>
                </span>
              </div>
              <Tag tone={n.type === "MOC" ? "green" : ""}>{n.type}</Tag>
              <p>
                {n.summary ||
                  n.excerpt?.replace(/[#*$>]/g, "").slice(0, 150) ||
                  "Open to inspect this note."}
              </p>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Search size={30} />}
          title={
            config.vault.count
              ? "No matching notes yet."
              : "Connect your Obsidian vault."
          }
        >
          <p>
            {config.vault.count
              ? "Try a shorter phrase or a different note type."
              : "Use Settings to choose your vault directory."}
          </p>
        </Empty>
      )}
      {items.length === 80 && (
        <p className="fine-print">
          Showing the first 80 matches. Narrow your search to find a specific
          concept.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function HistoryView({
  sessions,
  onSession,
  onNote,
}: {
  sessions: Session[];
  onSession: (s: Session) => void;
  onNote: (p: string) => void;
}) {
  const [q, setQ] = useState("");
  const { items, loading, error } = useSearch<Artifact>(
    `/history?q=${encodeURIComponent(q)}`,
  );
  return (
    <div className="page">
      <PageHeading
        eyebrow="KEEP THE PATH, NOT JUST THE ANSWER"
        title="A history of understanding"
        description="Recover a thought, revisit a question, or pick up exactly where you stopped."
        action={
          <a className="secondary" href="/api/export" download>
            <ArrowDownToLine size={15} />
            Export history
          </a>
        }
      />
      <div className="history-sessions">
        {sessions.slice(0, 6).map((s) => (
          <button key={s.id} onClick={() => onSession(s)}>
            <div>
              <Tag tone={s.status === "complete" ? "green" : ""}>
                {s.status}
              </Tag>
              <span>{date(s.updatedAt)}</span>
            </div>
            <h3>{s.title}</h3>
            {s.revisitAt && <Tag tone="amber">Revisit {s.revisitAt}</Tag>}
            <p>
              {s.nextStep ||
                s.takeaway ||
                "Continue exploring from your saved reading position."}
            </p>
            <span className="text-button">
              Resume session <ArrowUpRight size={15} />
            </span>
          </button>
        ))}
      </div>
      <div className="searchbox history-search">
        <Search size={17} />
        <input
          aria-label="Search learning history"
          placeholder="Find a question, proof attempt, or moment of clarity…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {loading ? (
        <Spinner />
      ) : items.length ? (
        <div className="history-entries">
          {items.map((a) => {
            const s = sessions.find((s) => s.id === a.sessionId);
            return (
              <article key={a.id}>
                <div className="history-date">
                  {date(a.createdAt)}
                  <span>
                    {a.origin === "user"
                      ? "Your words"
                      : a.origin === "ai"
                        ? "AI suggestion"
                        : "Local prompt"}
                  </span>
                </div>
                <div>
                  <div className="history-entry-head">
                    <Tag>{a.kind}</Tag>
                    {a.status === "revisit" && (
                      <Tag tone="amber">To revisit</Tag>
                    )}
                    {s && (
                      <button
                        className="text-button"
                        onClick={() => onSession(s)}
                      >
                        {s.title.slice(0, 45)} <ArrowUpRight size={12} />
                      </button>
                    )}
                  </div>
                  <Markdown text={a.text} onNote={onNote} />
                  {a.assumptions && (
                    <p className="muted">Assumptions: {a.assumptions}</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={<History size={30} />}
          title={
            q
              ? "No entries match your search."
              : "Your thinking will leave a trail."
          }
        >
          <p>
            Thoughts, questions, and proof attempts appear here as you capture
            them at your reading desk.
          </p>
        </Empty>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function SettingsView({
  config,
  onRefresh,
  notify,
}: {
  config: Config;
  onRefresh: () => Promise<unknown>;
  notify: (m: string) => void;
}) {
  const [root, setRoot] = useState(config.vault.root),
    [zoteroDir, setZoteroDir] = useState(config.zoteroDir),
    [linkedDir, setLinkedDir] = useState(config.linkedDir),
    [semantic, setSemantic] = useState(config.semantic),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      void api<Config["semantic"]>("/semantic")
        .then(setSemantic)
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, []);
  async function save(values: unknown) {
    setBusy(true);
    try {
      await api("/settings", values);
      await onRefresh();
      notify("Settings saved.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page settings-page">
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="Settings & connections"
        description="A local workspace, built around the tools you already use."
      />
      <section className="settings-card">
        <div className="settings-card-title">
          <FolderOpen size={22} />
          <div>
            <h2>Obsidian vault</h2>
            <p>
              Your permanent notes. Indexing is read-only; writing happens
              through approved promotions.
            </p>
          </div>
          <Tag tone={config.vault.root ? "green" : ""}>
            {config.vault.root ? "Connected" : "Not connected"}
          </Tag>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({ vaultRoot: root });
          }}
        >
          <label className="field">
            Vault directory
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="/Users/you/Documents/Obsidian/My vault"
            />
          </label>
          <div className="setting-actions">
            <span className="muted">
              {config.vault.count.toLocaleString()} notes ·{" "}
              {config.vault.indexedAt
                ? `Indexed ${date(config.vault.indexedAt)}`
                : "No index yet"}
            </span>
            <button className="secondary" disabled={busy} type="submit">
              Connect & index
            </button>
          </div>
        </form>
        {config.vault.warnings.length > 0 && (
          <details className="warning-list">
            <summary>{config.vault.warnings.length} indexing notices</summary>
            {config.vault.warnings.map((s, i) => (
              <p key={i}>{s}</p>
            ))}
          </details>
        )}
      </section>
      <section className="settings-card">
        <div className="settings-card-title">
          <Sparkles size={22} />
          <div>
            <h2>Research tutor</h2>
            <p>
              Source-aware conversation, with your reasoning and AI suggestions
              kept distinct.
            </p>
          </div>
          <Tag tone={config.aiEnabled ? "green" : ""}>
            {config.aiEnabled
              ? "Enabled"
              : config.aiConfigured
                ? "Available"
                : "Choose a model"}
          </Tag>
        </div>
        <p>
          Choose an installed local model or a configured cloud provider. You
          can switch models directly in the tutor’s prompt box.
        </p>
        {config.modelError && <p className="error-text">{config.modelError}</p>}
        {config.cloudModelError && (
          <p className="error-text">{config.cloudModelError}</p>
        )}
        <ModelPicker
          config={config}
          disabled={busy}
          onChanged={onRefresh}
          onError={notify}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.aiEnabled}
            onChange={(e) =>
              void save(
                config.provider === "ollama"
                  ? { localAiEnabled: e.target.checked }
                  : { aiEnabled: e.target.checked },
              )
            }
          />
          Enable tutoring with the selected model
        </label>
        <p className="fine-print">
          The selected PDF page, your question, recent reasoning, and relevant
          vault passages{" "}
          {config.cloud
            ? "are sent to the selected cloud provider"
            : "stay on this computer"}
          . AI answers are proposals with inspectable evidence.
        </p>
        <p className="fine-print">
          OpenAI models appear when OPENAI_API_KEY is set in .env and Margin is
          restarted. Ollama cloud models appear when configured in Ollama.
          Refresh the list after adding models.
        </p>
        <label className="field">
          Embedding model
          <select
            value={config.embeddingModel}
            onChange={(e) => void save({ embeddingModel: e.target.value })}
          >
            {config.models
              .filter((m) => !m.cloud && m.capabilities.includes("embedding"))
              .map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
          </select>
        </label>
        <p>
          Semantic vault index:{" "}
          {semantic.running
            ? `${semantic.done} / ${semantic.total} passages`
            : `${semantic.cached} passages`}
          {semantic.stale ? " · refresh needed" : ""}
        </p>
        {semantic.error && <p className="error-text">{semantic.error}</p>}
        <button
          className="secondary"
          disabled={semantic.running || !config.embeddingModel}
          onClick={() =>
            void api<Config["semantic"]>("/semantic/build", {})
              .then(setSemantic)
              .catch((e) => notify(e.message))
          }
        >
          Build / refresh semantic index
        </button>
      </section>
      <section className="settings-card" aria-label="Synthesis model settings">
        <div className="settings-card-title">
          <Sparkles size={22} />
          <div>
            <h2>Synthesis model</h2>
            <p>
              Choose the model that organizes thoughts and proposes
              literature-note edits.
            </p>
          </div>
          <Tag tone={config.synthesis?.available ? "green" : ""}>
            {config.synthesis?.cloud ? "Cloud" : "Local"}
          </Tag>
        </div>
        <ModelPicker
          config={config}
          purpose="synthesis"
          disabled={busy}
          onChanged={onRefresh}
          onError={notify}
        />
        <p className="fine-print">
          This selection is saved for all literature notes, independently of
          Tutor. Synthesis needs a model with structured output support; Auto ·
          local remains a Tutor option.
        </p>
        <p className="fine-print">
          {config.synthesis?.cloud
            ? "Manual synthesis sends the note, selected thoughts, and supporting passages to the selected cloud provider. Automatic organization is paused while a cloud model is selected."
            : "Synthesis stays on this computer. Automatic organization uses this local model when enabled."}
        </p>
      </section>
      <section className="settings-card">
        <h2>Zotero PDFs</h2>
        <p>
          Keep Zotero open with Better BibTeX enabled. In Obsidian, run “Margin
          Research Bridge: Open literature note in Margin”.
        </p>
        <label className="field">
          Zotero data folder
          <input
            value={zoteroDir}
            onChange={(e) => setZoteroDir(e.target.value)}
          />
        </label>
        <label className="field">
          Linked attachment folder (optional)
          <input
            value={linkedDir}
            onChange={(e) => setLinkedDir(e.target.value)}
          />
        </label>
        <button
          className="secondary"
          onClick={() => void save({ zoteroDir, linkedDir })}
        >
          Save Zotero folders
        </button>
      </section>
      <section className="settings-card">
        <h2>Research harness</h2>
        <p>
          Control automatic evidence retrieval and citation display. Saved
          answers remain available when execution is disabled.
        </p>
        {(
          [
            ["agentHarness", "agentHarness", "Enable durable research runs"],
            ["citationRendering", "citations", "Show named citation previews"],
            [
              "sourceExpansion",
              "sourceExpansion",
              "Allow source and bibliography expansion",
            ],
          ] as const
        ).map(([setting, feature, label]) => (
          <label className="checkbox-label" key={setting}>
            <input
              type="checkbox"
              disabled={busy}
              checked={config.features?.[feature] !== false}
              onChange={(e) => void save({ [setting]: e.target.checked })}
            />{" "}
            {label}
          </label>
        ))}
        <p className="fine-print">
          AI note changes always create a reviewable proposal. Clear diagnostic
          details or delete session history from the notebook inspector’s
          Session data controls.
        </p>
      </section>
      <section className="settings-card">
        <div className="settings-card-title">
          <ExternalLink size={22} />
          <div>
            <h2>Obsidian navigation bridge</h2>
            <p>Open a note and put the cursor at the relevant section.</p>
          </div>
        </div>
        <p>
          The optional plugin is included in <code>obsidian-bridge/</code>.
          Follow its README to install it in your vault. Standard Obsidian links
          work without it.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.bridge}
            disabled={busy}
            onChange={(e) => void save({ bridge: e.target.checked })}
          />
          I installed the Margin bridge · use section navigation
        </label>
      </section>
      <section className="settings-card">
        <div className="settings-card-title">
          <ArrowDownToLine size={22} />
          <div>
            <h2>Your working history</h2>
            <p>
              Sessions, sources, learning artifacts, connections, and original
              note backups.
            </p>
          </div>
        </div>
        <p className="data-path">{config.dataDir}</p>
        <div className="setting-actions">
          <p className="fine-print">
            Export includes source text and promotion backups. To back up legacy
            uploaded PDFs as well, copy the data directory while the app is
            stopped. Zotero attachments remain in Zotero storage and need their
            own backup.
          </p>
          <a href="/api/export" download className="secondary">
            Export JSON <ArrowDownToLine size={14} />
          </a>
        </div>
        <p className="fine-print">
          Browser dictation depends on browser support and may use the browser
          provider’s speech service. macOS dictation also works in any text
          field.
        </p>
      </section>
    </div>
  );
}

function InquiryDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (title: string, question: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Follow a new research question" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onSave(title, question).finally(() => setBusy(false));
        }}
      >
        <label className="field">
          Inquiry name
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Information-constrained invariance"
          />
        </label>
        <label className="field">
          What are you trying to understand?
          <textarea
            rows={4}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="A question worth spending time with…"
          />
        </label>
        <div className="modal-actions">
          <button className="primary" disabled={busy || !title.trim()}>
            Create inquiry <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CheckpointDialog({
  session,
  onClose,
  onSave,
}: {
  session: Session;
  onClose: () => void;
  onSave: (values: {
    takeaway: string;
    nextStep: string;
    status: string;
    revisitAt: string;
  }) => Promise<void>;
}) {
  const [takeaway, setTakeaway] = useState(session.takeaway || ""),
    [nextStep, setNextStep] = useState(session.nextStep || ""),
    [status, setStatus] = useState("paused"),
    [revisitAt, setRevisitAt] = useState(session.revisitAt || ""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Leave a thread for next time" onClose={onClose}>
      <p className="muted">
        Even an unfinished reading session can leave something useful.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onSave({ takeaway, nextStep, status, revisitAt }).finally(() =>
            setBusy(false),
          );
        }}
      >
        <label className="field">
          Your takeaway, in your own words
          <textarea
            rows={4}
            value={takeaway}
            onChange={(e) => setTakeaway(e.target.value)}
            placeholder="What do you understand now that you didn’t before?"
          />
        </label>
        <label className="field">
          Where should you pick up?
          <textarea
            rows={3}
            value={nextStep}
            onChange={(e) => setNextStep(e.target.value)}
            placeholder="An unresolved question, a proof step, or a comparison to make…"
          />
        </label>
        <div className="form-row">
          <label className="field">
            Session state
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="paused">Pause here</option>
              <option value="complete">Finished for now</option>
              <option value="active">Keep reading</option>
            </select>
          </label>
          <label className="field">
            Revisit on <span className="muted">optional</span>
            <input
              type="date"
              value={revisitAt}
              onChange={(e) => setRevisitAt(e.target.value)}
            />
          </label>
        </div>
        <p className="fine-print">
          Revisit dates are recorded in your history. They do not schedule
          notifications.
        </p>
        <div className="modal-actions">
          <button className="primary" disabled={busy}>
            Save checkpoint <Check size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectionDialog({
  note,
  onClose,
  onSave,
}: {
  note: Note;
  onClose: () => void;
  onSave: (relation: string, evidence: string) => Promise<void>;
}) {
  const [relation, setRelation] = useState("related-to"),
    [evidence, setEvidence] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Record a meaningful connection" onClose={onClose}>
      <p>
        Connect this reading session to <strong>{note.title}</strong>.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onSave(relation, evidence).finally(() => setBusy(false));
        }}
      >
        <label className="field">
          How are they connected?
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          >
            <option value="related-to">Related to</option>
            <option value="uses">Uses this concept</option>
            <option value="contrasts-with">Contrasts with</option>
            <option value="generalizes">May generalize</option>
            <option value="example-of">An example of</option>
          </select>
        </label>
        <label className="field">
          Your evidence and qualifications
          <textarea
            rows={5}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Which passage supports the connection? Which assumptions differ?"
            required
          />
        </label>
        <p className="fine-print">
          Saved as your interpretation, with the selected source position. This
          does not assert mathematical equivalence or change your vault.
        </p>
        <div className="modal-actions">
          <button className="primary" disabled={busy || !evidence.trim()}>
            Save connection <Link2 size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
