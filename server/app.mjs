import { Intake } from "./intake.mjs";
import { homedir } from "node:os";
import { Ollama } from "./ollama.mjs";
import { DEFAULT_LOCAL_MODEL, openAIModels } from "./models.mjs";
import { AUTO_LOCAL_MODEL, autoLocalAvailable, routeLocal } from "./router.mjs";
import { ZoteroLibrary, checkedPdf } from "./zotero.mjs";
import { Retrieval } from "./retrieval.mjs";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  scanVault,
  searchNotes,
  resolveLinks,
  safeNotePath,
  parseNote,
} from "./vault.mjs";
import {
  preparePromotion,
  applyPromotion,
  undoPromotion,
} from "./promotions.mjs";
import { askTutor, recallPrompt } from "./tutor.mjs";

const string = z.string().trim().min(1).max(100_000);
const anchorSchema = z.object({
  sourceId: z.string(),
  page: z.number().int().positive(),
  quote: z.string().max(10000).default(""),
  section: z.string().max(500).optional(),
  regionId: z.string().max(250).optional(),
  revision: z.string().max(100).optional(),
  box: z
    .tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ])
    .optional(),
});
const artifactSchema = z.object({
  text: string,
  kind: z
    .enum([
      "thought",
      "question",
      "proof",
      "example",
      "claim",
      "summary",
      "checkpoint",
    ])
    .default("thought"),
  anchor: anchorSchema.optional(),
  assumptions: z.string().max(10000).optional(),
  status: z.enum(["open", "revisit", "understood"]).default("open"),
});
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

export async function createApp({
  store,
  dataDir,
  vaultRoot = "",
  port = 4317,
  apiKey = "",
  model = "gpt-5.4-mini",
  fetchImpl,
  ollamaUrl = "http://127.0.0.1:11434",
  zoteroDir = resolve(homedir(), "Zotero"),
  intakeExtractors,
}) {
  const app = express(),
    token = randomBytes(32).toString("hex");
  let vault = { root: "", notes: [], warnings: [], indexedAt: null },
    indexing = false;
  const ollama = new Ollama(ollamaUrl, fetchImpl);
  const retrieval = new Retrieval(store, ollama);
  let models = [],
    modelError = "",
    cloudModels = [],
    cloudModelError = "";
  async function refreshModels() {
    const [local, cloud] = await Promise.allSettled([
      ollama.models(),
      openAIModels(apiKey, fetchImpl),
    ]);
    models = local.status === "fulfilled" ? local.value : [];
    modelError = local.status === "rejected" ? local.reason.message : "";
    cloudModels = cloud.status === "fulfilled" ? cloud.value : [];
    cloudModelError =
      cloud.status === "rejected"
        ? "Cannot discover OpenAI models. Check OPENAI_API_KEY and refresh models."
        : "";
  }
  await refreshModels();
  const localModel = () => store.setting("ollamaModel") || DEFAULT_LOCAL_MODEL;
  const embeddingModel = () =>
    store.setting("embeddingModel") ||
    models.find((m) => !m.cloud && m.capabilities.includes("embedding"))
      ?.name ||
    "";
  const provider = () => store.setting("provider") || "ollama";
  const chatModels = () => [
    ...(autoLocalAvailable(models)
      ? [{ name: AUTO_LOCAL_MODEL, provider: "ollama", cloud: false }]
      : []),
    ...models
      .filter((m) => m.capabilities.includes("completion"))
      .map((m) => ({ name: m.name, provider: "ollama", cloud: m.cloud })),
    ...cloudModels,
  ];
  const selectedModel = () => ({
    provider: provider(),
    model:
      provider() === "ollama" ? localModel() : store.setting("model") || model,
    cloud:
      provider() === "openai" ||
      !!models.find((m) => m.name === localModel())?.cloud,
  });
  const aiConfigured = () =>
    provider() === "ollama"
      ? chatModels().some(
          (m) => m.provider === "ollama" && m.name === localModel(),
        )
      : !!apiKey;
  const library = () =>
    new ZoteroLibrary({
      dataDir: store.setting("zoteroDir") || zoteroDir,
      linkedDir: store.setting("linkedDir") || "",
      fetchImpl,
    });
  async function freshNote(path) {
    const file = await safeNotePath(vault.root, path);
    const note = parseNote(path, readFileSync(file, "utf8"));
    vault.notes = [...vault.notes.filter((n) => n.path !== path), note];
    return note;
  }
  const uploads = resolve(dataDir, "sources");
  mkdirSync(uploads, { recursive: true });
  async function reindex(root) {
    if (indexing) throw fail("An index refresh is already running.");
    indexing = true;
    try {
      vault = root
        ? await scanVault(root)
        : { root: "", notes: [], warnings: [], indexedAt: null };
      store.setting("vaultRoot", root);
    } finally {
      indexing = false;
    }
  }
  const root = store.setting("vaultRoot") ?? vaultRoot;
  try {
    await reindex(root);
  } catch (e) {
    vault.warnings.push(`Vault not connected: ${e.message}`);
  }
  if (!store.list("workspace").length)
    store.put("workspace", {
      title: "Decentralized safety",
      question:
        "How do information and communication constraints change what a multi-agent system can guarantee?",
      createdAt: new Date().toISOString(),
    });
  if (!store.setting("initialized")) {
    const note = vault.notes.find((n) =>
      n.path.includes("@tsitsiklisDistributedAsynchronousDeterministic1986"),
    );
    if (note) {
      const source = store.put("source", {
        title: note.title,
        authors: String(note.metadata.authors || ""),
        year: note.metadata.year,
        kind: "reading-note",
        pages: [note.body],
        notePath: note.path,
        zotero: note.zotero,
        createdAt: new Date().toISOString(),
      });
      store.put("session", {
        workspaceId: store.list("workspace")[0].id,
        sourceId: source.id,
        title: "Asynchrony & communication assumptions",
        page: 1,
        status: "active",
        takeaway: "",
        createdAt: new Date().toISOString(),
      });
    }
    store.setting("initialized", true);
  }
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
      return res
        .status(403)
        .json({ error: "This application accepts only local requests." });
    const allowedOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ];
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin))
      return res
        .status(403)
        .json({ error: "Cross-origin requests are not allowed." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    if (req.path.startsWith("/api")) {
      res.setHeader("Cache-Control", "no-store");
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-margin-token"] !== token
      )
        return res
          .status(403)
          .json({ error: "Reload Margin to reconnect to the local server." });
    }
    next();
  });
  app.use(express.json({ limit: "12mb" }));
  const get = (kind, id) => {
    const item = store.get(kind, id);
    if (!item) throw fail(`${kind} not found.`, 404);
    return item;
  };
  const sourceMeta = ({ pages, file, localFile, fingerprint, ...source }) => ({
    ...source,
    pageCount: pages.length,
    hasFile: !!(file || localFile),
  });
  const vaultStatus = () => ({
    root: vault.root,
    count: vault.notes.length,
    links: vault.notes.reduce((n, item) => n + item.links.length, 0),
    types: Object.fromEntries(
      ["MOC", "definition", "theorem", "literature", "tool", "note"].map(
        (t) => [t, vault.notes.filter((n) => n.type === t).length],
      ),
    ),
    warnings: vault.warnings,
    indexedAt: vault.indexedAt,
  });
  const config = () => ({
    vault: vaultStatus(),
    aiConfigured: aiConfigured(),
    aiEnabled:
      aiConfigured() &&
      (provider() === "ollama"
        ? store.setting("localAiEnabled") !== false
        : !!store.setting("aiEnabled")),
    ...selectedModel(),
    localModel: localModel(),
    openaiConfigured: !!apiKey,
    chatModels: chatModels(),
    cloudModelError,
    models,
    modelError,
    embeddingModel: embeddingModel(),
    semantic: retrieval.statusFor(vault.notes, embeddingModel()),
    zoteroDir: store.setting("zoteroDir") || zoteroDir,
    linkedDir: store.setting("linkedDir") || "",
    bridge: !!store.setting("bridge"),
    port,
    dataDir,
  });
  const sessionArtifacts = (id) =>
    store
      .list("artifact")
      .filter((a) => a.sessionId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  async function sourcePdf(source) {
    if (source.localFile) {
      const file = await checkedPdf(source.localFile, library().roots);
      if (file.fingerprint !== source.fingerprint)
        throw fail(
          "This Zotero PDF changed. Reopen the literature note to refresh its extracted text.",
        );
      return file.path;
    }
    if (!source.file || basename(source.file) !== source.file)
      throw fail("This source has no PDF.", 404);
    return resolve(uploads, source.file);
  }
  const intake = new Intake({
    store,
    retrieval,
    ollama,
    getSource: (id) => get("source", id),
    getFile: sourcePdf,
    getNotes: async () => {
      if (vault.root) await reindex(vault.root);
      return vault.notes;
    },
    getModels: () => models,
    ...(intakeExtractors ? { extractors: intakeExtractors } : {}),
  });
  function layoutFor(sourceId, revision) {
    const current = store.get("documentLayout", `layout:${sourceId}`);
    return !revision || current?.revision === revision
      ? current
      : store.get("layoutSnapshot", `layout-version:${sourceId}:${revision}`);
  }
  function queueIntake(source) {
    if (source.kind === "pdf" && !intake.state(source.id).layout)
      intake.start(source.id);
    return sourceMeta(source);
  }
  app.get("/api/sources/:id/regions", (req, res) => {
    get("source", req.params.id);
    res.json(intake.state(req.params.id));
  });
  app.post("/api/sources/:id/intake", (req, res) => {
    const input = z
      .object({
        extractor: z.enum(["native", "paddle"]).default("native"),
        model: z.string().max(200).default(""),
        force: z.boolean().default(false),
      })
      .parse(req.body);
    res.json(intake.start(req.params.id, input));
  });
  app.post("/api/sources/:id/intake/cancel", (req, res) => {
    get("source", req.params.id);
    res.json(intake.cancel(req.params.id));
  });
  app.get("/api/sources/:id/chunks", async (req, res) => {
    const source = get("source", req.params.id);
    await sourcePdf(source);
    // Check freshness against disk, not just the potentially older browser index.
    const current = vault.root ? (await scanVault(vault.root)).notes : [];
    const contexts = intake.contexts(
      source.id,
      String(req.query.regionId || ""),
      current,
      String(req.query.revision || ""),
    );
    res.json({
      schemaVersion: 1,
      sourceId: source.id,
      ...intake.state(source.id),
      contexts,
    });
  });
  const requireAnchor = (anchor, source) => {
    if (
      anchor &&
      (anchor.sourceId !== source.id || anchor.page > source.pages.length)
    )
      throw fail("The selected source position is invalid.");
    if (anchor?.regionId) {
      const layout = layoutFor(source.id, anchor.revision);
      const region = layout?.regions.find((r) => r.id === anchor.regionId);
      if (
        !region ||
        region.page !== anchor.page ||
        (anchor.revision && anchor.revision !== layout.revision)
      )
        throw fail("This region changed. Select it again in the PDF.");
    }
  };
  app.get("/api/bootstrap", (req, res) =>
    res.json({
      token,
      config: config(),
      workspaces: store.list("workspace"),
      sources: store.list("source").map(sourceMeta),
      sessions: store.list("session"),
      promotions: store.list("promotion").map(({ before, after, ...p }) => p),
      relationships: store.list("relationship"),
    }),
  );
  app.get("/api/notes", (req, res) =>
    res.json(
      searchNotes(vault.notes, String(req.query.q || ""), {
        type: req.query.type ? String(req.query.type) : undefined,
        limit: 80,
      }),
    ),
  );
  app.get("/api/note", (req, res) => {
    const note = vault.notes.find((n) => n.path === req.query.path);
    if (!note) throw fail("Note not found. Refresh the vault index.", 404);
    res.json({
      ...note,
      backlinks: vault.notes.flatMap((n) =>
        n.links
          .filter((l) =>
            resolveLinks(vault.notes, l.target, n.path).some(
              (t) => t.path === note.path,
            ),
          )
          .map((l) => ({ path: n.path, title: n.title, ...l })),
      ),
    });
  });
  app.get("/api/related", (req, res) => {
    const source = req.query.sourceId
      ? get("source", req.query.sourceId)
      : null;
    const current = vault.notes.find((n) => n.path === source?.notePath);
    const explicit = current
      ? current.links.flatMap((l) =>
          resolveLinks(vault.notes, l.target, current.path).map((n) => ({
            path: n.path,
            title: n.title,
            type: n.type,
            section: l.section,
            line: l.line,
            excerpt: l.evidence,
            reason: `Explicit link in ${l.section}`,
            score: 100,
            relation: "explicit-link",
          })),
        )
      : [];
    const query = String(req.query.q || source?.title || "");
    const matches = searchNotes(vault.notes, query, {
      limit: 12,
      exclude: current?.path,
    });
    const seen = new Set();
    res.json(
      [...matches, ...explicit]
        .filter((n) => {
          if (seen.has(n.path)) return false;
          seen.add(n.path);
          return true;
        })
        .slice(0, 10),
    );
  });
  app.post("/api/settings", async (req, res) => {
    const input = z
      .object({
        vaultRoot: z.string().max(2000).optional(),
        aiEnabled: z.boolean().optional(),
        model: z.string().trim().min(1).max(100).optional(),
        bridge: z.boolean().optional(),
        provider: z.enum(["ollama", "openai"]).optional(),
        ollamaModel: z.string().trim().min(1).max(200).optional(),
        embeddingModel: z.string().optional(),
        localAiEnabled: z.boolean().optional(),
        zoteroDir: z.string().optional(),
        linkedDir: z.string().optional(),
      })
      .parse(req.body);
    // Validate before persisting any settings so a failed switch is atomic.
    if (
      input.ollamaModel !== undefined &&
      !chatModels().some(
        (m) => m.provider === "ollama" && m.name === input.ollamaModel,
      )
    )
      throw fail("Choose an available Ollama chat model, then refresh models.");
    if (input.provider === "openai" && !apiKey)
      throw fail(
        "Set OPENAI_API_KEY in .env and restart Margin to use OpenAI.",
      );
    if (
      input.model !== undefined &&
      !cloudModels.some((m) => m.name === input.model)
    )
      throw fail("Choose an available OpenAI text model, then refresh models.");
    if (input.vaultRoot !== undefined && input.vaultRoot !== vault.root)
      await reindex(input.vaultRoot);
    for (const key of [
      "aiEnabled",
      "model",
      "bridge",
      "provider",
      "ollamaModel",
      "embeddingModel",
      "localAiEnabled",
      "zoteroDir",
      "linkedDir",
    ])
      if (input[key] !== undefined) store.setting(key, input[key]);
    res.json(config());
  });
  app.post("/api/models/refresh", async (req, res) => {
    await refreshModels();
    res.json(config());
  });
  app.get("/api/semantic", (req, res) =>
    res.json(retrieval.statusFor(vault.notes, embeddingModel())),
  );
  app.post("/api/semantic/build", (req, res) => {
    if (retrieval.status.running) throw fail("Indexing is already running.");
    if (!embeddingModel()) throw fail("Choose an embedding model first.");
    void retrieval.build(vault.notes, embeddingModel());
    res.json(retrieval.statusFor(vault.notes, embeddingModel()));
  });
  app.get("/api/zotero/attachments", async (req, res) => {
    const note = await freshNote(String(req.query.path || ""));
    const attachments = await library().attachments(note);
    res.json(attachments.map(({ path, fingerprint, ...a }) => a));
  });
  app.post("/api/reindex", async (req, res) => {
    await reindex(vault.root || store.setting("vaultRoot"));
    res.json(vaultStatus());
  });
  app.post("/api/workspaces", (req, res) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(120),
        question: z.string().max(5000).default(""),
      })
      .parse(req.body);
    res.json(
      store.put("workspace", { ...input, createdAt: new Date().toISOString() }),
    );
  });
  app.patch("/api/workspaces/:id", (req, res) =>
    res.json(
      store.put("workspace", {
        ...get("workspace", req.params.id),
        ...z
          .object({
            title: z.string().trim().min(1).max(120).optional(),
            question: z.string().max(5000).optional(),
          })
          .parse(req.body),
      }),
    ),
  );
  app.get("/api/sources/:id", (req, res) => {
    const source = get("source", req.params.id);
    res.json({ ...sourceMeta(source), pages: source.pages });
  });
  app.get("/api/sources/:id/file", async (req, res) => {
    const source = get("source", req.params.id);
    res.type("application/pdf").sendFile(await sourcePdf(source));
  });
  app.post("/api/sources/from-note", async (req, res) => {
    const { path, attachmentId, noteOnly } = z
      .object({
        path: string,
        attachmentId: z.string().optional(),
        noteOnly: z.boolean().optional(),
      })
      .parse(req.body);
    const note = await freshNote(path);
    if (
      !noteOnly &&
      (note.zotero || note.path.split("/").pop().startsWith("@"))
    ) {
      const attachments = await library().attachments(note);
      const attachment = attachmentId
        ? attachments.find((a) => a.id === attachmentId)
        : attachments.length === 1
          ? attachments[0]
          : null;
      if (!attachment)
        throw fail(
          attachments.length
            ? "Choose the PDF attachment to open."
            : "No PDF attachment found in Zotero. Attach or download the paper in Zotero, then retry.",
        );
      if (!attachment.available) throw fail(attachment.error);
      const existing = store
        .list("source")
        .find(
          (s) =>
            s.notePath === path &&
            s.attachmentId === attachment.id &&
            s.fingerprint === attachment.fingerprint,
        );
      if (existing) return res.json(queueIntake(existing));
      const pdf = await library().extract(attachment);
      return res.json(
        queueIntake(
          store.put("source", {
            title: note.title,
            authors: String(note.metadata.authors || ""),
            year: note.metadata.year,
            kind: "pdf",
            pages: pdf.pages,
            localFile: pdf.path,
            fingerprint: pdf.fingerprint,
            attachmentId: attachment.id,
            notePath: path,
            zotero: attachment.zotero,
            provenance: "Local Zotero attachment",
            createdAt: new Date().toISOString(),
          }),
        ),
      );
    }
    const existing = store
      .list("source")
      .find(
        (s) =>
          s.notePath === path &&
          s.kind === "reading-note" &&
          s.pages[0] === note.body,
      );
    res.json(
      sourceMeta(
        existing ||
          store.put("source", {
            title: note.title,
            authors: String(note.metadata.authors || ""),
            kind: "reading-note",
            pages: [note.body],
            notePath: path,
            zotero: note.zotero,
            createdAt: new Date().toISOString(),
          }),
      ),
    );
  });
  app.post("/api/sources/text", (req, res) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(500),
        text: string,
        authors: z.string().max(500).default(""),
        zotero: z.string().max(2000).default(""),
        kind: z
          .enum(["source-excerpt", "reading-note"])
          .default("source-excerpt"),
      })
      .parse(req.body);
    const { text, ...rest } = input;
    res.json(
      sourceMeta(
        store.put("source", {
          ...rest,
          pages: [text],
          createdAt: new Date().toISOString(),
        }),
      ),
    );
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 32 * 1024 * 1024,
      fieldSize: 10 * 1024 * 1024,
      files: 1,
    },
  });
  app.post("/api/sources/pdf", upload.single("file"), (req, res) => {
    if (
      !req.file ||
      !req.file.buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))
    )
      throw fail("Choose a valid PDF, up to 32 MB.");
    const pages = z
      .array(z.string().max(200000))
      .min(1)
      .max(3000)
      .parse(JSON.parse(req.body.pages || "[]"));
    const id = randomUUID(),
      file = `${id}.pdf`;
    writeFileSync(resolve(uploads, file), req.file.buffer, { flag: "wx" });
    res.json(
      queueIntake(
        store.put("source", {
          id,
          title: String(
            req.body.title || req.file.originalname.replace(/\.pdf$/i, ""),
          ).slice(0, 500),
          kind: "pdf",
          authors: "",
          pages,
          file,
          createdAt: new Date().toISOString(),
        }),
      ),
    );
  });
  app.post("/api/sessions", (req, res) => {
    const input = z
      .object({
        workspaceId: string,
        sourceId: string,
        title: z.string().max(200).optional(),
      })
      .parse(req.body);
    get("workspace", input.workspaceId);
    const source = get("source", input.sourceId);
    res.json(
      store.put("session", {
        ...input,
        title: input.title || source.title,
        page: 1,
        status: "active",
        takeaway: "",
        createdAt: new Date().toISOString(),
      }),
    );
  });
  app.get("/api/sessions/:id", (req, res) =>
    res.json({
      ...get("session", req.params.id),
      artifacts: sessionArtifacts(req.params.id),
      relationships: store
        .list("relationship")
        .filter((r) => r.sessionId === req.params.id),
    }),
  );
  app.patch("/api/sessions/:id", (req, res) => {
    const session = get("session", req.params.id),
      source = get("source", session.sourceId);
    const input = z
      .object({
        page: z.number().int().min(1).max(source.pages.length).optional(),
        title: z.string().trim().min(1).max(500).optional(),
        status: z.enum(["active", "paused", "complete"]).optional(),
        takeaway: z.string().max(10000).optional(),
        nextStep: z.string().max(10000).optional(),
        revisitAt: z.string().optional(),
      })
      .parse(req.body);
    res.json(store.put("session", { ...session, ...input }));
  });
  app.post("/api/sessions/:id/artifacts", (req, res) => {
    const session = get("session", req.params.id),
      input = artifactSchema.parse(req.body);
    requireAnchor(input.anchor, get("source", session.sourceId));
    res.json(
      store.put("artifact", {
        ...input,
        sessionId: session.id,
        origin: "user",
        createdAt: new Date().toISOString(),
      }),
    );
  });
  app.patch("/api/artifacts/:id", (req, res) => {
    const artifact = get("artifact", req.params.id);
    const input = z
      .object({ status: z.enum(["open", "revisit", "understood"]) })
      .parse(req.body);
    if (artifact.origin !== "user")
      throw fail("Learning status applies to your own writing.");
    res.json(store.put("artifact", { ...artifact, ...input }));
  });
  app.post("/api/sessions/:id/prompt", (req, res) => {
    const session = get("session", req.params.id),
      source = get("source", session.sourceId);
    const input = z
      .object({
        anchor: anchorSchema.optional(),
        mode: z
          .enum(["recall", "assumptions", "connect", "proof", "synthesize"])
          .default("recall"),
      })
      .parse(req.body);
    requireAnchor(input.anchor, source);
    res.json(
      store.put("artifact", {
        ...recallPrompt(
          source,
          input.anchor || { sourceId: source.id, page: session.page },
          input.mode,
        ),
        sessionId: session.id,
        createdAt: new Date().toISOString(),
      }),
    );
  });
  app.post("/api/sessions/:id/tutor", async (req, res) => {
    if (!config().aiEnabled)
      throw fail(
        "Choose an available model in the prompt box or enable tutoring in Settings.",
      );
    // Keep the provider/model pair stable if another tab switches during retrieval.
    const selected = selectedModel();
    const session = get("session", req.params.id),
      source = get("source", session.sourceId);
    const input = z
      .object({
        text: string,
        anchor: anchorSchema.optional(),
        mode: z
          .enum([
            "discuss",
            "recall",
            "assumptions",
            "connect",
            "proof",
            "synthesize",
            "edit",
          ])
          .default("discuss"),
      })
      .parse(req.body);
    requireAnchor(input.anchor, source);
    store.put("artifact", {
      ...input,
      kind: "question",
      origin: "user",
      status: "open",
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    });
    const currentNotes =
      input.anchor?.regionId && vault.root
        ? (await scanVault(vault.root)).notes
        : vault.notes;
    const retrieved = await retrieval.retrieve(
      currentNotes,
      `${input.text} ${input.anchor?.quote || source.pages[session.page - 1]?.slice(0, 800) || source.title}`,
      source,
      embeddingModel(),
    );
    const notes = retrieved.notes;
    const history = sessionArtifacts(session.id);
    const researchQuestion = get("workspace", session.workspaceId).question;
    const routed =
      selected.provider === "ollama" && selected.model === AUTO_LOCAL_MODEL
        ? await routeLocal(ollama, {
            question: input.text,
            mode: input.mode,
            anchor: input.anchor,
            history,
            researchQuestion,
          })
        : null;
    let chunkContext = [];
    if (input.anchor?.regionId) {
      await sourcePdf(source);
      const current = currentNotes;
      const layout = layoutFor(source.id, input.anchor.revision);
      const selectedRegion = layout?.regions.find(
        (r) => r.id === input.anchor.regionId,
      );
      const ids = new Set([selectedRegion?.id, selectedRegion?.parentId]);
      chunkContext = intake
        .contexts(source.id, "", current, input.anchor.revision)
        .filter((c) => ids.has(c.regionId) && !c.stale)
        .slice(0, 3);
    }
    const answer = await askTutor({
      chunkContext,
      question: input.text,
      source,
      anchor: input.anchor || { sourceId: source.id, page: session.page },
      notes,
      history,
      model: routed?.model || selected.model,
      provider: selected.provider,
      ollama,
      mode: input.mode,
      researchQuestion,
      key: apiKey,
      fetchImpl,
    });
    res.json(
      store.put("artifact", {
        ...answer,
        cloud: selected.cloud,
        ...(routed ? { routing: routed.routing } : {}),
        retrievalWarning: retrieved.warning,
        sessionId: session.id,
        anchor: input.anchor,
        createdAt: new Date().toISOString(),
      }),
    );
  });
  app.get("/api/history", (req, res) => {
    const q = String(req.query.q || "").toLowerCase();
    res.json(
      store
        .list("artifact")
        .filter(
          (a) =>
            !q ||
            (a.text + " " + (a.assumptions || "")).toLowerCase().includes(q),
        )
        .slice(0, 150),
    );
  });
  app.post("/api/relationships", (req, res) => {
    const input = z
      .object({
        sessionId: string,
        notePath: string,
        relation: z.enum([
          "related-to",
          "uses",
          "contrasts-with",
          "generalizes",
          "example-of",
        ]),
        evidence: string,
        anchor: anchorSchema.optional(),
      })
      .parse(req.body);
    const session = get("session", input.sessionId);
    if (!vault.notes.some((n) => n.path === input.notePath))
      throw fail("Choose an existing vault note.");
    requireAnchor(input.anchor, get("source", session.sourceId));
    res.json(
      store.put("relationship", {
        ...input,
        origin: "user",
        status: "accepted-by-user",
        createdAt: new Date().toISOString(),
      }),
    );
  });
  app.post("/api/promotions", async (req, res) => {
    if (!vault.root) throw fail("Connect your Obsidian vault first.");
    const input = z
      .object({
        sessionId: string,
        artifactIds: z.array(z.string()).min(1),
        path: string,
        mode: z.enum(["append", "summary", "new"]),
        heading: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((s) => !/[\r\n]/.test(s))
          .default("Intuition"),
        title: z.string().max(300).default(""),
        noteType: z
          .enum(["theorem", "definition", "idea", "MOC", "literature_note"])
          .default("idea"),
        text: string,
        links: z.array(z.string()).default([]),
      })
      .parse(req.body);
    const session = get("session", input.sessionId),
      source = get("source", session.sourceId);
    const artifacts = input.artifactIds.map((id) => get("artifact", id));
    if (
      artifacts.some((a) => a.sessionId !== session.id || a.origin !== "user")
    )
      throw fail(
        "Promote your own captured writing from this session. AI output remains separate.",
      );
    if (input.mode === "new") {
      if (!input.title.trim() || input.title.includes("\n"))
        throw fail("Provide a note title.");
      if (resolveLinks(vault.notes, input.title).length)
        throw fail(
          "A note with this title or alias already exists. Select the existing note.",
        );
      if (!input.links.length)
        throw fail(
          "Link at least one existing note so this new idea has a home.",
        );
    }
    if (input.links.some((path) => !vault.notes.some((n) => n.path === path)))
      throw fail("A selected connection no longer exists. Refresh the index.");
    const link = `http://127.0.0.1:${port}/?session=${encodeURIComponent(session.id)}`;
    const refs = artifacts
      .map((a) => a.anchor)
      .filter(Boolean)
      .map((a) => `${a.section ? a.section + ", " : ""}page ${a.page}`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ");
    const provenance = `<!-- margin:${randomUUID()} artifacts:${input.artifactIds.join(",")} -->\n> Research history: [Return to this session](${link}).\n> Origin: researcher-written, reviewed promotion. Source: ${source.title.replace(/[\r\n]/g, " ")}${refs ? ` (${refs})` : ""}; ${source.kind === "reading-note" ? "reading-note transcription, not checked against the original" : "source-linked, not automatically verified"}.`;
    const draft = await preparePromotion(vault.root, { ...input, provenance });
    res.json(store.put("promotion", draft));
  });
  app.get("/api/promotions/:id", (req, res) =>
    res.json(get("promotion", req.params.id)),
  );
  const activePromotions = new Set();
  for (const operation of ["apply", "undo"])
    app.post(`/api/promotions/:id/${operation}`, async (req, res) => {
      const draft = get("promotion", req.params.id);
      if (activePromotions.has(draft.path))
        throw fail("This note is already being updated.");
      activePromotions.add(draft.path);
      try {
        const updated = await (
          operation === "apply" ? applyPromotion : undoPromotion
        )(vault.root, draft);
        store.put("promotion", updated);
        const path = await safeNotePath(vault.root, draft.path, {
          allowNew: true,
        });
        vault.notes = vault.notes.filter((n) => n.path !== draft.path);
        if (existsSync(path))
          vault.notes.push(parseNote(draft.path, readFileSync(path, "utf8")));
        res.json(updated);
      } finally {
        activePromotions.delete(draft.path);
      }
    });
  app.post("/api/promotions/:id/discard", (req, res) => {
    const draft = get("promotion", req.params.id);
    if (draft.status !== "draft") throw fail("Only drafts can be discarded.");
    res.json(store.put("promotion", { ...draft, status: "discarded" }));
  });
  app.get("/api/export", (req, res) =>
    res.attachment("margin-research-history.json").json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      workspaces: store.list("workspace"),
      sessions: store.list("session"),
      sources: store.list("source").map(({ file, localFile, ...s }) => s),
      artifacts: store.list("artifact"),
      relationships: store.list("relationship"),
      promotions: store.list("promotion"),
      documentLayouts: store.list("documentLayout"),
      layoutSnapshots: store.list("layoutSnapshot"),
      chunkContexts: store.list("chunkContext"),
      intakeJobs: store.list("intakeJob"),
    }),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use((error, req, res, next) => {
    if (!req.path.startsWith("/api")) return next(error);
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    res
      .status(error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 400))
      .json({ error: error.message || "Request failed." });
  });
  return app;
}
