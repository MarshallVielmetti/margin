import { useEffect, useRef, useState } from "react";
import { api, streamRunEvents } from "./api";
import {
  isTerminalRun,
  runState,
  type AgentEvent,
  type AgentRun,
} from "./agent-types";

export function AgentActivity({
  run: initial,
  onChanged,
  onContinue,
  onError,
  compact = false,
}: {
  run: AgentRun;
  onChanged: () => Promise<void>;
  onContinue: (run: AgentRun) => Promise<void>;
  onError: (message: string) => void;
  compact?: boolean;
}) {
  const [run, setRun] = useState(initial),
    [events, setEvents] = useState<AgentEvent[]>([]),
    [connection, setConnection] = useState(""),
    [stopping, setStopping] = useState(false);
  const callbacks = useRef({ onChanged, onError });
  callbacks.current = { onChanged, onError };
  useEffect(() => {
    const controller = new AbortController();
    let after = 0,
      announced = false;
    setRun(initial);
    setEvents([]);
    const refresh = async () => {
      const next = await api<AgentRun>(`/runs/${initial.id}`);
      if (controller.signal.aborted) return next;
      setRun(next);
      if (isTerminalRun(next) && !announced) {
        announced = true;
        await callbacks.current.onChanged();
      }
      return next;
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await streamRunEvents(
            initial.id,
            after,
            controller.signal,
            (event) => {
              after = event.sequence ?? event.seq ?? after;
              setConnection("");
              setEvents((list) =>
                [...list.filter((item) => item.id !== event.id), event].slice(
                  -100,
                ),
              );
              if (event.type.startsWith("run.")) void refresh().catch(() => {});
            },
          );
          if (isTerminalRun(await refresh())) break;
        } catch (error) {
          if (controller.signal.aborted) break;
          const failure = error as Error & { status?: number };
          if (
            failure.status &&
            failure.status >= 400 &&
            failure.status < 500 &&
            failure.status !== 429
          ) {
            setConnection(failure.message);
            break;
          }
          setConnection(
            "Connection interrupted. Reconnecting to the saved run…",
          );
        }
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 1500);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    })();
    return () => controller.abort();
  }, [initial.id]);
  const progress = [...events]
    .reverse()
    .find((event) => typeof event.data?.message === "string");
  const partial = events
    .filter((event) => event.type === "answer.delta")
    .map((event) => String(event.data?.text || event.data?.delta || ""))
    .join("");
  const error = typeof run.error === "string" ? run.error : run.error?.message;
  if (compact && isTerminalRun(run) && runState(run) === "completed")
    return null;
  return (
    <section className="agent-activity" aria-label="Research activity">
      <div className="agent-status" role="status" aria-live="polite">
        <strong>{runState(run).replaceAll("_", " ")}</strong>
        <span>
          {connection ||
            error ||
            String(progress?.data?.message || "Research run saved")}
        </span>
      </div>
      {!compact &&
        (run.usage?.modelCalls === 0 ? (
          <p className="fine-print">
            Local bibliography lookup · no model call
          </p>
        ) : (
          run.selection && (
            <p className="fine-print">
              {run.selection.cloud ? "Cloud" : "Local"} · {run.selection.model}
            </p>
          )
        ))}
      {!isTerminalRun(run) ? (
        <button
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void api<AgentRun>(`/runs/${run.id}/cancel`, {})
              .then(setRun)
              .catch((e) => onError(e.message))
              .finally(() => setStopping(false));
          }}
        >
          Stop
        </button>
      ) : (
        runState(run) !== "completed" && (
          <button
            onClick={() =>
              void onContinue(run).catch((e) => onError(e.message))
            }
          >
            {runState(run) === "failed" ? "Retry" : "Continue investigation"}
          </button>
        )
      )}
      {partial && !isTerminalRun(run) && (
        <div className="agent-provisional">
          <small>Provisional answer · validation pending</small>
          <p>{partial}</p>
        </div>
      )}
      <details>
        <summary>Activity · {events.length} events</summary>
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <span>{event.type.replaceAll(".", " · ")}</span>
              {event.data?.name ? `: ${String(event.data.name)}` : ""}
              {event.data?.message ? <p>{String(event.data.message)}</p> : null}
              {event.createdAt ? (
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleTimeString()}
                </time>
              ) : null}
              {event.data &&
              (event.data.arguments ||
                event.data.result ||
                event.data.durationMs !== undefined) ? (
                <details>
                  <summary>Execution details</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        arguments: event.data.arguments,
                        result: event.data.result,
                        durationMs: event.data.durationMs,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
