import type { Anchor, Artifact } from "./types";
export interface AgentRun {
  id: string;
  sessionId: string;
  state?: string;
  status?: string;
  text: string;
  mode: string;
  anchor?: Anchor;
  artifactId?: string;
  finalArtifactId?: string;
  error?: string | { message: string };
  evidenceIds?: string[];
  createdAt: string;
  budgets?: Record<string, number>;
  usage?: Record<string, number>;
  selection?: { provider: string; model: string; cloud?: boolean };
}
export interface AgentEvent {
  id: string;
  sequence?: number;
  seq?: number;
  type: string;
  data?: Record<string, unknown>;
  createdAt: string;
}
export const runState = (run: AgentRun) => run.state || run.status || "queued";
export const isTerminalRun = (run: AgentRun) =>
  ["completed", "partial", "cancelled", "failed", "awaiting_user"].includes(
    runState(run),
  );
export type ContextEvidence = NonNullable<Artifact["evidence"]>[number] & {
  state?: string;
  retrievalReason?: string;
  pinned?: boolean;
  provenance?: { origin?: string; status?: string };
  revision?: string;
};
