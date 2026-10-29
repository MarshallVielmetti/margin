import type { ContextEvidence } from "./agent-types";
export function ContextInspector({
  evidence,
  pinned,
  excluded,
  onChange,
}: {
  evidence: ContextEvidence[];
  pinned: string[];
  excluded: string[];
  onChange: (pinned: string[], excluded: string[]) => void;
}) {
  return (
    <details className="context-inspector">
      <summary>Context · {evidence.length} inspected passages</summary>
      <p className="fine-print">
        Pin or exclude passages for the next run. Source snapshots preserve what
        was actually read.
      </p>
      {evidence.map((item) => (
        <div key={item.id} className="context-item">
          <strong>{item.title}</strong>
          <span>
            {item.state || "Previously inspected"}
            {item.retrievalReason ? ` · ${item.retrievalReason}` : ""}
          </span>
          <details>
            <summary>Exact passage</summary>
            <pre>{item.text}</pre>
          </details>
          {item.id.startsWith("ev_") && (
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={pinned.includes(item.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...pinned, item.id]
                        : pinned.filter((id) => id !== item.id),
                      excluded.filter((id) => id !== item.id),
                    )
                  }
                />{" "}
                Pin
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={excluded.includes(item.id)}
                  onChange={(event) =>
                    onChange(
                      pinned.filter((id) => id !== item.id),
                      event.target.checked
                        ? [...excluded, item.id]
                        : excluded.filter((id) => id !== item.id),
                    )
                  }
                />{" "}
                Exclude
              </label>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
