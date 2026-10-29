import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "margin-browser-qa-"));
const vault = join(root, "vault");
mkdirSync(vault);
writeFileSync(
  join(vault, "Contraction Mappings.md"),
  "---\ntags: [definition]\naliases: [Strict contraction]\n---\n# Contraction Mappings\n## Statement\nA contraction satisfies $d(Tx,Ty) \\leq qd(x,y)$ with $0 \\leq q < 1$.\n## Intuition\nAn existing explanation to preserve.\n## Proof\nThis section must remain intact.\n",
);
writeFileSync(
  join(vault, "Fixed Point Research.md"),
  "Status: #MOC\n# Fixed Point Research\n## Questions\nHow does completeness enter a fixed-point argument?\n[[Contraction Mappings]]\n",
);
writeFileSync(
  join(vault, "Paper.md"),
  "---\ntitle: Fixed points and completeness\nauthors: QA fixture\ntags: [literature_note]\n---\n## Summary\nAn initial summary.\n## Notes\nA [[Contraction Mappings|contraction]] shrinks distances.\n> [!assumption]\n> The metric space is complete.\n## Proof\nOriginal proof, preserved in the vault.\n",
);
// A small, local, two-page PDF fixture with extractable text for browser QA.
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
  null,
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
  null,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
const stream1 =
  "BT /F1 18 Tf 55 720 Td (A complete metric space) Tj 0 -35 Td /F1 12 Tf (Browser QA source. A contraction has a unique fixed point.) Tj ET";
const stream2 =
  "BT /F1 18 Tf 55 720 Td (Why the limit is fixed) Tj 0 -35 Td /F1 12 Tf (Use continuity to pass the map through the limit.) Tj ET";
objects[3] = `<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`;
objects[5] = `<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`;
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((o, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf +=
  `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
  offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("") +
  `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
writeFileSync(join(root, "fixture.pdf"), pdf);
console.log(`QA vault: ${vault}\nQA PDF: ${join(root, "fixture.pdf")}`);
process.env.RESEARCH_VAULT = vault;
process.env.RESEARCH_DATA_DIR = join(root, "data");
process.env.PORT = "4318";
process.env.OPENAI_API_KEY = "";
process.argv.push("--dev");
await import("../server/index.mjs");
