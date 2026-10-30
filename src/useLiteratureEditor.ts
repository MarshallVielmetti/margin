import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DocumentView, LiteratureDocument } from "./types";
import { mergeMarkdown } from "../server/document-merge.mjs";

export function useLiteratureEditor(
  view: DocumentView | null,
  onView: (view: DocumentView) => void,
  onError: (text: string) => void,
) {
  const [text, setText] = useState(""),
    [status, setStatus] = useState("Saved locally"),
    [recovery, setRecovery] = useState<{
      local: string;
      remote: string;
    } | null>(null);
  const current = useRef(""),
    base = useRef<LiteratureDocument | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    inflight = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  const callbacks = useRef({ onView, onError });
  callbacks.current = { onView, onError };
  const storageKey = (id: string) =>
    `margin-document-draft:${id}:${sessionStorage.getItem("margin-notebook-client") || "default"}`;
  const preserve = () => {
    if (!base.current) return;
    try {
      localStorage.setItem(
        storageKey(base.current.id),
        JSON.stringify({
          text: current.current,
          baseMarkdown: base.current.markdown,
          baseRevision: base.current.revision,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {
      setStatus("Offline");
      callbacks.current.onError(
        "Browser storage is full. Export the note or keep this page open until it saves.",
      );
    }
  };
  const adopt = (doc: LiteratureDocument) => {
    const previous = base.current;
    if (
      previous &&
      previous.revision === doc.revision &&
      previous.id === doc.id
    ) {
      base.current = doc;
      if (current.current === doc.markdown)
        setStatus(
          doc.conflict || doc.syncStatus === "conflict"
            ? "Conflict"
            : doc.syncStatus === "synced"
              ? "Synced to Obsidian"
              : doc.syncStatus === "offline"
                ? "Offline"
                : "Saved locally",
        );
      return;
    }
    const merged = previous
      ? mergeMarkdown(previous.markdown, current.current, doc.markdown)
      : { text: doc.markdown, conflicts: [] };
    if (merged.conflicts.length) {
      const local = current.current;
      base.current = doc;
      current.current = merged.text;
      setText(merged.text);
      preserve();
      blocked.current = true;
      setRecovery({ local, remote: doc.markdown });
      setStatus("Conflict");
      return;
    }
    base.current = doc;
    current.current = merged.text;
    setText(merged.text);
    preserve();
    setStatus(
      doc.conflict || doc.syncStatus === "conflict"
        ? "Conflict"
        : doc.syncStatus === "synced" && merged.text === doc.markdown
          ? "Synced to Obsidian"
          : doc.syncStatus === "offline"
            ? "Offline"
            : "Saved locally",
    );
  };
  useEffect(() => {
    if (!view || inflight.current) return;
    if (!base.current) {
      const doc = view.document;
      let recovered: {
        text: string;
        baseMarkdown: string;
        baseRevision: number;
      } | null = null;
      try {
        recovered = JSON.parse(
          localStorage.getItem(storageKey(doc.id)) || "null",
        );
      } catch {
        /* Keep server revision. */
      }
      if (recovered && recovered.text !== recovered.baseMarkdown) {
        const merged = mergeMarkdown(
          recovered.baseMarkdown,
          recovered.text,
          doc.markdown,
        );
        base.current = doc;
        current.current = merged.text;
        setText(merged.text);
        if (merged.conflicts.length) {
          blocked.current = true;
          setRecovery({ local: recovered.text, remote: doc.markdown });
          setStatus("Conflict");
          return;
        }
        preserve();
        if (merged.text !== doc.markdown)
          timer.current = setTimeout(() => void flush(), 1000);
      } else adopt(doc);
    } else adopt(view.document);
  }, [view]);
  const save = async () => {
    while (base.current && current.current !== base.current.markdown) {
      const doc = base.current,
        submitted = current.current;
      if (doc.conflict) {
        setStatus("Conflict");
        return;
      }
      setStatus("Saving");
      try {
        const saved = await api<DocumentView>(
          `/documents/${doc.id}`,
          { markdown: submitted, expectedRevision: doc.revision },
          "PATCH",
        );
        base.current = saved.document;
        preserve();
        callbacks.current.onView(saved);
      } catch (error) {
        const failure = error as Error & {
          status?: number;
          current?: LiteratureDocument;
        };
        if (failure.status === 409 && failure.current) {
          const merged = mergeMarkdown(
            doc.markdown,
            current.current,
            failure.current.markdown,
          );
          if (merged.conflicts.length) {
            const local = current.current;
            base.current = failure.current;
            current.current = merged.text;
            setText(merged.text);
            preserve();
            blocked.current = true;
            setRecovery({ local, remote: failure.current.markdown });
            setStatus("Conflict");
            return;
          }
          base.current = failure.current;
          current.current = merged.text;
          setText(merged.text);
          preserve();
          continue;
        }
        setStatus("Offline");
        callbacks.current.onError(failure.message);
        return;
      }
    }
    const doc = base.current;
    if (!doc) return;
    if (doc.syncEnabled && !doc.conflict) {
      const saved = await api<DocumentView>(`/documents/${doc.id}/sync`, {});
      // Editing remains possible while the bridge coordinates its write.
      adopt(saved.document);
      callbacks.current.onView(saved);
    } else setStatus(doc.conflict ? "Conflict" : "Saved locally");
  };
  const flush = async () => {
    clearTimeout(timer.current);
    if (blocked.current) return;
    if (inflight.current) {
      await inflight.current;
      if (
        base.current &&
        current.current !== base.current.markdown &&
        !recovery
      )
        return flush();
      return;
    }
    const promise = save().catch((error) => {
      setStatus("Offline");
      callbacks.current.onError((error as Error).message);
    });
    inflight.current = promise;
    try {
      await promise;
    } finally {
      inflight.current = null;
    }
  };
  const write = (value: string) => {
    current.current = value;
    setText(value);
    preserve();
    setStatus("Saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1000);
  };
  const writer = useRef({ flush });
  writer.current = { flush };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void writer.current.flush();
    },
    [],
  );
  const recover = (value: string) => {
    if (!view) return;
    blocked.current = false;
    current.current = value;
    setText(value);
    setRecovery(null);
    preserve();
    setStatus("Saving");
    timer.current = setTimeout(() => void flush(), 1000);
  };
  return { text, status, write, flush, recovery, recover, base, current };
}
