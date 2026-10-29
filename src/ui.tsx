import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, LoaderCircle } from "lucide-react";
import { api } from "./api";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2 id={id}>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <LoaderCircle size={18} className="spin" />
      {label}
    </div>
  );
}
export function Tag({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function useSearch<T>(path: string) {
  const [items, setItems] = useState<T[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api<T[]>(path)
        .then((r) => {
          if (live) {
            setItems(r);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path]);
  return { items, error, loading };
}
