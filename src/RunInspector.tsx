import { useEffect, useState } from "react";
import { api } from "./api";
import { AgentActivity } from "./AgentActivity";
import type { AgentRun } from "./agent-types";

export function RunInspector({
  sessionId,
  onChanged,
  onError,
}: {
  sessionId: string;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [runs, setRuns] = useState<AgentRun[]>([]),
    [selected, setSelected] = useState("");
  const refresh = async () =>
    setRuns(await api<AgentRun[]>(`/sessions/${sessionId}/runs`));
  useEffect(() => {
    void refresh().catch((error) => onError(error.message));
  }, [sessionId]);
  const run = runs.find((item) => item.id === selected);
  return (
    <details className="run-inspector">
      <summary>Saved tutor activity</summary>
      <label>
        Inspect a run
        <select
          aria-label="Saved tutor activity"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a question</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.text.slice(0, 100)} · {run.status}
            </option>
          ))}
        </select>
      </label>
      {run && (
        <AgentActivity
          key={run.id}
          run={run}
          onChanged={async () => {
            await onChanged();
            await refresh();
          }}
          onError={onError}
          onContinue={async (previous) => {
            const next = await api<AgentRun>(`/runs/${previous.id}/continue`, {
              idempotencyKey: crypto.randomUUID(),
            });
            await refresh();
            setSelected(next.id);
            await onChanged();
          }}
        />
      )}
    </details>
  );
}
