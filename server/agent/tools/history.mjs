import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";
import { preparePromotion as previewPromotion } from "../../promotions.mjs";
import { digest, resolveLinkMatches, safeNotePath } from "../../vault.mjs";
import {
  getResearchState,
  historyScopeMatches,
  searchableRecordText,
} from "../../research-state.mjs";

const tool = (name, description, schema, execute) => ({
  name,
  description,
  schema,
  execute: (args, context) => execute(schema.parse(args), context),
});
const historyKinds = [
  "artifact",
  "sessionSummary",
  "agentRun",
  "researchInquiry",
  "researchClaim",
  "conceptOccurrence",
  "learningEvidence",
  "promotion",
  "relationship",
  "evidenceSnapshot",
];
const maxHistoryCandidateIds = 512;
const maxHistoryReadChars = 12_000;
const maxVaultNoteBytes = 2_000_000;

function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The research run was cancelled.");
}

function runScope({ runId, toolCallId } = {}) {
  return String(runId || (toolCallId ? `tool:${toolCallId}` : "unscoped"));
}

function recordText(record) {
  return String(
    record?.text ??
      record?.question ??
      record?.claim ??
      record?.description ??
      record?.summary ??
      record?.finalAnswer ??
      record?.content ??
      record?.rationale ??
      "",
  );
}

function recordTitle(record, kind) {
  return String(
    record?.title ||
      record?.question ||
      record?.claim ||
      record?.conceptId ||
      record?.description ||
      record?.kind ||
      kind,
  ).slice(0, 250);
}

function originOf(record) {
  return record?.attribution?.origin || record?.origin || "unknown";
}

function listScoped(store, kind, scope) {
  return (store.list?.(kind) || []).filter((record) =>
    historyScopeMatches(store, record, scope),
  );
}

function recordFor(store, kind, id, scope) {
  const record =
    store.get?.(kind, id) ||
    listScoped(store, kind, scope).find((entry) => entry.id === id);
  return record && historyScopeMatches(store, record, scope) ? record : null;
}

function evidenceForRun(store, id, runId, scope) {
  const run = store.get("agentRun", runId);
  if (
    !run ||
    run.sessionId !== scope.sessionId ||
    run.workspaceId !== scope.workspaceId
  )
    throw new Error(
      "The current run does not belong to this session and workspace.",
    );
  const link =
    store.get("runEvidence", `${runId}:${id}`) ||
    store
      .list("runEvidence")
      .find((entry) => entry.runId === runId && entry.evidenceId === id);
  if (!link || link.runId !== runId || link.evidenceId !== id)
    throw new Error(`Evidence ${id} is not attached to this run.`);
  const snapshot = store.get("evidenceSnapshot", id);
  if (!snapshot || snapshot.id !== id)
    throw new Error(`Evidence ${id} is no longer available.`);
  return snapshot;
}

function stateSummary(record) {
  return {
    id: record.id,
    sessionId: record.sessionId || null,
    workspaceId: record.workspaceId,
    title: recordTitle(record, record.recordType || "research state"),
    status: record.status || "recorded",
    origin: originOf(record),
    attribution: record.attribution || null,
    evidenceIds: record.evidenceIds || record.attribution?.evidenceIds || [],
    assumptions: record.assumptions || [],
    originalArtifactIds: record.originalArtifactIds || [],
    sourceAnchor: record.sourceAnchor || record.anchor || null,
    createdAt: record.createdAt || record.recordedAt || null,
  };
}

function makeProposalProvenance({ evidence, sessionId, workspaceId, runId }) {
  const supports = evidence.map((entry) => ({
    evidenceId: entry.id,
    kind: entry.kind || entry.source?.type || "evidence",
    revision: entry.revision || entry.hash || null,
    locator: entry.locator || null,
    provenance: entry.provenance || null,
  }));
  return {
    origin: "ai",
    status: "proposed",
    attribution: "AI-generated draft; not researcher-authored or accepted",
    sessionId,
    workspaceId,
    runId,
    evidence: supports,
  };
}

function provenanceComment(provenance) {
  const ids = provenance.evidence
    .map((evidence) => evidence.evidenceId)
    .join(", ");
  const sourceText = `AI-generated proposal; not accepted. Evidence snapshots: ${ids}.`;
  return `<!-- margin-agent-proposal ${provenance.runId} evidence:${ids} -->\n> ${sourceText}`;
}

async function currentTargetHash(vault, request) {
  if (request.mode === "new") {
    await safeNotePath(vault.root, request.path, { allowNew: true });
    if (vault.notes.some((note) => note.path === request.path))
      throw new Error(
        "This target already exists. Select the current note instead.",
      );
    if (resolveLinkMatches(vault.notes, request.title).length)
      throw new Error("A note with this title or alias already exists.");
    if (!request.title.trim() || !request.links.length)
      throw new Error(
        "A new proposal needs a title and at least one existing note link.",
      );
    return null;
  }
  const note = vault.notes.find((entry) => entry.path === request.path);
  if (!note)
    throw new Error("The proposal target is not in the current vault index.");
  const path = await safeNotePath(vault.root, note.path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content;
  try {
    const info = await handle.stat();
    if (info.size > maxVaultNoteBytes)
      throw new Error(
        "The proposal target exceeds the bounded 2 MB read limit.",
      );
    const buffer = Buffer.alloc(maxVaultNoteBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxVaultNoteBytes)
      throw new Error(
        "The proposal target exceeds the bounded 2 MB read limit.",
      );
    content = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  if ((await realpath(path)) !== path)
    throw new Error("The proposal target changed while it was being read.");
  if (digest(content) !== note.hash)
    throw new Error(
      "The proposal target changed. Refresh the vault before creating a preview.",
    );
  return note.hash;
}

function boundedPreview(text) {
  return String(text || "").slice(0, maxHistoryReadChars);
}

export function createHistoryTools({
  store,
  sessionId,
  workspaceId,
  registerEvidence,
  getEvidence,
  getVault,
  preparePromotion,
}) {
  if (!store?.list || !store?.get || !store?.put)
    throw new TypeError("createHistoryTools requires a record store.");
  if (!workspaceId)
    throw new TypeError("createHistoryTools requires workspaceId.");
  if (sessionId) {
    const session = store.get("session", sessionId);
    if (!session || session.workspaceId !== workspaceId)
      throw new Error("The session must belong to the selected workspace.");
  }
  if (typeof registerEvidence !== "function")
    throw new TypeError("createHistoryTools requires registerEvidence().");
  if (typeof getVault !== "function")
    throw new TypeError("createHistoryTools requires getVault().");

  const scope = { sessionId, workspaceId };
  const candidateIds = new Map();
  const remember = (run, key, value) => {
    let records = candidateIds.get(run);
    if (!records) {
      records = new Map();
      candidateIds.set(run, records);
    }
    records.set(key, value);
    while (records.size > maxHistoryCandidateIds)
      records.delete(records.keys().next().value);
    while (candidateIds.size > 64)
      candidateIds.delete(candidateIds.keys().next().value);
  };

  const historySearch = tool(
    "history.search",
    "Find prior artifacts and attributed research-state candidates within this workspace. Results are discovery previews, not inspected evidence; use history.read before citing or relying on their content.",
    z
      .object({
        query: z.string().trim().min(1).max(1200),
        limit: z.number().int().min(1).max(30).default(12),
        recordKinds: z
          .array(z.enum(historyKinds))
          .max(historyKinds.length)
          .optional(),
      })
      .strict(),
    async ({ query, limit, recordKinds }, context = {}) => {
      throwIfAborted(context.signal);
      const run = runScope(context);
      const kinds =
        recordKinds ||
        historyKinds.filter((kind) => kind !== "evidenceSnapshot");
      const needle = query.normalize("NFKC").toLocaleLowerCase();
      const results = kinds
        .flatMap((kind) =>
          listScoped(store, kind, scope)
            .filter((record) => searchableRecordText(record).includes(needle))
            .map((record) => ({ kind, record })),
        )
        .sort((a, b) =>
          String(b.record.updatedAt || b.record.createdAt || "").localeCompare(
            String(a.record.updatedAt || a.record.createdAt || ""),
          ),
        )
        .slice(0, limit)
        .map(({ kind, record }) => {
          const candidateId = `hc_${randomUUID()}`;
          remember(run, candidateId, { kind, id: record.id });
          const text = recordText(record);
          return {
            candidateId,
            recordKind: kind,
            title: recordTitle(record, kind),
            preview: text.slice(0, 320),
            sessionId: record.sessionId || null,
            workspaceId: record.workspaceId || workspaceId,
            origin: originOf(record),
            status: record.status || "recorded",
            attribution: record.attribution || null,
            originalArtifactIds: record.originalArtifactIds || [],
            createdAt: record.createdAt || record.recordedAt || null,
            resultKind: "candidate",
            inspected: false,
          };
        });
      throwIfAborted(context.signal);
      return {
        candidates: results,
        resultKind: "discovery-only",
        inspectedEvidence: false,
      };
    },
  );

  const historyRead = tool(
    "history.read",
    "Read an exact historical artifact or attributed state record inside this workspace. The original session, attribution, status, and locator are preserved in the registered evidence snapshot.",
    z
      .object({
        candidateId: z.string().trim().min(1).max(100),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(maxHistoryReadChars)
          .default(8_000),
      })
      .strict(),
    async ({ candidateId, maxChars }, context = {}) => {
      throwIfAborted(context.signal);
      const run = runScope(context);
      const reference = candidateIds.get(run)?.get(candidateId);
      if (!reference)
        throw new Error(
          "This history candidate belongs to another run or expired. Search again.",
        );
      const record = recordFor(store, reference.kind, reference.id, scope);
      if (!record)
        throw new Error(
          "This history record is no longer available in this workspace.",
        );
      const originalText = recordText(record);
      if (!originalText.trim())
        throw new Error("This history record has no readable text.");
      const text = boundedPreview(originalText).slice(0, maxChars);
      const snapshot = await registerEvidence(
        {
          kind: "historical-record",
          title: recordTitle(record, reference.kind),
          ...(record.path || record.locator?.path
            ? { path: record.path || record.locator.path }
            : {}),
          ...(record.sourceId || record.anchor?.sourceId
            ? { sourceId: record.sourceId || record.anchor.sourceId }
            : {}),
          ...(record.page || record.anchor?.page
            ? { page: record.page || record.anchor.page }
            : {}),
          entity: {
            type: reference.kind,
            id: record.id,
            sessionId: record.sessionId || null,
            workspaceId: record.workspaceId || workspaceId,
            title: recordTitle(record, reference.kind),
          },
          source: {
            type: reference.kind,
            id: record.id,
            sessionId: record.sessionId || null,
            workspaceId: record.workspaceId || workspaceId,
          },
          revision:
            record.hash ||
            record.revision ||
            record.updatedAt ||
            record.createdAt ||
            null,
          hash: digest(text),
          originalHash: record.hash || null,
          text,
          locator:
            record.locator || record.anchor || record.sourceAnchor || null,
          provenance: {
            origin: originOf(record),
            status: record.status || "recorded",
            attribution: record.attribution || null,
            originalSessionId: record.sessionId || null,
            originalWorkspaceId: record.workspaceId || workspaceId,
            recordKind: reference.kind,
            recordId: record.id,
            originalArtifactIds: record.originalArtifactIds || [],
            createdAt: record.createdAt || record.recordedAt || null,
          },
          freshness: "historical-snapshot",
          runId: context.runId,
          sessionId,
          workspaceId,
        },
        context.toolCallId,
      );
      throwIfAborted(context.signal);
      return {
        evidence: [snapshot],
        title: recordTitle(record, reference.kind),
        recordKind: reference.kind,
        origin: originOf(record),
        status: record.status || "recorded",
        attribution: record.attribution || null,
        originalArtifactIds: record.originalArtifactIds || [],
        sessionId: record.sessionId || null,
        locator: record.locator || record.anchor || record.sourceAnchor || null,
        text,
        freshness: "historical-snapshot",
      };
    },
  );

  const getState = tool(
    "research.get_state",
    "Read explicitly attributed inquiry, claim, concept-occurrence, learning-evidence, and session-summary records for this workspace. Accepted state is preferred in the ordering, AI summaries link to their originals, and no mastery is inferred.",
    z
      .object({
        query: z.string().trim().max(1200).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .strict(),
    async ({ query, limit }, context = {}) => {
      throwIfAborted(context.signal);
      const state = getResearchState(store, { ...scope, query, limit });
      return {
        ...state,
        claims: state.claims.map(stateSummary),
        inquiries: state.inquiries.map(stateSummary),
        conceptOccurrences: state.conceptOccurrences.map(stateSummary),
        learningEvidence: state.learningEvidence.map(stateSummary),
        sessionSummaries: state.sessionSummaries.map((record) => ({
          ...stateSummary(record),
          text: record.text,
          originalArtifactIds: record.originalArtifactIds,
        })),
      };
    },
  );

  const createProposal = tool(
    "proposal.create",
    "Create a reviewable AI promotion preview for the current vault. It checks the target version and scoped evidence, stores a draft and provenance, and never applies or writes the proposal.",
    z
      .object({
        path: z.string().trim().min(1).max(1000),
        mode: z.enum(["append", "summary", "new"]),
        text: z.string().trim().min(1).max(20_000),
        heading: z.string().trim().min(1).max(200).default("Intuition"),
        title: z.string().max(300).default(""),
        noteType: z
          .enum(["theorem", "definition", "idea", "MOC", "literature_note"])
          .default("idea"),
        links: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
        evidenceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
      })
      .strict(),
    async (input, context = {}) => {
      throwIfAborted(context.signal);
      if (!context.runId)
        throw new Error("A run ID is required to create a scoped proposal.");
      const vault = await getVault();
      if (!vault?.root)
        throw new Error("Connect an Obsidian vault before proposing an edit.");
      const request = {
        ...input,
        links: [...new Set(input.links)],
      };
      const expectedTargetHash = await currentTargetHash(vault, request);
      if (
        request.links.some(
          (path) => !vault.notes.some((note) => note.path === path),
        )
      )
        throw new Error(
          "Every proposal link must name a current vault note path.",
        );

      const evidence = [];
      for (const id of [...new Set(input.evidenceIds)]) {
        // Evidence snapshots are immutable and can be shared; runEvidence is the
        // authoritative run scope, with the owning run supplying session/workspace.
        const registered = evidenceForRun(store, id, context.runId, scope);
        const snapshot =
          (await getEvidence?.({
            id,
            runId: context.runId,
            sessionId,
            workspaceId,
          })) || registered;
        if (snapshot.id !== id || registered.id !== id)
          throw new Error("An evidence ID resolved to a different identity.");
        evidence.push(snapshot);
      }

      const provenance = makeProposalProvenance({
        evidence,
        sessionId,
        workspaceId,
        runId: context.runId,
      });
      const provenanceText = provenanceComment(provenance);
      const callback =
        preparePromotion ||
        (async ({ root, request: proposalRequest }) =>
          previewPromotion(root, {
            ...proposalRequest,
            provenance: provenanceText,
          }));
      const draft = await callback({
        root: vault.root,
        request: { ...request, provenance: provenanceText },
        sessionId,
        workspaceId,
        runId: context.runId,
        evidence,
        provenance,
        provenanceText,
        expectedTargetHash,
      });
      if (
        !draft ||
        draft.status !== "draft" ||
        draft.path !== request.path ||
        draft.mode !== request.mode ||
        !Object.hasOwn(draft, "beforeHash") ||
        !Object.hasOwn(draft, "afterHash") ||
        typeof draft.after !== "string"
      )
        throw new Error(
          "The promotion preview callback returned an invalid or mismatched draft.",
        );
      if (draft.beforeHash !== expectedTargetHash)
        throw new Error(
          "The promotion preview was built against a different target version.",
        );
      throwIfAborted(context.signal);
      const proposal = store.put("promotion", {
        ...draft,
        sessionId,
        workspaceId,
        runId: context.runId,
        origin: "ai",
        proposalType: "memory-promotion",
        attribution: "AI-generated; requires researcher review",
        status: "draft",
        expectedTargetHash,
        evidenceIds: evidence.map((entry) => entry.id),
        evidenceSupport: provenance.evidence,
        proposedProvenance: provenance,
        provenanceText,
        createdAt: new Date().toISOString(),
      });
      return {
        proposalId: proposal.id,
        status: proposal.status,
        origin: proposal.origin,
        target: {
          path: proposal.path,
          mode: proposal.mode,
          expectedHash: proposal.expectedTargetHash,
          beforeHash: proposal.beforeHash,
          afterHash: proposal.afterHash,
        },
        evidenceIds: proposal.evidenceIds,
        evidenceSupport: proposal.evidenceSupport,
        preview: {
          before: boundedPreview(proposal.before),
          after: boundedPreview(proposal.after),
        },
        reviewRequired: true,
        applied: false,
      };
    },
  );

  return [historySearch, historyRead, getState, createProposal];
}
