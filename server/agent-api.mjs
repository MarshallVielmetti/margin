import { z } from "zod";
import { AgentHarness } from "./agent/harness.mjs";
import { registerEvidence } from "./agent/evidence.mjs";
import { validateAnswer } from "./agent/validation.mjs";
import { createAgentRuntime } from "./agent/runtime.mjs";
import { createSourceTools } from "./agent/tools/sources.mjs";
import { createVaultTools } from "./agent/tools/vault.mjs";
import { createHistoryTools } from "./agent/tools/history.mjs";
import {
  referenceLabels,
  resolveReferences,
  revisionForSource,
} from "./references.mjs";
import { parseNote, safeNotePath } from "./vault.mjs";
import { readFile, stat } from "node:fs/promises";
import {
  createResearchStateService,
  getResearchState,
} from "./research-state.mjs";
import { preparePromotion } from "./promotions.mjs";
import { AUTO_LOCAL_MODEL, FAST_LOCAL_MODEL, routeLocal } from "./router.mjs";
import { DEFAULT_LOCAL_MODEL } from "./models.mjs";

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const revision = revisionForSource;
const evidencePages = (item) => {
  const pages = new Set(
    [item.page, ...(item.locator?.pages || [])].filter(Number.isInteger),
  );
  const span = item.span || item.locator?.span;
  if (
    Number.isInteger(span?.start?.page) &&
    Number.isInteger(span?.end?.page)
  ) {
    for (
      let page = span.start.page;
      page <= Math.min(span.end.page, span.start.page + 2000);
      page++
    )
      pages.add(page);
  }
  return pages;
};
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "awaiting_user",
]);
const budgetsSchema = z
  .object({
    maxModelCalls: z.number().int().min(1).max(8).optional(),
    maxToolCalls: z.number().int().min(1).max(20).optional(),
    maxSeconds: z.number().int().min(5).max(300).optional(),
    contextTokens: z.number().int().min(2048).max(32768).optional(),
  })
  .strict();
const contextSchema = z
  .object({
    pinnedEvidenceIds: z.array(z.string().max(200)).max(20).default([]),
    excludedEvidenceIds: z.array(z.string().max(200)).max(50).default([]),
  })
  .strict();

// The API supplies application-owned services; tools never receive settings, credentials,
// arbitrary files, or a way to apply a proposal. Every run keeps its selected provider.
export function installAgentAPI(app, services) {
  const {
    store,
    token,
    get,
    getVault,
    config,
    selectedModel,
    chatModels,
    sessionArtifacts,
    requireAnchor,
    anchorSchema,
    ollama,
    apiKey,
    fetchImpl,
    sourcePdf,
    getChunkContext,
  } = services;
  const flags = () => ({
    agentHarness: store.setting("agentHarness") !== false,
    citations: store.setting("citationRendering") !== false,
    sourceExpansion: store.setting("sourceExpansion") !== false,
  });
  const contextItems = (ids, sessionId) =>
    ids.map((id) => {
      const evidence = get("evidenceSnapshot", id);
      const links = store
        .list("runEvidence")
        .filter((link) => link.evidenceId === id);
      if (
        !links.some(
          (link) => store.get("agentRun", link.runId)?.sessionId === sessionId,
        )
      )
        throw fail("Context evidence must belong to this session.", 403);
      return evidence;
    });
  const harness = new AgentHarness({
    store,
    registerEvidence,
    validateAnswer,
    prepare: async (run, { signal, emit, registerEvidence: register }) => {
      signal.throwIfAborted();
      const session = get("session", run.sessionId);
      const source = get("source", run.sourceId || session.sourceId);
      if (run.sourceRevision && revision(source) !== run.sourceRevision)
        throw fail(
          "The source changed after this run was queued. Retry with its current version.",
          409,
        );
      if (source.localFile) await sourcePdf(source);
      const anchor = run.anchor || {
        sourceId: source.id,
        page: session.page,
        quote: "",
      };
      const assertVaultScope = () => {
        if (
          run.scope?.permissionScope?.vaultRoot !== undefined &&
          run.scope.permissionScope.vaultRoot !== getVault().root
        )
          throw fail(
            "The configured vault changed during this run. Start a new run for its current scope.",
            409,
          );
      };
      assertVaultScope();
      const excluded = contextItems(
        run.contextOverrides?.excludedEvidenceIds || [],
        session.id,
      );
      const evidence = [];
      const reads = [];
      const registerRead = async (input, toolCallId) => {
        signal.throwIfAborted();
        if (
          excluded.some((item) =>
            item.path
              ? item.path === input.path
              : item.sourceId === input.sourceId &&
                [...evidencePages(item)].some((page) =>
                  evidencePages(input).has(page),
                ),
          )
        )
          throw fail("This passage was excluded from this run.", 403);
        assertVaultScope();
        const result = await register(
          {
            ...input,
            ...(input.path
              ? {
                  vaultRoot: getVault().root,
                  vaultId: run.scope?.permissionScope?.vaultId,
                }
              : {}),
          },
          toolCallId,
        );
        signal.throwIfAborted();
        if (!result)
          throw fail("This run is no longer accepting evidence.", 409);
        if (!evidence.some((item) => item.id === result.id))
          evidence.push(result);
        reads.push(result.id);
        return result;
      };
      const scopedSource = async (id) => {
        signal.throwIfAborted();
        if (
          !(run.scope?.permissionScope?.sourceIds || [source.id]).includes(id)
        )
          throw fail("This source is outside the run's workspace scope.", 403);
        const item = get("source", id);
        if (item.localFile) await sourcePdf(item);
        return item;
      };
      const sourceIds = new Set(
        run.scope?.permissionScope?.sourceIds || [source.id],
      );
      const scopedStore = {
        list: (kind) =>
          store
            .list(kind)
            .filter((item) =>
              kind === "source"
                ? sourceIds.has(item.id)
                : ["libraryItem", "zoteroItem", "zotero-item"].includes(kind)
                  ? item.workspaceId === session.workspaceId
                  : true,
            ),
        get: (kind, id) =>
          kind === "source" && !sourceIds.has(id)
            ? undefined
            : store.get(kind, id),
        put: (kind, value) => store.put(kind, value),
      };
      const toolCatalog = [
        ...createSourceTools({
          store: scopedStore,
          getSource: scopedSource,
          registerEvidence: registerRead,
        }),
        ...createVaultTools({
          store,
          getVault,
          registerEvidence: registerRead,
        }),
        ...createHistoryTools({
          store,
          sessionId: session.id,
          workspaceId: session.workspaceId,
          getVault,
          registerEvidence: registerRead,
          preparePromotion: async ({
            root,
            request,
            provenance,
            expectedTargetHash,
          }) => {
            signal.throwIfAborted();
            const currentRoot = getVault().root;
            if (root && root !== currentRoot)
              throw fail("The vault changed during this run.", 409);
            const draft = await preparePromotion(currentRoot, request);
            if (expectedTargetHash && draft.beforeHash !== expectedTargetHash)
              throw fail(
                "The note changed. Read it again before proposing an edit.",
                409,
              );
            signal.throwIfAborted();
            return draft;
          },
        }),
        {
          name: "workspace.get_context",
          description:
            "Read this run's frozen question, source, and selected passage.",
          schema: z.object({}).strict(),
          execute: async () => ({
            status: "ok",
            workspaceId: session.workspaceId,
            sessionId: session.id,
            question: run.researchQuestion || "",
            anchor,
            source: { id: source.id, title: source.title },
            evidence: [],
          }),
        },
      ];
      const tools = toolCatalog
        .filter(
          (tool) =>
            flags().sourceExpansion ||
            (!tool.name.startsWith("source.") &&
              !tool.name.startsWith("library.") &&
              tool.name !== "reference.resolve"),
        )
        .map((tool) => ({
          ...tool,
          execute: async (args, context) => {
            assertVaultScope();
            const readOffset = reads.length;
            const result = await tool.execute(args, context);
            signal.throwIfAborted();
            const returnedIds = new Set(reads.slice(readOffset));
            return {
              ...result,
              evidence: evidence.filter((item) => returnedIds.has(item.id)),
            };
          },
        }));
      // A linked literature note is intentional context, even when its wording
      // does not match the question well enough to appear in lexical retrieval.
      // Read it again for every turn; the index and old chat are not its truth.
      if (
        source.notePath &&
        !excluded.some((item) => item.path === source.notePath)
      ) {
        const file = await safeNotePath(getVault().root, source.notePath);
        if ((await stat(file)).size > 2_000_000)
          throw fail("This literature note exceeds the 2 MB read limit.");
        const note = parseNote(source.notePath, await readFile(file, "utf8"));
        assertVaultScope();
        getVault().notes = [
          ...getVault().notes.filter((item) => item.path !== note.path),
          note,
        ];
        const text = note.content.slice(0, 12000);
        await registerRead(
          {
            title: note.title,
            kind: "vault-note-passage",
            path: note.path,
            text,
            revision: note.hash,
            handle: "L1",
            pinned: true,
            priority: 10,
            locator: {
              path: note.path,
              line: 1,
              lineStart: 1,
              lineEnd: text.split("\n").length,
              truncated: text.length < note.content.length,
            },
            provenance: {
              origin: "vault-note",
              status: "unverified",
              authorship: "not-inferred",
            },
            retrievalReason:
              "Current linked literature note; refreshed for this turn",
          },
          "linked-literature-note",
        );
      }
      const labels = flags().sourceExpansion ? referenceLabels(run.text) : [];
      if (labels.length) {
        emit("tool.started", {
          name: "source.references",
          message: "Reading the paper’s bibliography",
          labels,
        });
        const result = await resolveReferences(source, labels, {
          store: scopedStore,
          signal,
        });
        const lines = [];
        for (const entry of result.entries) {
          if (entry.status === "found") {
            const item = await registerRead(
              {
                title: source.title,
                kind: "source-reference",
                sourceId: source.id,
                revision: entry.revision,
                page: entry.page,
                text: entry.text,
                locator: {
                  page: entry.page,
                  pages: entry.pages,
                  referenceLabel: entry.label,
                  span: entry.span,
                },
                provenance: {
                  origin: "source",
                  status: "extracted",
                  method: "bibliography-parser",
                },
                referenceLabel: entry.label,
                span: entry.span,
              },
              "bibliography",
            );
            lines.push(
              `**[${entry.label}]** ${entry.text.replace(/^\s*\[?\d+\]?[.)]?\s*/, "")} {{cite:${item.id}}}`,
            );
          } else {
            lines.push(
              `**[${entry.label}]** ${entry.reason || `The entry could not be recovered (${entry.status}).`}${entry.page ? ` Check PDF page ${entry.page}.` : ""}`,
            );
          }
        }
        const missing = labels.filter(
          (label) => !result.entries.some((entry) => entry.label === label),
        );
        for (const label of missing)
          lines.push(
            `**[${label}]** No entry was returned by the bibliography extractor.`,
          );
        emit("tool.completed", {
          name: "source.references",
          labels,
          found: result.entries.filter((entry) => entry.status === "found")
            .length,
        });
        return {
          deterministicAnswer: {
            text: lines.join("\n\n"),
            evidence,
            loadedEvidenceIds: evidence.map((item) => item.id),
            kind: "reference-lookup",
            origin: "tool",
            provider: "local",
            cloud: false,
            model: "",
            usage: { modelCalls: 0, toolCalls: 1 },
            partial:
              missing.length > 0 ||
              result.entries.some((entry) => entry.status !== "found"),
            referenceResults: result.entries,
            status: "unverified",
          },
          evidence,
        };
      }
      if (!run.selection?.available)
        throw fail(
          "Choose an available model to answer this question. Bibliography lookups can run without a model.",
        );
      const pinned = contextItems(
        run.contextOverrides?.pinnedEvidenceIds || [],
        session.id,
      );
      for (const item of pinned) {
        if (item.path) {
          const file = await safeNotePath(getVault().root, item.path);
          if ((await stat(file)).size > 2_000_000)
            throw fail("This note exceeds the 2 MB read limit.");
          const note = parseNote(item.path, await readFile(file, "utf8"));
          if (
            item.revision &&
            ![note.hash, `sha256:${note.hash}`].includes(item.revision)
          )
            throw fail(
              `Pinned note “${item.title}” changed. Inspect the current note before pinning it again.`,
              409,
            );
        } else if (
          item.sourceId &&
          item.revision &&
          item.sourceId === source.id &&
          item.revision !== revision(source)
        ) {
          // Source tools own their content revision scheme; immutable snapshots remain explicit.
          throw fail(
            `Pinned source “${item.title}” changed. Read its current passage before pinning it again.`,
            409,
          );
        }
        await registerRead(
          {
            ...item,
            id: undefined,
            retrievalReason: "Pinned by the user",
            pinned: true,
          },
          "pinned-context",
        );
      }
      const excludeActivePage = excluded.some(
        (item) => item.sourceId === source.id && item.page === anchor.page,
      );
      const allowedRegions = anchor.regions?.filter(
        (region) =>
          !excluded.some(
            (item) =>
              item.sourceId === source.id &&
              evidencePages(item).has(region.page),
          ),
      );
      const modelAnchor = {
        ...anchor,
        quote: allowedRegions
          ? allowedRegions.map((region) => region.quote || "").join("\n\n")
          : excludeActivePage
            ? ""
            : anchor.quote,
        ...(allowedRegions ? { regions: allowedRegions } : {}),
      };
      const page = source.pages[anchor.page - 1] || "";
      const chunk = await getChunkContext?.(source, anchor);
      // Linked note-only sessions use the fresh registered note above. Their
      // original import is a snapshot and must not compete with current wording.
      const selectedRegions =
        source.kind === "reading-note" && source.notePath
          ? []
          : chunk?.regions?.length
            ? chunk.regions
            : chunk?.region
              ? [chunk.region]
              : [
                  {
                    text: anchor.quote || page,
                    page: anchor.page,
                    id: anchor.regionId,
                    section: anchor.section,
                    revision: anchor.revision,
                    box: anchor.box,
                  },
                ];
      for (const [index, region] of selectedRegions.entries()) {
        const text = region.text || "";
        if (
          !text ||
          excluded.some(
            (item) =>
              item.sourceId === source.id &&
              evidencePages(item).has(region.page),
          )
        )
          continue;
        await registerRead(
          {
            title: source.title,
            kind: source.kind,
            sourceId: source.id,
            page: region.page,
            regionId: region.id,
            box: region.box,
            revision: region.revision || revision(source),
            text: text.slice(0, 12000),
            handle: `S${index + 1}`,
            pinned: true,
            locator: {
              page: region.page,
              section: region.section || anchor.section,
              regionId: region.id,
              revision: region.revision,
              box: region.box,
              truncated: text.length > 12000,
            },
            provenance: {
              origin: source.kind === "reading-note" ? "unknown" : "source",
              status: "unverified",
            },
            retrievalReason: "Active source selection",
          },
          "active-source",
        );
      }
      for (const [index, item] of (excludeActivePage
        ? []
        : chunk?.contexts || []
      ).entries()) {
        if (
          excluded.some(
            (evidence) =>
              evidence.sourceId === source.id &&
              evidencePages(evidence).has(item.page || anchor.page),
          )
        )
          continue;
        await registerRead(
          {
            title: `${source.title} · saved chunk context`,
            kind: "intake-context; AI proposals unverified",
            sourceId: source.id,
            page: item.page || anchor.page,
            text: JSON.stringify(item).slice(0, 6500),
            handle: `C${index + 1}`,
            provenance: {
              origin: "ai",
              status: "proposed",
              method: "saved-intake-context",
            },
          },
          "saved-intake",
        );
      }
      // A cheap local candidate -> passage cycle supplies current notes even for
      // models that do not reliably request tools themselves.
      let retrievalWarning;
      if (getVault().notes.length && run.budgets.maxToolCalls >= 3) {
        const search = tools.find((tool) => tool.name === "vault.search");
        const read = tools.find((tool) => tool.name === "vault.read");
        const searchId = `${run.id}:initial-search`;
        emit("tool.started", {
          name: "vault.search",
          toolCallId: searchId,
          message: "Finding relevant note passages",
        });
        const found = await search.execute(
          { query: run.text.slice(0, 1200), limit: 3 },
          { signal, runId: run.id, toolCallId: searchId },
        );
        emit("tool.completed", { name: "vault.search", toolCallId: searchId });
        for (const [index, candidate] of (found.candidates || [])
          .slice(0, 2)
          .entries()) {
          const callId = `${run.id}:initial-read-${index}`;
          emit("tool.started", {
            name: "vault.read",
            toolCallId: callId,
            message: `Opening ${candidate.title}`,
          });
          try {
            await read.execute(
              { candidateId: candidate.candidateId, maxChars: 3500 },
              { signal, runId: run.id, toolCallId: callId },
            );
          } catch (error) {
            signal.throwIfAborted();
            retrievalWarning = error.message;
          }
          emit("tool.completed", { name: "vault.read", toolCallId: callId });
        }
      }
      emit("context.updated", {
        message: "Source context ready",
        evidenceIds: evidence.map((item) => item.id),
      });
      return {
        source,
        anchor: modelAnchor,
        evidence,
        tools,
        history: sessionArtifacts(session.id).filter(
          (item) => item.id !== run.questionArtifactId,
        ),
        researchQuestion: run.researchQuestion || "",
        mode: run.mode,
        registerRead,
        retrievalWarning,
      };
    },
    execute: async (prepared, run, { signal, emit }) => {
      const selected = run.selection;
      const autoLocal =
        selected.provider === "ollama" && selected.model === AUTO_LOCAL_MODEL;
      // Keep one model call for the answer even under a one-call user budget.
      let routed = null;
      if (autoLocal && run.budgets.maxModelCalls > 1) {
        emit("model.started", {
          provider: "ollama",
          model: FAST_LOCAL_MODEL,
          purpose: "routing",
        });
        signal.throwIfAborted();
        routed = await routeLocal(ollama, {
          question: run.text,
          mode: run.mode,
          anchor: prepared.anchor,
          history: prepared.history,
          researchQuestion: prepared.researchQuestion,
          signal,
        });
      }
      signal.throwIfAborted();
      const model =
        routed?.model || (autoLocal ? DEFAULT_LOCAL_MODEL : selected.model);
      const spent = store.get("agentRun", run.id).budgetUsage || {};
      const remainingTools = Math.max(
        0,
        run.budgets.maxToolCalls - (spent.toolExecutions || 0),
      );
      const runtimeBudgets = {
        ...run.budgets,
        maxModelCalls: Math.max(
          1,
          run.budgets.maxModelCalls - (spent.modelCalls || 0),
        ),
        maxToolCalls: Math.max(1, remainingTools),
      };
      const runtime = createAgentRuntime({
        provider: selected.provider,
        model,
        endpoint: selected.provider === "ollama" ? ollama.url : undefined,
        ollama,
        apiKey,
        fetchImpl,
        localOnly: !selected.cloud,
      });
      const output = await runtime.run({
        ...prepared,
        tools: remainingTools ? prepared.tools : [],
        question: run.text,
        runId: run.id,
        signal,
        onEvent: (event, data) => {
          const type = typeof event === "string" ? event : event.type;
          emit(
            type.replace(/^run\./, "runtime."),
            typeof event === "string" ? data || {} : event.data || event,
          );
        },
        selection: { ...selected, model },
        budgets: runtimeBudgets,
      });
      return {
        ...output,
        usage: {
          ...output.usage,
          modelCalls: (output.usage?.modelCalls || 0) + (spent.modelCalls || 0),
          toolCalls:
            (output.usage?.toolCalls || 0) + (spent.toolExecutions || 0),
        },
        evidence: prepared.evidence,
        mode: run.mode,
        retrievalWarning: prepared.retrievalWarning,
        model,
        provider: selected.provider,
        cloud: selected.cloud,
        ...(routed ? { routing: routed.routing } : {}),
      };
    },
  });
  const inputSchema = z
    .object({
      text: z.string().trim().min(1).max(100000),
      anchor: anchorSchema.optional(),
      mode: z
        .enum([
          "discuss",
          "answer",
          "investigate",
          "recall",
          "assumptions",
          "connect",
          "proof",
          "synthesize",
          "edit",
        ])
        .default("discuss"),
      idempotencyKey: z.string().min(1).max(200),
      contextOverrides: contextSchema.optional(),
      budgets: budgetsSchema.optional(),
      selection: z
        .object({
          provider: z.enum(["ollama", "openai"]),
          model: z.string().min(1).max(200),
        })
        .strict()
        .optional(),
    })
    .strict();
  function start(sessionId, body, continuationOf) {
    if (!flags().agentHarness)
      throw fail("The agent harness is disabled in Settings.", 409);
    const session = get("session", sessionId),
      source = get("source", session.sourceId);
    const input = inputSchema.parse(body);
    requireAnchor(input.anchor, source);
    contextItems(input.contextOverrides?.pinnedEvidenceIds || [], session.id);
    contextItems(input.contextOverrides?.excludedEvidenceIds || [], session.id);
    const requested = input.selection || selectedModel();
    const available = chatModels().find(
      (item) =>
        item.provider === requested.provider && item.name === requested.model,
    );
    if (input.selection && !available)
      throw fail("Choose an available provider and model.");
    const selection = {
      provider: requested.provider,
      model: requested.model,
      cloud: available?.cloud || requested.provider === "openai",
      available: !!available && (input.selection ? true : config().aiEnabled),
    };
    const defaults = ["proof", "assumptions"].includes(input.mode)
      ? { maxModelCalls: 8, maxToolCalls: 20, maxSeconds: 300 }
      : ["investigate", "connect"].includes(input.mode)
        ? { maxModelCalls: 8, maxToolCalls: 20, maxSeconds: 240 }
        : { maxModelCalls: 3, maxToolCalls: 6, maxSeconds: 90 };
    return harness.start({
      ...input,
      budgets: { ...defaults, ...input.budgets },
      sessionId,
      workspaceId: session.workspaceId,
      sourceId: source.id,
      sourceRevision: revision(source),
      researchQuestion: get("workspace", session.workspaceId).question,
      anchor: input.anchor || {
        sourceId: source.id,
        page: session.page,
        quote: "",
      },
      selection,
      permissionScope: {
        sourceIds: [
          ...new Set([
            source.id,
            ...store
              .list("session")
              .filter((item) => item.workspaceId === session.workspaceId)
              .map((item) => item.sourceId),
          ]),
        ],
        vaultId: store.setting("vaultId") || getVault().root,
        vaultRoot: getVault().root,
        localReads: true,
        reviewedProposalsOnly: true,
        externalResearch: false,
        contextCategories: [
          "selected source and workspace papers",
          "retrieved vault passages",
          "workspace history",
        ],
      },
      allowedProviders: [selection.provider],
      continuationOf,
    });
  }
  app.post("/api/sessions/:id/runs", (req, res) =>
    res.json(start(req.params.id, req.body)),
  );
  app.get("/api/sessions/:id/runs", (req, res) => {
    get("session", req.params.id);
    res.json(
      store
        .list("agentRun")
        .filter((run) => run.sessionId === req.params.id)
        .slice(0, 50),
    );
  });
  app.get("/api/runs/:id", (req, res) =>
    res.json(get("agentRun", req.params.id)),
  );
  // Obsidian's native requestUrl supports authenticated JSON, but not streaming
  // fetch. Replay the same durable activity events in bounded cursor batches.
  app.get("/api/runs/:id/progress", (req, res) => {
    const run = get("agentRun", req.params.id);
    if (req.headers["x-margin-token"] !== token)
      throw fail("Reconnect to Margin to read run activity.", 403);
    const after = Number(req.query.after || "0");
    if (!Number.isSafeInteger(after) || after < 0)
      throw fail("Invalid event cursor.");
    const pending = harness.events(run.id, after);
    const events = pending.slice(0, 200);
    res.json({
      run,
      events,
      cursor: events.at(-1)?.sequence ?? events.at(-1)?.seq ?? after,
      more: pending.length > events.length,
    });
  });
  app.post("/api/runs/:id/cancel", (req, res) => {
    get("agentRun", req.params.id);
    res.json(harness.cancel(req.params.id));
  });
  app.post("/api/runs/:id/continue", (req, res) => {
    const run = get("agentRun", req.params.id);
    if (!terminal.has(run.state || run.status))
      throw fail("Stop this run before continuing it.", 409);
    const input = z
      .object({
        idempotencyKey: z.string().min(1).max(200),
        budgets: budgetsSchema,
        contextOverrides: contextSchema.optional(),
        selection: inputSchema.shape.selection,
      })
      .strict()
      .parse(req.body);
    res.json(
      start(
        run.sessionId,
        {
          text: run.text,
          anchor: run.anchor,
          mode: run.mode,
          contextOverrides: input.contextOverrides || run.contextOverrides,
          ...input,
        },
        run.id,
      ),
    );
  });
  app.get("/api/runs/:id/events", (req, res) => {
    get("agentRun", req.params.id);
    if (req.headers["x-margin-token"] !== token)
      throw fail("Reload Margin to reconnect to this event stream.", 403);
    const raw = req.headers["last-event-id"] || req.query.after || "0";
    const after = Number(raw);
    if (!Number.isSafeInteger(after) || after < 0)
      throw fail("Invalid event cursor.");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let cursor = after;
    const send = (event) => {
      const sequence = event.sequence ?? event.seq;
      if (sequence <= cursor || res.destroyed) return;
      cursor = sequence;
      res.write(
        `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, id: `${req.params.id}:${sequence}`, data: event.data || event })}\n\n`,
      );
      if (
        /^run\.(completed|partial|failed|cancelled|awaiting_user)$/.test(
          event.type,
        )
      )
        res.end();
    };
    const unsubscribe = harness.subscribe(req.params.id, send, {
      after,
      replay: false,
    });
    for (const event of harness.events(req.params.id, after)) send(event);
    if (
      terminal.has(
        harness.get(req.params.id)?.state || harness.get(req.params.id)?.status,
      )
    )
      res.end();
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.get("/api/sessions/:id/research", (req, res) => {
    const session = get("session", req.params.id);
    res.json({
      ...getResearchState(store, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      }),
      sourcePosition: { sourceId: session.sourceId, page: session.page },
      openQuestions: sessionArtifacts(session.id)
        .filter(
          (item) =>
            item.origin === "user" &&
            item.kind === "question" &&
            item.status !== "understood",
        )
        .slice(-20),
      nextStep: session.nextStep || "",
      takeaway: session.takeaway || "",
    });
  });
  // These authenticated UI mutations are intentionally absent from the model tool registry.
  app.post("/api/sessions/:id/research", (req, res) => {
    const session = get("session", req.params.id);
    const input = z
      .object({
        kind: z.enum([
          "inquiry",
          "claim",
          "conceptOccurrence",
          "learningEvidence",
        ]),
        record: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(req.body);
    const service = createResearchStateService(store, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
    });
    const record = {
      ...input.record,
      attribution: { origin: "user", evidenceIds: [] },
    };
    if (record.evidenceIds) contextItems(record.evidenceIds, session.id);
    const methods = {
      inquiry: "recordInquiry",
      claim: "recordClaim",
      conceptOccurrence: "recordConceptOccurrence",
      learningEvidence: "recordLearningEvidence",
    };
    res.json(service[methods[input.kind]](record));
  });
  app.post("/api/runs/:id/diagnostics/purge", (req, res) => {
    get("agentRun", req.params.id);
    res.json(store.purgeAgentDiagnostics({ runId: req.params.id }));
  });
  app.post("/api/sessions/:id/diagnostics/purge", (req, res) => {
    get("session", req.params.id);
    res.json(store.purgeAgentDiagnostics({ sessionId: req.params.id }));
  });
  app.post("/api/sessions/:id/research-history/delete", (req, res) => {
    get("session", req.params.id);
    res.json(store.deleteSessionData(req.params.id));
  });
  app.get("/api/evidence/:id", async (req, res) => {
    const item = get("evidenceSnapshot", req.params.id);
    let freshness = "snapshot",
      currentPath = item.path;
    if (item.path) {
      if (item.vaultRoot !== undefined && item.vaultRoot !== getVault().root)
        return res.json({
          ...item,
          freshness: "unavailable",
          currentPath: undefined,
        });
      try {
        const file = await safeNotePath(getVault().root, item.path);
        if ((await stat(file)).size > 2_000_000)
          throw fail("This note exceeds the 2 MB read limit.");
        const note = parseNote(item.path, await readFile(file, "utf8"));
        freshness = !item.revision
          ? "legacy"
          : [note.hash, `sha256:${note.hash}`].includes(item.revision)
            ? "current"
            : "changed";
      } catch {
        freshness = "unavailable";
        currentPath = undefined;
        if (item.revision) {
          const hash = item.revision.replace(/^sha256:/, "");
          const matches = getVault().notes.filter((note) => note.hash === hash);
          if (matches.length === 1) {
            try {
              const file = await safeNotePath(getVault().root, matches[0].path);
              if ((await stat(file)).size > 2_000_000)
                throw fail("Note exceeds the read limit.");
              const current = parseNote(
                matches[0].path,
                await readFile(file, "utf8"),
              );
              if (current.hash === hash) {
                freshness = "renamed";
                currentPath = matches[0].path;
              }
            } catch {
              /* Retain the historical snapshot when the replacement cannot be read. */
            }
          } else if (matches.length > 1) freshness = "ambiguous";
        }
      }
    } else if (item.sourceId) {
      const source = store.get("source", item.sourceId);
      freshness = !source
        ? "unavailable"
        : !item.revision
          ? "legacy"
          : revision(source) === item.revision
            ? "current"
            : "changed";
    }
    res.json({ ...item, freshness, currentPath });
  });
  return { harness, flags, start };
}
