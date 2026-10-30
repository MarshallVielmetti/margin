import { z } from "zod";

const settingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().max(200).default(""),
    maxUnits: z.number().int().min(1).max(64).default(8),
    maxCalls: z.number().int().min(0).max(80).default(12),
    maxComparisons: z.number().int().min(0).max(8).default(3),
  })
  .strict();
const preparationSchema = settingsSchema
  .omit({ enabled: true })
  .partial()
  .extend({
    pages: z.array(z.number().int().min(1).max(20000)).max(2000).default([]),
  })
  .strict();

export function installKnowledgeAPI(app, { knowledge, store }) {
  app.get("/api/knowledge/settings", (req, res) =>
    res.json(knowledge.settings()),
  );
  app.post("/api/knowledge/settings", (req, res) =>
    res.json(knowledge.configure(settingsSchema.parse(req.body))),
  );
  app.get("/api/knowledge/search", async (req, res) => {
    await knowledge.refresh();
    res.json(
      await knowledge.search(
        z
          .string()
          .max(1200)
          .parse(req.query.q || ""),
        { limit: 40 },
      ),
    );
  });
  app.get("/api/sources/:id/knowledge", async (req, res) => {
    await knowledge.refresh();
    res.json(await knowledge.view(knowledge.forSource(req.params.id).id));
  });
  app.post("/api/sources/:id/knowledge/prepare", async (req, res) => {
    const input = preparationSchema.parse(req.body);
    await knowledge.refresh();
    res.json(knowledge.start(req.params.id, input));
  });
  app.post("/api/knowledge/jobs/:id/cancel", (req, res) =>
    res.json(knowledge.cancel(req.params.id)),
  );
  app.get("/api/knowledge/entities/:id", async (req, res) => {
    await knowledge.refresh();
    res.json(await knowledge.view(req.params.id));
  });
  app.get("/api/knowledge/entities/:id/children", async (req, res) => {
    await knowledge.refresh();
    res.json(knowledge.children(req.params.id));
  });
  app.post("/api/knowledge/connections/:id/review", (req, res) => {
    const input = z
      .object({
        state: z.enum(["proposed", "accepted", "rejected", "corrected"]),
        correction: z.string().max(6000).default(""),
      })
      .strict()
      .refine(
        (v) => v.state !== "corrected" || v.correction.trim(),
        "A correction needs text.",
      )
      .parse(req.body);
    res.json(knowledge.review(req.params.id, input));
  });
  app.get("/api/knowledge/entities/:id/export", async (req, res) => {
    await knowledge.refresh();
    const entity = knowledge.entity(req.params.id);
    const comparisonIds = new Set(
      (knowledge.snapshot(entity)?.connections || []).map((c) => c.id),
    );
    res
      .attachment(`${entity.id}-knowledge.json`)
      .json({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        files: knowledge.files.export(entity.scope, entity.id),
        reviews: store
          .list("knowledgeReview")
          .filter((r) => r.scope === entity.scope && comparisonIds.has(r.id)),
        reviewEvents: store
          .list("knowledgeReviewEvent")
          .filter(
            (r) => r.scope === entity.scope && comparisonIds.has(r.reviewId),
          ),
      });
  });
  app.post("/api/knowledge/recover", async (req, res) => {
    await knowledge.refresh();
    res.json(knowledge.recover());
  });
}
