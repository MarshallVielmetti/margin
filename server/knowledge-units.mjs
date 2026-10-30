import { z } from "zod";
import { digest } from "./vault.mjs";

export const unitAnalysisSchema = z
  .object({
    description: z.string().max(500),
    account: z.string().max(4000),
    assumptions: z.array(z.string().max(600)).max(12),
    notation: z.array(z.string().max(400)).max(16),
    limitations: z.array(z.string().max(600)).max(10),
    questions: z.array(z.string().max(600)).max(10),
  })
  .strict();
export const overviewSchema = z
  .object({
    description: z.string().max(500),
    problem: z.string().max(2000),
    approach: z.string().max(2000),
    contributions: z.array(z.string().max(1000)).max(12),
    limitations: z.array(z.string().max(800)).max(12),
  })
  .strict();
export const relationSchema = z
  .object({
    relation: z
      .enum([
        "uses",
        "specializes",
        "generalizes",
        "analogous-to",
        "incompatible-assumptions",
        "possible-application",
        "apparent-tension",
        "no-supported-relation",
      ])
      .describe(
        "Choose no-supported-relation when the inspected passages do not justify a relationship; do not force a match.",
      ),
    leftQuote: z.string().min(8).max(1800),
    rightQuote: z.string().min(8).max(1800),
    reasoning: z.string().max(2400),
    qualifications: z.array(z.string().max(800)).max(8),
    checks: z.array(z.string().max(800)).max(8),
  })
  .strict();

const meaningful = new Set([
  "definition",
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "assumption",
  "proof",
  "method",
  "example",
  "remark",
]);
export function meaningfulUnits(
  layout,
  { pages = [], maxUnits = 8, maxChars = 6000 } = {},
) {
  // Grouped regions already contain their child paragraphs and equation rows.
  // Reusing them avoids both duplicate cards and isolated equation-fragment skills.
  const ids = new Set(
    layout.regions.filter((r) => r.kind !== "page").map((r) => r.id),
  );
  const regions = layout.regions
    .filter((r) => r.kind !== "page" && !ids.has(r.parentId) && r.text.trim())
    .sort((a, b) => a.page - b.page || a.order - b.order);
  const groups = [];
  let current = null,
    section = "Extracted argument";
  const flush = () => {
    if (current?.regions.length) groups.push(current);
    current = null;
  };
  for (const r of regions) {
    if (pages.length && !pages.includes(r.page)) {
      flush();
      continue;
    }
    if (r.kind === "heading") {
      flush();
      section = r.text.slice(0, 250);
    }
    const size =
      (current?.regions.reduce((n, v) => n + v.text.length + 2, 0) || 0) +
      r.text.length;
    if (
      meaningful.has(r.kind) ||
      size > maxChars ||
      (current && r.page > current.regions.at(-1).page + 1)
    )
      flush();
    if (!current)
      current = {
        kind: meaningful.has(r.kind) ? r.kind : "section-argument",
        title: meaningful.has(r.kind)
          ? r.text.split("\n")[0].slice(0, 180)
          : section,
        regions: [],
      };
    current.regions.push(r);
  }
  flush();
  return {
    total: groups.length,
    units: groups.slice(0, maxUnits).map((g) => {
      const raw = g.regions.map((r) => r.text).join("\n\n");
      let remaining = maxChars;
      const anchors = g.regions.flatMap((r) => {
        if (remaining <= 0) return [];
        const text = r.text.slice(0, remaining);
        remaining -= text.length + 2;
        return [
          {
            origin: "source",
            sourceId: layout.sourceId,
            revision: layout.revision,
            contentHash: layout.contentHash,
            regionId: r.id,
            page: r.page,
            box: r.box,
            text,
            quoteHash: digest(text),
          },
        ];
      });
      return {
        id: `unit_${digest(g.regions.map((r) => r.id).join("|")).slice(0, 24)}`,
        kind: g.kind,
        title: g.title,
        heuristic: true,
        text: raw.slice(0, maxChars),
        anchors,
        contextRegionIds: [
          ...new Set(g.regions.map((r) => r.parentId).filter(Boolean)),
        ],
        issues:
          raw.length > maxChars
            ? [
                "Unit text was truncated to its context budget; inspect the enclosing source.",
              ]
            : [],
      };
    }),
  };
}

export function unitMarkdown(unit, analysis) {
  const list = (title, items) =>
    items.length
      ? `\n\n## ${title}\n\n${items.map((v) => `- ${v}`).join("\n")}`
      : "";
  return (
    `# ${unit.title}\n\n${analysis?.account || "No model account has been generated. Use the evidence anchors to inspect this extracted unit."}` +
    list("Assumptions (AI interpretation)", analysis?.assumptions || []) +
    list("Notation (AI interpretation)", analysis?.notation || []) +
    list("Limitations and extraction gaps", [
      ...unit.issues,
      ...(analysis?.limitations || []),
    ]) +
    list("Open questions", analysis?.questions || [])
  );
}
