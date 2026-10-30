import { z } from "zod";
import { resolveReferences, revisionForSource } from "../../references.mjs";
import { getLibraryRecord, searchLibraryRecords } from "../../zotero.mjs";

const MAX_SOURCE_PAGES = 2000;
const MAX_READ_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 10;
const textOf = (page) =>
  typeof page === "string"
    ? page
    : typeof page?.text === "string"
      ? page.text
      : "";
const abort = (signal) => signal?.throwIfAborted();
const publicSource = (source, sourceId) => ({
  sourceId: String(source.id || source.sourceId || sourceId),
  title: String(source.title || "Untitled source"),
  kind: String(source.kind || "source"),
});

const schemas = {
  search: z
    .object({
      sourceId: z.string().trim().min(1).max(200),
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(5),
    })
    .strict(),
  read: z
    .object({
      sourceId: z.string().trim().min(1).max(200),
      page: z.number().int().min(1).max(MAX_SOURCE_PAGES),
      regionId: z.string().max(250).optional(),
      revision: z.string().max(100).optional(),
    })
    .strict(),
  outline: z.object({ sourceId: z.string().trim().min(1).max(200) }).strict(),
  references: z
    .object({
      sourceId: z.string().trim().min(1).max(200),
      labels: z
        .array(z.string().regex(/^\d{1,3}$/))
        .min(1)
        .max(30),
    })
    .strict(),
  librarySearch: z
    .object({
      query: z.string().trim().min(1).max(300),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  libraryGet: z.object({ itemId: z.string().trim().min(1).max(300) }).strict(),
  referenceResolve: z
    .object({
      sourceId: z.string().trim().min(1).max(200),
      labels: z
        .array(z.string().regex(/^\d{1,3}$/))
        .min(1)
        .max(30),
    })
    .strict(),
};

function makeTool(name, description, schema, execute) {
  return {
    name,
    description,
    schema,
    async execute(args, context = {}) {
      const parsed = schema.parse(args);
      return execute(parsed, context);
    },
  };
}

async function loadSource(getSource, sourceId, signal) {
  abort(signal);
  const source = await getSource(sourceId, { signal });
  abort(signal);
  if (!source || !Array.isArray(source.pages))
    throw new Error(
      "The registered source is unavailable or has no extracted pages.",
    );
  if (source.pages.length > MAX_SOURCE_PAGES)
    throw new Error(
      `The source exceeds the ${MAX_SOURCE_PAGES}-page access limit.`,
    );
  return source;
}

function metadataEvidence(source, revision, kind, locator, text) {
  return {
    sourceId: String(source.id || source.sourceId),
    revision,
    sourceRevision: revision,
    title: String(source.title || "Untitled source"),
    kind,
    locator,
    ...(locator.page ? { page: locator.page } : {}),
    ...(locator.label ? { referenceLabel: locator.label } : {}),
    text,
    provenance: {
      origin: source.kind === "pdf" ? "source" : "note",
      method: "registered-source-read",
      authorship: source.kind === "pdf" ? "source-author" : "not-inferred",
      status: "unverified",
    },
  };
}

async function register(registerEvidence, input, context) {
  if (typeof registerEvidence !== "function") return undefined;
  abort(context.signal);
  const evidence = await registerEvidence(input, context.toolCallId);
  abort(context.signal);
  return typeof evidence === "string"
    ? evidence
    : evidence?.id || evidence?.evidenceId;
}

async function searchSourcePages(source, query, limit, signal) {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = [];
  for (let index = 0; index < source.pages.length; index++) {
    abort(signal);
    if (index > 0 && index % 25 === 0)
      await new Promise((resolve) => setImmediate(resolve));
    abort(signal);
    const text = textOf(source.pages[index]);
    const lower = text.toLocaleLowerCase();
    if (!lower || !terms.every((term) => lower.includes(term))) continue;
    const hit = Math.max(0, lower.indexOf(terms[0]));
    const start = Math.max(0, hit - 450);
    const end = Math.min(text.length, hit + 1100);
    matches.push({
      page: index + 1,
      text: text.slice(start, end),
      truncated: start > 0 || end < text.length,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

async function sourceOutline(source, signal) {
  const results = [];
  for (
    let index = 0;
    index < source.pages.length && results.length < 100;
    index++
  ) {
    abort(signal);
    if (index > 0 && index % 25 === 0)
      await new Promise((resolve) => setImmediate(resolve));
    abort(signal);
    const lines = textOf(source.pages[index]).split(/\r?\n/u);
    for (const line of lines) {
      const match = line.match(/^\s{0,4}(#{1,6})\s+(.+?)\s*#*\s*$/u);
      const numbered = line.match(
        /^\s{0,4}(?:(\d+(?:\.\d+)*)(?:[.)])?\s+)([A-Z][^.!?]{2,100})\s*$/u,
      );
      const title = match?.[2] || numbered?.[2];
      if (!title) continue;
      results.push({
        page: index + 1,
        level: match ? match[1].length : numbered[1].split(".").length,
        title: title.slice(0, 200),
      });
      if (results.length >= 100) break;
    }
  }
  return results;
}

async function resolveAndRegister({
  source,
  labels,
  store,
  registerEvidence,
  context,
}) {
  const resolution = await resolveReferences(source, labels, {
    store,
    signal: context.signal,
  });
  for (const entry of resolution.entries) {
    if (entry.candidates?.length) {
      for (const candidate of entry.candidates) {
        candidate.evidenceId = await register(
          registerEvidence,
          metadataEvidence(
            source,
            resolution.revision,
            "paper-reference",
            {
              page: candidate.page,
              pages: candidate.pages,
              span: candidate.span,
              label: entry.label,
              referenceId: entry.id,
            },
            candidate.text,
          ),
          context,
        );
      }
    } else if (entry.text) {
      entry.evidenceId = await register(
        registerEvidence,
        metadataEvidence(
          source,
          resolution.revision,
          "paper-reference",
          {
            page: entry.page,
            pages: entry.pages,
            span: entry.span,
            label: entry.label,
            referenceId: entry.id,
          },
          entry.text,
        ),
        context,
      );
    }
  }
  return resolution;
}

/** Narrow, read-only source/library tools over source IDs already registered in Margin. */
export function createSourceTools({ store, getSource, registerEvidence }) {
  if (!store || typeof getSource !== "function")
    throw new TypeError(
      "createSourceTools requires a store and source accessor.",
    );
  return [
    makeTool(
      "source.search",
      "Search extracted text in one registered source. Returns a small set of page-anchored excerpts.",
      schemas.search,
      async ({ sourceId, query, limit }, context) => {
        const source = await loadSource(getSource, sourceId, context.signal);
        const revision = revisionForSource(source);
        const results = [];
        for (const hit of await searchSourcePages(
          source,
          query,
          limit,
          context.signal,
        )) {
          hit.evidenceId = await register(
            registerEvidence,
            metadataEvidence(
              source,
              revision,
              "source-page-excerpt",
              { page: hit.page },
              hit.text,
            ),
            context,
          );
          results.push(hit);
        }
        return { ...publicSource(source, sourceId), revision, query, results };
      },
    ),
    makeTool(
      "source.read",
      "Read one bounded page or exact extracted region from a registered local source and register its excerpt as evidence. For knowledge anchors include page, regionId and extraction revision to read OCR/structured text exactly.",
      schemas.read,
      async (
        { sourceId, page, regionId, revision: extractionRevision },
        context,
      ) => {
        const source = await loadSource(getSource, sourceId, context.signal);
        if (page > source.pages.length)
          throw new Error("The requested page is outside this source.");
        const current = regionId
          ? store.get("documentLayout", `layout:${sourceId}`)
          : null;
        const layout =
          !extractionRevision || extractionRevision === current?.revision
            ? current
            : store.get(
                "layoutSnapshot",
                `layout-version:${sourceId}:${extractionRevision}`,
              );
        const region = layout?.regions.find(
          (r) => r.id === regionId && r.page === page,
        );
        if (regionId && !region)
          throw new Error(
            "The extracted region is unavailable; refresh knowledge preparation or inspect the current page.",
          );
        const raw = region ? region.text : textOf(source.pages[page - 1]);
        const text = raw.slice(0, MAX_READ_CHARS);
        const revision = revisionForSource(source);
        const evidenceId = await register(
          registerEvidence,
          metadataEvidence(
            source,
            revision,
            region ? "source-region" : "source-page",
            {
              page,
              ...(region
                ? {
                    regionId,
                    revision: layout.revision,
                    box: region.box,
                    historical: layout.revision !== current?.revision,
                  }
                : {}),
            },
            text,
          ),
          context,
        );
        return {
          ...publicSource(source, sourceId),
          revision,
          page,
          ...(region
            ? { regionId, extractionRevision: layout.revision, box: region.box }
            : {}),
          text,
          truncated: raw.length > text.length,
          evidenceId,
        };
      },
    ),
    makeTool(
      "source.outline",
      "Return a bounded outline of extracted headings and numbered section titles from a registered source.",
      schemas.outline,
      async ({ sourceId }, context) => {
        const source = await loadSource(getSource, sourceId, context.signal);
        abort(context.signal);
        return {
          ...publicSource(source, sourceId),
          revision: revisionForSource(source),
          headings: await sourceOutline(source, context.signal),
        };
      },
    ),
    makeTool(
      "source.references",
      "Scan all extracted pages of a registered source for the requested numbered bibliography entries.",
      schemas.references,
      async ({ sourceId, labels }, context) => {
        const source = await loadSource(getSource, sourceId, context.signal);
        const result = await resolveAndRegister({
          source,
          labels,
          store: undefined,
          registerEvidence,
          context,
        });
        return { ...publicSource(source, sourceId), ...result };
      },
    ),
    makeTool(
      "library.search",
      "Search metadata for sources and Zotero items already registered in Margin. This tool cannot browse URLs or local paths.",
      schemas.librarySearch,
      async ({ query, limit }, context) => {
        abort(context.signal);
        return { query, items: searchLibraryRecords(store, query, limit) };
      },
    ),
    makeTool(
      "library.get_item",
      "Read metadata for one item ID returned by library.search.",
      schemas.libraryGet,
      async ({ itemId }, context) => {
        abort(context.signal);
        const item = getLibraryRecord(store, itemId);
        if (!item)
          throw new Error(
            "That item is not present in the registered local library.",
          );
        return item;
      },
    ),
    makeTool(
      "reference.resolve",
      "Resolve numbered entries from a registered source and compare exact bibliographic metadata with the registered local library.",
      schemas.referenceResolve,
      async ({ sourceId, labels }, context) => {
        const source = await loadSource(getSource, sourceId, context.signal);
        const result = await resolveAndRegister({
          source,
          labels,
          store,
          registerEvidence,
          context,
        });
        return { ...publicSource(source, sourceId), ...result };
      },
    ),
  ];
}
