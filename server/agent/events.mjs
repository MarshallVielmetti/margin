/** Durable, ordered run events with an in-process subscription fanout. */
export class RunEventHub {
  constructor(store) {
    this.store = store;
    this.listeners = new Map();
  }

  append(runId, type, payload = {}) {
    const event = this.store.appendAgentEvent(runId, { ...payload, type });
    this.publish(runId, event);
    return event;
  }

  /** Notify listeners about an event that a Store transaction already wrote. */
  publish(runId, event) {
    const listeners = this.listeners.get(runId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A disconnected consumer must not break run persistence or execution.
      }
    }
  }

  subscribe(runId, listener, { after = 0, replay = true } = {}) {
    if (typeof listener !== "function")
      throw new TypeError("Run event listener must be a function.");
    if (!this.store.getAgentRun(runId))
      throw new Error(`Unknown agent run: ${runId}`);
    const listeners = this.listeners.get(runId) || new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);

    if (replay) {
      for (const event of this.store.getAgentEvents(runId, after)) {
        try {
          listener(event);
        } catch {
          // Replay is best effort for the same reason as live fanout.
        }
      }
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }
}

export function createRunEventHub(store) {
  return new RunEventHub(store);
}
