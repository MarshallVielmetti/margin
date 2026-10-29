import { realpath, stat, readFile, readdir } from "node:fs/promises";
import { resolve, relative, basename, isAbsolute } from "node:path";

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
      for (let page = 1; page <= doc.numPages; page++) {
        const p = await doc.getPage(page),
          content = await p.getTextContent();
        pages.push(
          content.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join(""),
        );
        p.cleanup();
      }
      return { pages, ...file };
    } finally {
      await doc.destroy();
    }
  }
}
