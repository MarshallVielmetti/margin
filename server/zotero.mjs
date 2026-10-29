import { realpath, stat, readFile, readdir } from "node:fs/promises";
import { resolve, relative, basename, isAbsolute } from "node:path";

const LIBRARY_KINDS = ["libraryItem", "zoteroItem", "zotero-item", "source"];
const metadataValue = (record, names) => {
  for (const name of names) {
    const value =
      record?.[name] ?? record?.metadata?.[name] ?? record?.itemData?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
};
const displayAuthors = (authors) => {
  if (typeof authors === "string") return authors;
  if (!Array.isArray(authors)) return "";
  return authors
    .map((author) =>
      typeof author === "string"
        ? author
        : [author.firstName, author.lastName].filter(Boolean).join(" "),
    )
    .filter(Boolean)
    .join("; ");
};

export function normalizeDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi\s*:\s*/i, "")
    .replace(/[\s.,;]+$/, "")
    .toLowerCase();
}

/** Inspect PDF.js text-item geometry without changing its extracted text order. */
export function analyzePdfPageLayout(items, view) {
  const textItems = (Array.isArray(items) ? items : []).filter(
    (item) => typeof item?.str === "string" && item.str.trim(),
  );
  const textChars = textItems.reduce((sum, item) => sum + item.str.length, 0);
  if (textChars < 20)
    return {
      status: "no_readable_text",
      layout: "unknown",
      textItems: textItems.length,
      textChars,
      pairedRows: 0,
    };

  const [xMin, yMin, xMax, yMax] = Array.isArray(view) ? view.map(Number) : [];
  const width = xMax - xMin;
  const height = yMax - yMin;
  if (!(width > 0 && height > 0))
    return {
      status: "text_extracted",
      layout: "unknown",
      textItems: textItems.length,
      textChars,
      pairedRows: 0,
    };

  const middle = xMin + width / 2;
  const halfGutter = width * 0.025;
  const rowTolerance = Math.max(2, height * 0.006);
  const rows = new Map();
  for (const item of textItems) {
    const transform = item.transform;
    if (
      (!Array.isArray(transform) && !ArrayBuffer.isView(transform)) ||
      transform.length < 6
    )
      continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const itemWidth = Math.abs(Number(item.width));
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(itemWidth)
    )
      continue;
    const x0 = Math.min(x, x + itemWidth);
    const x1 = Math.max(x, x + itemWidth);
    const rowKey = Math.round((y - yMin) / rowTolerance);
    const row = rows.get(rowKey) || { left: [], right: [], boxes: [] };
    row.boxes.push({ x0, x1 });
    if (x1 <= middle - halfGutter) row.left.push({ x0, x1 });
    if (x0 >= middle + halfGutter) row.right.push({ x0, x1 });
    rows.set(rowKey, row);
  }

  let pairedRows = 0;
  let leftItems = 0;
  let rightItems = 0;
  let fullWidthRows = 0;
  for (const row of rows.values()) {
    leftItems += row.left.length;
    rightItems += row.right.length;
    const gutterOccupied = row.boxes.some(
      ({ x0, x1 }) => x0 < middle + halfGutter && x1 > middle - halfGutter,
    );
    if (row.left.length && row.right.length && !gutterOccupied) pairedRows++;
    if (gutterOccupied) fullWidthRows++;
  }
  const twoColumn = pairedRows >= 4 && leftItems >= 4 && rightItems >= 4;
  const singleColumn = !pairedRows && fullWidthRows >= 3;
  const layout = twoColumn
    ? "two-column"
    : singleColumn
      ? "single-column"
      : "unknown";
  return {
    status: twoColumn ? "ambiguous" : "text_extracted",
    layout,
    textItems: textItems.length,
    textChars,
    pairedRows,
  };
}

/** Return metadata-only records that have already been registered in Margin's local store. */
export function registeredLibraryItems(store) {
  if (!store || typeof store.list !== "function") return [];
  const items = [];
  for (const kind of LIBRARY_KINDS) {
    let records = [];
    try {
      records = store.list(kind) || [];
    } catch {
      continue;
    }
    for (const record of records) {
      if (!record || typeof record.id !== "string") continue;
      const title = metadataValue(record, ["title", "name"]);
      const authors = displayAuthors(
        metadataValue(record, ["authors", "author", "creators"]),
      );
      const year = metadataValue(record, ["year", "date"]);
      const doi = metadataValue(record, ["doi", "DOI"]);
      const citekey = metadataValue(record, [
        "citekey",
        "citationKey",
        "citationkey",
      ]);
      items.push({
        itemId: `${kind}:${record.id}`,
        kind,
        ...(kind === "source" ? { sourceId: record.id } : {}),
        ...(typeof title === "string" ? { title } : {}),
        ...(authors ? { authors } : {}),
        ...(year !== undefined ? { year: String(year).slice(0, 40) } : {}),
        ...(typeof doi === "string" ? { doi: normalizeDoi(doi) } : {}),
        ...(typeof citekey === "string"
          ? { citekey: citekey.replace(/^@/, "") }
          : {}),
      });
    }
  }
  return items;
}

export function searchLibraryRecords(store, query, limit = 10) {
  const terms = String(query || "")
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (!terms.length) return [];
  return registeredLibraryItems(store)
    .map((item) => ({
      item,
      haystack: [item.title, item.authors, item.year, item.doi, item.citekey]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase(),
    }))
    .filter(({ haystack }) => terms.every((term) => haystack.includes(term)))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ item }) => item);
}

export function getLibraryRecord(store, itemId) {
  return registeredLibraryItems(store).find((item) => item.itemId === itemId);
}

const normalizedTitle = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Compare extracted reference text with registered metadata without inventing fields. */
export function matchReferenceToLibrary(referenceText, store) {
  if (!store || typeof store.list !== "function")
    return {
      status: "unavailable",
      reason: "No registered library metadata store was supplied.",
    };
  const items = registeredLibraryItems(store);
  if (!items.length)
    return {
      status: "unavailable",
      reason: "No registered library metadata is available.",
    };
  const text = String(referenceText || "");
  const doiMatch = text.match(
    /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\s*:\s*)?(10\.\d{4,9}\/[A-Z0-9._;()/:+-]+)/i,
  );
  const entryDoi = normalizeDoi(doiMatch?.[1]);
  if (entryDoi) {
    const matches = items.filter((item) => normalizeDoi(item.doi) === entryDoi);
    if (matches.length === 1)
      return {
        status: "matched",
        itemId: matches[0].itemId,
        title: matches[0].title,
        matchedBy: "exact_doi",
      };
    if (matches.length > 1)
      return {
        status: "ambiguous",
        itemIds: matches.map((item) => item.itemId),
        matchedBy: "exact_doi",
      };
  }
  const normalizedText = normalizedTitle(text);
  const exactTitles = items.filter((item) => {
    const title = normalizedTitle(item.title);
    return title.length >= 18 && normalizedText.includes(title);
  });
  const textYears = new Set(
    text.match(/\b(?:1[5-9]\d{2}|20\d{2}|2100)\b/g) || [],
  );
  const titleAndYear = exactTitles.filter((item) => {
    const year = String(item.year || "").match(
      /(?:1[5-9]\d{2}|20\d{2}|2100)/,
    )?.[0];
    return year && textYears.has(year);
  });
  if (titleAndYear.length === 1)
    return {
      status: "matched",
      itemId: titleAndYear[0].itemId,
      title: titleAndYear[0].title,
      matchedBy: "exact_title_and_year",
    };
  if (titleAndYear.length > 1)
    return {
      status: "ambiguous",
      itemIds: titleAndYear.map((item) => item.itemId),
      matchedBy: "exact_title_and_year",
    };
  if (exactTitles.length)
    return {
      status: "candidate",
      itemIds: exactTitles.map((item) => item.itemId),
      matchedBy: "exact_title_only",
    };
  return {
    status: "unmatched",
    reason:
      "No exact DOI or sufficiently strong title metadata match was found.",
  };
}

export function citationKey(note) {
  const key =
    note.metadata?.citekey ||
    note.metadata?.citationKey ||
    note.metadata?.citationkey ||
    note.content?.match(/zotero:\/\/select\/items\/@([^\s)]+)/)?.[1] ||
    basename(note.path, ".md").match(/^@(.+)$/)?.[1];
  return typeof key === "string" ? key.replace(/^@/, "") : "";
}
export async function checkedPdf(path, roots) {
  const canonical = await realpath(path).catch(() => {
    throw new Error(
      "The Zotero attachment is missing locally. Download it in Zotero, then retry.",
    );
  });
  const allowed = await Promise.all(
    roots.filter(Boolean).map((r) => realpath(r).catch(() => "")),
  );
  if (
    !allowed.some((root) => {
      if (!root) return false;
      const rel = relative(root, canonical);
      return rel && !rel.startsWith("..") && !isAbsolute(rel);
    })
  )
    throw new Error(
      "This PDF is outside Zotero storage. Set its linked-attachment folder in Margin Settings.",
    );
  const info = await stat(canonical);
  if (
    !info.isFile() ||
    info.size > 200 * 1024 * 1024 ||
    !canonical.toLowerCase().endsWith(".pdf")
  )
    throw new Error("Choose a local PDF attachment smaller than 200 MB.");
  return { path: canonical, fingerprint: `${info.size}:${info.mtimeMs}` };
}
export class ZoteroLibrary {
  constructor({ dataDir, linkedDir = "", fetchImpl = fetch }) {
    Object.assign(this, { dataDir, linkedDir, fetch: fetchImpl });
  }
  get roots() {
    return [resolve(this.dataDir, "storage"), this.linkedDir];
  }
  async rpc(method, params) {
    const response = await this.fetch(
      "http://127.0.0.1:23119/better-bibtex/json-rpc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok)
      throw new Error("Zotero’s Better BibTeX service is unavailable.");
    const body = await response.json();
    if (body.error)
      throw new Error(String(body.error.message || "Zotero lookup failed."));
    return body.result;
  }
  async attachments(note) {
    let key = citationKey(note),
      raw;
    const itemKey = note.content?.match(
      /zotero:\/\/(?:open-pdf|select)\/(?:library\/items|items)\/([A-Z0-9]{8})(?:[/?#\s)]|$)/,
    )?.[1];
    if (itemKey) {
      const dir = resolve(this.dataDir, "storage", itemKey);
      const files = await readdir(dir).catch(() => []);
      raw = files
        .filter((f) => f.toLowerCase().endsWith(".pdf"))
        .map((f) => ({
          path: resolve(dir, f),
          open: `zotero://open-pdf/library/items/${itemKey}`,
        }));
    }
    if (!raw?.length) {
      try {
        if (!key && itemKey) {
          const keys = await this.rpc("item.citationkey", {
            item_keys: [itemKey],
          });
          key = keys[itemKey] || keys[`1:${itemKey}`] || "";
        }
        if (!key) return [];
        raw = await this.rpc("item.attachments", { citekey: key });
      } catch {
        throw new Error(
          "Could not resolve this note in Zotero. Keep Zotero open with Better BibTeX enabled and check the note’s citation key.",
        );
      }
    }
    const items = [];
    for (const a of raw || []) {
      if (!a.path?.toLowerCase().endsWith(".pdf")) continue;
      const id = a.open?.match(/items\/([A-Z0-9]{8})/)?.[1];
      if (!id) continue;
      try {
        const file = await checkedPdf(a.path, this.roots);
        items.push({
          id,
          title: basename(file.path),
          ...file,
          zotero: a.open,
          available: true,
        });
      } catch (e) {
        items.push({
          id,
          title: basename(a.path),
          zotero: a.open,
          available: false,
          error: e.message,
        });
      }
    }
    return items;
  }
  async extract(attachment) {
    const file = await checkedPdf(attachment.path, this.roots);
    const data = new Uint8Array(await readFile(file.path));
    if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
      throw new Error("The Zotero attachment is not a readable PDF.");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
    try {
      if (doc.numPages > 2000)
        throw new Error("This PDF exceeds the 2,000-page limit.");
      const pages = [];
      const pageQuality = [];
      for (let page = 1; page <= doc.numPages; page++) {
        const p = await doc.getPage(page),
          content = await p.getTextContent();
        const text = content.items
          .map((i) => i.str + (i.hasEOL ? "\n" : " "))
          .join("");
        pages.push(text);
        pageQuality.push({
          page,
          ...analyzePdfPageLayout(content.items, p.view),
        });
        p.cleanup();
      }
      const hasUnextractablePages = pageQuality.some(
        (item) => item.status === "no_readable_text",
      );
      const hasAmbiguousLayout = pageQuality.some(
        (item) => item.layout === "two-column",
      );
      return {
        pages,
        extraction: {
          method: "pdfjs-text",
          parserVersion: "pdfjs-layout-v1",
          status: hasAmbiguousLayout
            ? "ambiguous"
            : hasUnextractablePages
              ? "partial"
              : "text_extracted",
          pages: pageQuality,
        },
        ...file,
      };
    } finally {
      await doc.destroy();
    }
  }
}
