import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPaddle } from "../server/paddle.mjs";
import { pdfFixture } from "../test/fixtures/pdf.mjs";
const dir = await mkdtemp(join(tmpdir(), "margin-paddle-validation-"));
const file = join(dir, "fixture.pdf");
try {
  await writeFile(file, pdfFixture());
  let last = "";
  const start = Date.now();
  const layout = await extractPaddle(
    "paddle-validation",
    file,
    AbortSignal.timeout(300000),
    (message) => {
      if (message !== last) {
        console.log(message);
        last = message;
      }
    },
  );
  console.log(
    JSON.stringify({
      pageCount: layout.pageCount,
      regions: layout.regions.filter((r) => r.kind !== "page").length,
      equations: layout.regions.filter((r) => r.kind === "equation").length,
      durationMs: Date.now() - start,
      warnings: layout.warnings,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
