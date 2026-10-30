import { z } from "zod";
import { Documents, artifactRevision, documentError } from "./documents.mjs";
import { Synthesis } from "./synthesis.mjs";
import { DEFAULT_ORGANIZATION_MODEL } from "../src/model-defaults.mjs";

const id = z.string().trim().min(1).max(250);
const revision = z.number().int().nonnegative();
const markdown = z.string().max(500000);
const notebookMode = z.enum(["thoughts", "tutor", "synthesis"]);
export function installNotebookAPI(
  app,
  {
    store,
    get,
    getVault,
    onWritten,
    anchorSchema,
    requireAnchor,
    ollama,
    getModels,
    refreshLocalModels,
    selectedSynthesisModel,
    apiKey,
    fetchImpl,
    port,
  },
) {
  const documents = new Documents({ store, getVault, onWritten });
  const synthesis = new Synthesis({
    documents,
    store,
    ollama,
    getModels,
    selectedSynthesisModel,
    apiKey,
    fetchImpl,
    port,
    getSource: (sourceId) => get("source", sourceId),
  });
  app.locals.documents = documents;
  app.locals.synthesis = synthesis;
  app.locals.closeNotebook = () => synthesis.close();
  app.get("/api/sources/:id/notebook", async (req, res) => {
    const doc = await documents.forSource(get("source", req.params.id));
    res.json(documents.view(doc.id));
  });
  app.get("/api/documents/:id", (req, res) =>
    res.json(documents.view(req.params.id)),
  );
  app.patch("/api/documents/:id", async (req, res) => {
    const input = z
      .object({ expectedRevision: revision, markdown })
      .parse(req.body);
    await documents.save(req.params.id, input.expectedRevision, input.markdown);
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/connect", async (req, res) => {
    const input = z
      .object({
        expectedRevision: revision,
        path: z.string().min(1).max(2000),
        create: z.boolean().default(false),
        syncEnabled: z.boolean().default(false),
        syncMethod: z.enum(["bridge", "closed-note"]).default("bridge"),
      })
      .parse(req.body);
    await documents.bind(req.params.id, input);
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/preferences", async (req, res) => {
    const input = z
      .object({
        syncEnabled: z.boolean().optional(),
        organizeAsRead: z.boolean().optional(),
        legacyOffered: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    await documents.preferences(req.params.id, input);
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/sync", async (req, res) => {
    await documents.sync(req.params.id);
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/resolve", async (req, res) => {
    await documents.resolve(
      req.params.id,
      z
        .object({
          expectedRevision: revision,
          markdown,
          externalHash: z.string().min(1),
        })
        .parse(req.body),
    );
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/undo", async (req, res) => {
    const input = z
      .object({ expectedRevision: revision, revisionId: id })
      .parse(req.body);
    await documents.undo(
      req.params.id,
      input.revisionId,
      input.expectedRevision,
    );
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/organize", async (req, res) => {
    const input = z
      .object({
        retryKey: id,
        artifactIds: z.array(id).max(8).default([]),
        cloud: z.boolean().default(false),
        background: z.boolean().default(false),
        reconsider: z.boolean().default(false),
        excerpt: z
          .object({ artifactId: id, text: z.string().min(1).max(10000) })
          .optional(),
      })
      .parse(req.body);
    const selection = selectedSynthesisModel?.() || {
      provider: "ollama",
      model: DEFAULT_ORGANIZATION_MODEL,
      cloud: false,
    };
    if (
      selection.provider === "ollama" &&
      !(input.background && selection.cloud) &&
      !getModels().some((item) => item.name === selection.model)
    )
      await refreshLocalModels?.();
    res.json(synthesis.start(req.params.id, input));
  });
  app.post("/api/documents/:id/organize/cancel", (req, res) =>
    res.json(synthesis.cancel(req.params.id)),
  );
  app.post("/api/documents/:id/suggestions/:suggestionId", async (req, res) => {
    const input = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        expectedRevision: revision,
        text: z.string().trim().min(1).max(5000).optional(),
      })
      .parse(req.body);
    await synthesis.review(req.params.id, req.params.suggestionId, input);
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/accept-section", async (req, res) => {
    const input = z
      .object({
        suggestionIds: z.array(id).min(2).max(6),
        expectedRevision: revision,
      })
      .parse(req.body);
    await synthesis.reviewSection(
      req.params.id,
      input.suggestionIds,
      input.expectedRevision,
    );
    res.json(documents.view(req.params.id));
  });
  app.post("/api/documents/:id/reconsider", (req, res) => {
    documents.get(req.params.id);
    const input = z.object({ artifactRevisionId: id }).parse(req.body);
    for (const c of store
      .list("contribution")
      .filter(
        (c) =>
          c.documentId === req.params.id &&
          c.artifactRevisionId === input.artifactRevisionId,
      ))
      store.put("contribution", { ...c, state: "reconsider" });
    for (const s of store
      .list("synthesisSuggestion")
      .filter(
        (s) =>
          s.documentId === req.params.id &&
          s.artifactRevisionIds.includes(input.artifactRevisionId) &&
          ["pending", "stale"].includes(s.status),
      ))
      store.put("synthesisSuggestion", { ...s, status: "dismissed" });
    res.json(documents.view(req.params.id));
  });
  app.get("/api/sources/:id/notebook-state/:clientId", (req, res) => {
    get("source", req.params.id);
    const saved = store.get(
      "notebookState",
      `notebook:${req.params.id}:${id.parse(req.params.clientId)}`,
    );
    res.json(
      saved ||
        (req.query.resume === "1"
          ? store
              .list("notebookState")
              .find((s) => s.sourceId === req.params.id)
          : null) ||
        null,
    );
  });
  app.put("/api/sources/:id/notebook-state/:clientId", (req, res) => {
    const source = get("source", req.params.id);
    const draft = z.object({
      text: z.string().max(100000),
      anchor: anchorSchema.nullable().optional(),
      start: revision.default(0),
      end: revision.default(0),
      scroll: z.number().nonnegative().default(0),
      interim: z.string().max(10000).default(""),
    });
    const input = z
      .object({
        schemaVersion: z.literal(1),
        mode: notebookMode,
        thoughts: draft,
        tutor: draft,
        activeThread: z.string().max(250).default(""),
        synthesis: z.object({
          start: revision.default(0),
          end: revision.default(0),
          scroll: z.number().nonnegative().default(0),
        }),
        tabCycles: z.boolean().default(true),
      })
      .parse(req.body);
    for (const field of [input.thoughts, input.tutor])
      if (field.anchor) requireAnchor(field.anchor, source);
    res.json(
      store.put("notebookState", {
        ...input,
        id: `notebook:${source.id}:${id.parse(req.params.clientId)}`,
        sourceId: source.id,
      }),
    );
  });
  app.get("/api/artifacts/:id/revisions", (req, res) => {
    const artifact = get("artifact", req.params.id);
    res.json({
      schemaVersion: 1,
      current: { ...artifact, artifactRevisionId: artifactRevision(artifact) },
      revisions: store
        .list("annotationRevision")
        .filter((r) => r.artifactId === artifact.id),
    });
  });
  app.post("/api/bridge/poll", (req, res) => {
    const input = z
      .object({ clientId: id, vaultId: z.string().min(1).max(2000) })
      .parse(req.body);
    res.json({
      schemaVersion: 1,
      jobs: documents.bridgePoll(input.clientId, input.vaultId),
    });
  });
  app.post("/api/bridge/writes/:id/ack", (req, res) => {
    const input = z
      .object({
        clientId: id,
        ok: z.boolean(),
        error: z.string().max(2000).optional(),
      })
      .parse(req.body);
    res.json(documents.bridgeAck(req.params.id, input.clientId, input));
  });
  return { documents, synthesis };
}
