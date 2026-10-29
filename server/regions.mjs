import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const REGION_VERSION = "regions-1";
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || ArrayBuffer.isView(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const clamp = (n) => Math.max(0, Math.min(1, n));
const union = (boxes) => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3])),
];
const environment =
  /^(Definition|Theorem|Lemma|Proposition|Corollary|Assumption|Remark|Proof)\b[\s\d.:(]/i;
export function regionKind(text) {
  const env = text.match(environment);
  if (env) return env[1].toLowerCase();
  if (
    text.length < 260 &&
    /[=≤≥∑∫∀∈≔]|\\(?:frac|sum|int|begin)\b/.test(text) &&
    text.split(/\s+/).filter((w) => /^[a-zA-Z]{4,}$/.test(w)).length < 7
  )
    return "equation";
  return "paragraph";
}

// Coordinates use the displayed (rotated/cropped) page, normalized to [0,1].
export function nativeBlocks(items, viewport, transform) {
  const pieces = items
    .filter((i) => typeof i.str === "string" && i.str.trim())
    .map((i) => {
      const t = transform(viewport.transform, i.transform);
      const h = Math.hypot(t[2], t[3]) || 10,
        w = Math.abs(i.width * viewport.scale);
      const length = Math.hypot(t[0], t[1]) || 1,
        ux = t[0] / length,
        uy = t[1] / length;
      const corners = [
        [0, -h],
        [w, -h],
        [0, h * 0.18],
        [w, h * 0.18],
      ].map(([x, y]) => [t[4] + ux * x - uy * y, t[5] + uy * x + ux * y]);
      return {
        text: i.str,
        size: h / viewport.height,
        box: [
          clamp(Math.min(...corners.map((p) => p[0])) / viewport.width),
          clamp(Math.min(...corners.map((p) => p[1])) / viewport.height),
          clamp(Math.max(...corners.map((p) => p[0])) / viewport.width),
          clamp(Math.max(...corners.map((p) => p[1])) / viewport.height),
        ],
      };
    })
    .filter((p) => p.box[2] > p.box[0] && p.box[3] > p.box[1]);
  const lines = [];
  for (const piece of pieces.sort(
    (a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0],
  )) {
    const line = lines.findLast(
      (l) =>
        Math.abs(l.box[1] - piece.box[1]) <
          Math.max(l.size, piece.size) * 0.55 &&
        piece.box[0] - l.box[2] < 0.045 &&
        piece.box[0] >= l.box[0] - 0.01,
    );
    if (line) {
      line.text += " " + piece.text;
      line.box = union([line.box, piece.box]);
      line.size = Math.max(line.size, piece.size);
    } else lines.push({ ...piece });
  }
  const median =
    pieces.map((p) => p.size).sort((a, b) => a - b)[
      Math.floor(pieces.length / 2)
    ] || 0.015;
  const blocks = [];
  for (const line of lines) {
    const kind = regionKind(line.text);
    const heading = line.size > median * 1.25 && line.text.length < 180;
    const prev = blocks.findLast(
      (b) =>
        Math.abs(b.box[0] - line.box[0]) < 0.035 &&
        line.box[1] >= b.box[1] &&
        line.box[1] - b.box[3] < Math.max(line.size, b.size) * 0.9,
    );
    if (
      prev &&
      kind === "paragraph" &&
      prev.kind === "paragraph" &&
      !heading &&
      !prev.heading
    ) {
      prev.text += "\n" + line.text;
      prev.box = union([prev.box, line.box]);
    } else
      blocks.push({
        ...line,
        kind: heading && kind === "paragraph" ? "heading" : kind,
        heading,
      });
  }
  return blocks.sort((a, b) => {
    // Prefer column order for non-overlapping columns; headings retain vertical order.
    if (
      a.box[2] < 0.56 &&
      b.box[0] > 0.44 &&
      a.box[3] > b.box[1] &&
      b.box[3] > a.box[1]
    )
      return -1;
    if (
      b.box[2] < 0.56 &&
      a.box[0] > 0.44 &&
      a.box[3] > b.box[1] &&
      b.box[3] > a.box[1]
    )
      return 1;
    return a.box[1] - b.box[1] || a.box[0] - b.box[0];
  });
}

export function makeLayout(sourceId, contentHash, pages, extractor = "native") {
  const regions = [],
    warnings = [];
  pages.forEach((blocks, pageIndex) => {
    const page = pageIndex + 1;
    const root = {
      id: `${sourceId}:p${page}`,
      sourceId,
      page,
      kind: "page",
      text: blocks.map((b) => b.text).join("\n\n"),
      box: [0, 0, 1, 1],
      parentId: null,
      order: 0,
      origin: extractor,
    };
    regions.push(root);
    const children = blocks.map((b, i) => ({
      id: `${sourceId}:${hash([contentHash, extractor, page, b.box, b.text, i]).slice(0, 24)}`,
      sourceId,
      page,
      kind: b.kind,
      text: b.text,
      box: b.box,
      parentId: root.id,
      order: i + 1,
      origin: extractor,
      ...(b.latex ? { latex: b.latex } : {}),
    }));
    // A heuristic semantic group may span several paragraphs and displayed equations.
    // Its label is explicitly provisional, not a mathematical interpretation.
    for (let i = 0; i < children.length; i++) {
      const first = children[i];
      if (!environment.test(first.text)) continue;
      const grouped = [first];
      for (let j = i + 1; j < children.length && grouped.length < 12; j++) {
        const next = children[j],
          prev = grouped.at(-1);
        if (
          environment.test(next.text) ||
          next.kind === "heading" ||
          Math.abs(next.box[0] - first.box[0]) > 0.12 ||
          next.box[1] - prev.box[3] > 0.06
        )
          break;
        grouped.push(next);
      }
      if (grouped.length > 1) {
        const parent = {
          ...first,
          id: `${first.id}:group`,
          text: grouped.map((c) => c.text).join("\n\n"),
          box: union(grouped.map((c) => c.box)),
          heuristic: true,
        };
        grouped.forEach((c) => (c.parentId = parent.id));
        first.kind = "paragraph";
        regions.push(parent);
        i += grouped.length - 1;
      }
    }
    regions.push(...children);
    if (!children.length)
      warnings.push(
        `Page ${page} has no extracted regions. Use PaddleOCR for image-only pages.`,
      );
  });
  return {
    id: `layout:${sourceId}`,
    sourceId,
    schemaVersion: 1,
    extractor,
    version: REGION_VERSION,
    contentHash,
    pageCount: pages.length,
    revision: hash([REGION_VERSION, contentHash, extractor, regions]),
    regions,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

export async function extractNative(sourceId, file, signal) {
  const data = new Uint8Array(await readFile(file));
  const contentHash = hash(data);
  const { getDocument, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  try {
    if (doc.numPages > 2000)
      throw new Error("Region intake supports at most 2,000 pages.");
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(i);
      pages.push(
        nativeBlocks(
          (await page.getTextContent()).items,
          page.getViewport({ scale: 1 }),
          Util.transform,
        ),
      );
      page.cleanup();
    }
    return makeLayout(sourceId, contentHash, pages);
  } finally {
    await doc.destroy();
  }
}

const paddlePage = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  blocks: z
    .array(
      z.object({
        text: z.string().max(200000),
        label: z.string().max(100),
        box: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
      }),
    )
    .max(10000),
});
export function paddleLayout(sourceId, contentHash, raw) {
  const pages = z.array(paddlePage).min(1).max(2000).parse(raw);
  return makeLayout(
    sourceId,
    contentHash,
    pages.map((p) =>
      p.blocks.map((b) => {
        const box = b.box.map((n, i) =>
          clamp(n / (i % 2 ? p.height : p.width)),
        );
        if (box[2] <= box[0] || box[3] <= box[1])
          throw new Error("PaddleOCR returned an invalid region box.");
        const formula = /formula|equation/.test(b.label);
        return {
          text: b.text,
          box,
          kind: formula
            ? "equation"
            : /title/.test(b.label)
              ? "heading"
              : /table/.test(b.label)
                ? "table"
                : /image|figure|chart/.test(b.label)
                  ? "figure"
                  : regionKind(b.text),
          ...(formula ? { latex: b.text } : {}),
        };
      }),
    ),
    "paddle",
  );
}
