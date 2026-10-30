import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { NotebookState } from "./types";

const blank = () => ({
  text: "",
  anchor: null,
  start: 0,
  end: 0,
  scroll: 0,
  interim: "",
});
const initialState = (): NotebookState => ({
  schemaVersion: 1,
  mode: "thoughts",
  thoughts: blank(),
  tutor: blank(),
  activeThread: "",
  synthesis: { start: 0, end: 0, scroll: 0 },
  tabCycles: true,
});
function clientId() {
  let id = sessionStorage.getItem("margin-notebook-client");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("margin-notebook-client", id);
  }
  return id;
}
export function useNotebookState(sourceId: string, sessionId: string) {
  const [client] = useState(clientId);
  const key = `margin-notebook:${sourceId}:${client}`;
  const endpoint = `/sources/${sourceId}/notebook-state/${client}`;
  const [state, setState] = useState<NotebookState>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) return JSON.parse(saved);
    } catch {
      /* Recover from server below. */
    }
    const next = initialState();
    const legacy = localStorage.getItem(`margin-draft-${sessionId}`);
    if (legacy) {
      next.thoughts.text = legacy;
      next.thoughts.anchor = { sourceId, page: 1, quote: "", scope: "paper" };
    }
    return next;
  });
  const current = useRef(state),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState("Saved locally");
  const [ready, setReady] = useState(false);
  const dirty = useRef(false);
  const persist = async (value: NotebookState) => {
    try {
      await api(endpoint, value, "PUT");
      if (current.current === value) setStatus("Saved locally");
    } catch {
      setStatus("Offline · draft on this device");
    }
  };
  const update = (change: (previous: NotebookState) => NotebookState) => {
    dirty.current = true;
    const next = {
      ...change(current.current),
      updatedAt: new Date().toISOString(),
    };
    current.current = next;
    setState(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStatus("Saving");
    } catch {
      setStatus("Browser storage full · keep this page open");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(next), 1000);
  };
  useEffect(() => {
    let live = true;
    void api<NotebookState | null>(`${endpoint}?resume=1`)
      .then((saved) => {
        if (!live || dirty.current) return;
        if (
          saved &&
          (!current.current.updatedAt ||
            String(saved.updatedAt) > String(current.current.updatedAt))
        ) {
          current.current = saved;
          setState(saved);
          localStorage.setItem(key, JSON.stringify(saved));
        }
      })
      .catch(() => setStatus("Offline · draft on this device"))
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
      clearTimeout(timer.current);
      if (dirty.current) void persist(current.current);
    };
  }, [endpoint]);
  return { state, current, update, status, ready };
}
