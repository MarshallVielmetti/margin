import { z } from "zod";

export const researchRecordKinds = Object.freeze({
  inquiry: "researchInquiry",
  claim: "researchClaim",
  conceptOccurrence: "conceptOccurrence",
  learningEvidence: "learningEvidence",
  sessionSummary: "sessionSummary",
});

const attributionSchema = z
  .object({
    origin: z.enum(["user", "source", "ai", "system"]),
    recordId: z.string().trim().min(1).max(200).optional(),
    sourceId: z.string().trim().min(1).max(200).optional(),
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict();

const scopeSchema = z.object({
  sessionId: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.string().trim().min(1).max(200),
});

const inquirySchema = z
  .object({
    question: z.string().trim().min(1).max(5000),
    status: z.enum(["open", "active", "paused", "resolved"]).default("open"),
    attribution: attributionSchema,
    assumptions: z
      .array(z.string().trim().min(1).max(1000))
      .max(30)
      .default([]),
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    sourceAnchor: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const claimSchema = z
  .object({
    claim: z.string().trim().min(1).max(5000),
    assumptions: z
      .array(z.string().trim().min(1).max(1000))
      .max(30)
      .default([]),
    status: z
      .enum(["proposed", "accepted", "rejected", "superseded"])
      .default("proposed"),
    attribution: attributionSchema,
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    supersedesId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const conceptOccurrenceSchema = z
  .object({
    conceptId: z.string().trim().min(1).max(300),
    notePath: z.string().trim().min(1).max(1000).optional(),
    sourceId: z.string().trim().min(1).max(200).optional(),
    anchor: z.record(z.string(), z.unknown()).optional(),
    relation: z.enum([
      "related_to",
      "same_concept_candidate",
      "depends_on",
      "generalizes",
      "contradicts_under_assumptions",
    ]),
    status: z
      .enum(["proposed", "accepted", "rejected", "superseded"])
      .default("proposed"),
    assumptions: z
      .array(z.string().trim().min(1).max(1000))
      .max(30)
      .default([]),
    attribution: attributionSchema,
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict();

const learningEvidenceSchema = z
  .object({
    conceptId: z.string().trim().min(1).max(300).optional(),
    evidenceType: z.enum([
      "self-report",
      "user-response",
      "ai-provisional-assessment",
    ]),
    description: z.string().trim().min(1).max(5000),
    responseText: z.string().max(10_000).optional(),
    anchor: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["reported", "observed", "provisional"]).default("reported"),
    attribution: attributionSchema,
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    recordedAt: z.string().datetime().optional(),
  })
  .strict();

const sessionSummarySchema = z
  .object({
    text: z.string().trim().min(1).max(12_000),
    originalArtifactIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Original artifact IDs must be unique.",
      }),
    attribution: z
      .object({
        origin: z.enum(["ai", "system"]),
        recordId: z.string().trim().min(1).max(200).optional(),
        sourceId: z.string().trim().min(1).max(200).optional(),
        evidenceIds: z
          .array(z.string().trim().min(1).max(200))
          .max(50)
          .default([]),
      })
      .strict(),
  })
  .strict();

const queryKey = (record) =>
  [
    record.question,
    record.claim,
    record.conceptId,
    record.description,
    record.responseText,
    record.text,
    record.title,
    record.rationale,
    ...(record.assumptions || []),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();

function isInScope(store, record, { sessionId, workspaceId }) {
  if (!record || !workspaceId) return false;
  if (record.workspaceId && record.workspaceId !== workspaceId) return false;
  if (record.sessionId) {
    const session = store.get?.("session", record.sessionId);
    if (!session || session.workspaceId !== workspaceId) return false;
    if (sessionId && record.sessionId === sessionId)
      return session.workspaceId === workspaceId;
    return true;
  }
  return record.workspaceId === workspaceId;
}

function acceptedFirst(a, b) {
  const rank = (record) =>
    record.status === "accepted" || record.status === "accepted-by-user"
      ? 0
      : record.status === "open" || record.status === "active"
        ? 1
        : 2;
  return (
    rank(a) - rank(b) ||
    String(b.updatedAt || b.recordedAt || b.createdAt || "").localeCompare(
      String(a.updatedAt || a.recordedAt || a.createdAt || ""),
    )
  );
}

export function getResearchState(
  store,
  { sessionId, workspaceId, query = "", limit = 100 } = {},
) {
  if (!workspaceId)
    throw new Error("A workspace scope is required to read research state.");
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const normalizedQuery = String(query)
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase();
  const read = (kind) =>
    (store.list?.(kind) || [])
      .filter((record) => isInScope(store, record, { sessionId, workspaceId }))
      .filter(
        (record) =>
          !normalizedQuery || queryKey(record).includes(normalizedQuery),
      )
      .sort(acceptedFirst)
      .slice(0, safeLimit);
  return {
    scope: { sessionId: sessionId || null, workspaceId },
    inquiries: read(researchRecordKinds.inquiry),
    claims: read(researchRecordKinds.claim),
    conceptOccurrences: read(researchRecordKinds.conceptOccurrence),
    learningEvidence: read(researchRecordKinds.learningEvidence),
    sessionSummaries: read(researchRecordKinds.sessionSummary),
    note: "State is attributed and status-scoped. Note presence, transcription, or AI explanation is not evidence of mastery.",
  };
}

/** Explicit persistence service for attributed, workspace-scoped research state. */
export function createResearchStateService(store, scope) {
  const parsedScope = scopeSchema.parse(scope);
  if (parsedScope.sessionId) {
    const session = store.get?.("session", parsedScope.sessionId);
    if (!session || session.workspaceId !== parsedScope.workspaceId)
      throw new Error("The session must belong to the selected workspace.");
  }
  const put = (kind, input, schema, extra = {}) => {
    const parsed = schema.parse(input);
    if (parsed.status === "accepted" && parsed.attribution.origin !== "user")
      throw new Error(
        "Only an explicit user attribution can accept research state.",
      );
    if (parsed.status === "resolved" && parsed.attribution.origin === "ai")
      throw new Error("AI attribution cannot resolve an inquiry.");
    if (
      parsed.evidenceType === "ai-provisional-assessment" &&
      parsed.status !== "provisional"
    )
      throw new Error("An AI assessment must remain provisional.");
    if (
      parsed.evidenceType === "user-response" &&
      parsed.attribution.origin !== "user"
    )
      throw new Error("A user response requires user attribution.");
    const now = new Date().toISOString();
    return store.put(kind, {
      ...parsed,
      ...parsedScope,
      ...extra,
      createdAt: parsed.recordedAt || now,
      updatedAt: now,
    });
  };
  return {
    getState({ query = "", limit = 100 } = {}) {
      return getResearchState(store, { ...parsedScope, query, limit });
    },
    recordInquiry(input) {
      return put(researchRecordKinds.inquiry, input, inquirySchema);
    },
    recordClaim(input) {
      return put(researchRecordKinds.claim, input, claimSchema);
    },
    recordConceptOccurrence(input) {
      return put(
        researchRecordKinds.conceptOccurrence,
        input,
        conceptOccurrenceSchema,
      );
    },
    recordLearningEvidence(input) {
      return put(
        researchRecordKinds.learningEvidence,
        input,
        learningEvidenceSchema,
      );
    },
    recordSessionSummary(input) {
      const parsed = sessionSummarySchema.parse(input);
      for (const artifactId of parsed.originalArtifactIds) {
        const original = store.get?.("artifact", artifactId);
        if (!original)
          throw new Error(`Original artifact ${artifactId} does not exist.`);
        if (
          !historyScopeMatches(store, original, parsedScope) ||
          (original.workspaceId &&
            original.workspaceId !== parsedScope.workspaceId)
        )
          throw new Error(
            `Original artifact ${artifactId} is outside this workspace.`,
          );
      }
      const now = new Date().toISOString();
      return store.put(researchRecordKinds.sessionSummary, {
        ...parsed,
        ...parsedScope,
        title: "Session summary",
        kind: "session-summary",
        status: "retrieval-aid",
        origin: parsed.attribution.origin,
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

export function historyScopeMatches(store, record, scope) {
  return isInScope(store, record, scope);
}

export function searchableRecordText(record) {
  return queryKey(record);
}
