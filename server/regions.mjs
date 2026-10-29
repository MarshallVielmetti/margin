import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const REGION_VERSION = "regions-3";
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
  /^(Definition|Theorem|Lemma|Proposition|Corollary|Assumption|Remark|Proof)\b(?:\s+\d+(?:\.\d+)*[A-Za-z]?(?:\s*[:.(]|\s*$)|\s*[:.(])/i;
export function regionKind(text) {
  const env = text.match(environment);
  if (env) return env[1].toLowerCase();
  if (
    text.length < 260 &&
    /[=≤≥∑∫∀∈≔]|\\(?:frac|sum|int|begin)\b/.test(text) &&
    (text.match(/\b[A-Za-z]{3,}\b/g) || []).length < 3
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
        baseline: t[5] / viewport.height,
        box: [
          clamp(Math.min(...corners.map((p) => p[0])) / viewport.width),
          clamp(Math.min(...corners.map((p) => p[1])) / viewport.height),
          clamp(Math.max(...corners.map((p) => p[0])) / viewport.width),
          clamp(Math.max(...corners.map((p) => p[1])) / viewport.height),
        ],
      };
    })
    .filter((p) => p.box[2] > p.box[0] && p.box[3] > p.box[1]);
  const median =
    pieces.map((p) => p.size).sort((a, b) => a - b)[
      Math.floor(pieces.length / 2)
    ] || 0.015;
  // A persistent low-occupancy vertical band identifies a narrow two-column gutter.
  // Classify fragments before line grouping so mathematical tokens cannot bridge it.
  const body = pieces.filter(
    (p) =>
      p.box[2] - p.box[0] > 0.12 &&
      p.box[2] - p.box[0] < 0.7 &&
      p.size <= median * 1.2,
  );
  const cuts = Array.from({ length: 17 }, (_, i) => 0.42 + i * 0.01)
    .map((cut) => ({
      cut,
      fragmentCrossing: pieces.filter(
        (p) =>
          p.box[2] - p.box[0] < 0.7 &&
          p.box[0] < cut - 0.002 &&
          p.box[2] > cut + 0.002,
      ).length,
      crossing: body.filter(
        (p) => p.box[0] < cut - 0.002 && p.box[2] > cut + 0.002,
      ).length,
      left: body.filter((p) => p.box[2] <= cut + 0.002).length,
      right: body.filter((p) => p.box[0] >= cut - 0.002).length,
    }))
    .filter(
      (c) =>
        body.length >= 2 &&
        c.left >= 1 &&
        c.right >= 1 &&
        Math.min(c.left, c.right) >= body.length * 0.2 &&
        c.crossing <= body.length * 0.08,
    )
    .sort(
      (a, b) =>
        a.crossing - b.crossing ||
        a.fragmentCrossing - b.fragmentCrossing ||
        Math.abs(a.cut - 0.5) - Math.abs(b.cut - 0.5),
    );
  const gutter = cuts[0]?.cut;
  for (const piece of pieces)
    piece.column =
      gutter === undefined
        ? 0
        : piece.box[0] < gutter &&
            piece.box[2] > gutter &&
            piece.box[2] - piece.box[0] > 0.5
          ? "full"
          : (piece.box[0] + piece.box[2]) / 2 < gutter
            ? 0
            : 1;
  const lines = [];
  const main = pieces.filter((p) => p.size >= median * 0.85);
  const scripts = pieces.filter((p) => p.size < median * 0.85);
  for (const piece of main.sort(
    (a, b) => a.baseline - b.baseline || a.box[0] - b.box[0],
  )) {
    let line = lines.find(
      (l) =>
        l.column === piece.column &&
        Math.abs(l.baseline - piece.baseline) < median * 0.32,
    );
    if (!line) {
      line = { ...piece, pieces: [] };
      lines.push(line);
    }
    line.pieces.push(piece);
    line.box = union(line.pieces.map((p) => p.box));
    line.size = Math.max(line.size, piece.size);
  }
  for (const piece of scripts) {
    const closest = lines
      .filter((l) => l.column === piece.column)
      .sort(
        (a, b) =>
          Math.abs(a.baseline - piece.baseline) -
          Math.abs(b.baseline - piece.baseline),
      )[0];
    if (closest && Math.abs(closest.baseline - piece.baseline) < median * 1.6) {
      closest.pieces.push(piece);
      closest.box = union(closest.pieces.map((p) => p.box));
    } else lines.push({ ...piece, pieces: [piece] });
  }
  const mathLine = (line) => {
    if (regionKind(line.text) === "equation") return true;
    const prose = (line.text.match(/\b[A-Za-z]{3,}\b/g) || []).filter(
      (w) =>
        ![
          "min",
          "max",
          "argmin",
          "argmax",
          "sin",
          "cos",
          "log",
          "exp",
          "diag",
          "lim",
        ].includes(w.toLowerCase()),
    );
    return (
      !prose.length &&
      /[\p{L}\p{N}]/u.test(line.text) &&
      /^[\p{L}\p{N}\s.,;:(){}\[\]|+−\-*/^_˜~∥<>≤≥∈∀=]+$/u.test(line.text)
    );
  };
  for (const line of lines) {
    line.text = line.pieces
      .sort((a, b) => a.box[0] - b.box[0] || a.baseline - b.baseline)
      .map((p) => p.text)
      .join(" ");
    line.kind = mathLine(line) ? "equation" : regionKind(line.text);
    line.heading =
      line.kind === "paragraph" &&
      line.size > median * 1.25 &&
      line.text.length < 180;
    if (line.heading) line.kind = "heading";
  }
  // Reconstruct complete visual rows before joining adjacent mathematical rows.
  // Gaps between symbols and right-aligned equation labels do not split a row.
  const blocks = [];
  for (const line of lines.sort(
    (a, b) => a.baseline - b.baseline || a.box[0] - b.box[0],
  )) {
    const prev = blocks.findLast((b) => b.column === line.column);
    const gap = prev ? line.box[1] - prev.box[3] : Infinity;
    if (
      prev &&
      prev.kind === "equation" &&
      line.kind === "equation" &&
      gap < median * 1.9 &&
      gap >= -median * 0.6
    ) {
      if (!prev.children)
        prev.children = [
          { text: prev.text, kind: "equation", box: [...prev.box] },
        ];
      prev.children.push({ text: line.text, kind: "equation", box: line.box });
      prev.text += "\n" + line.text;
      prev.box = union([prev.box, line.box]);
    } else if (
      prev &&
      prev.kind === "paragraph" &&
      line.kind === "paragraph" &&
      !prev.heading &&
      !line.heading &&
      gap < median * 0.85 &&
      gap >= -median * 0.5 &&
      Math.abs(prev.box[0] - line.box[0]) < 0.035
    ) {
      prev.text += "\n" + line.text;
      prev.box = union([prev.box, line.box]);
    } else blocks.push({ ...line });
  }
  const separators = blocks
    .filter((b) => b.column === "full")
    .sort((a, b) => a.box[1] - b.box[1]);
  const band = (b) =>
    b.column === "full"
      ? separators.indexOf(b) * 2 + 1
      : separators.filter((s) => s.box[1] < b.box[1]).length * 2;
  return blocks.sort(
    (a, b) =>
      band(a) - band(b) ||
      (typeof a.column === "number" && typeof b.column === "number"
        ? a.column - b.column
        : 0) ||
      a.box[1] - b.box[1] ||
      a.box[0] - b.box[0],
  );
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
    blocks.forEach((block, i) => {
      if (!block.children?.length) return;
      const parent = children[i];
      parent.role = "equation-block";
      parent.lineCount = block.children.length;
      for (const [j, row] of block.children.entries())
        regions.push({
          ...parent,
          id: `${parent.id}:line${j + 1}`,
          parentId: parent.id,
          box: row.box,
          text: row.text,
          role: "equation-line",
          lineCount: 1,
          order: parent.order + (j + 1) / 1000,
        });
    });
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
