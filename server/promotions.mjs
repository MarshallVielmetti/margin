import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { digest, parseNote, safeNotePath } from "./vault.mjs";
import { atomicNoteWrite } from "./note-files.mjs";

export function updateSection(content, heading, text, replace = false) {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(nl),
    note = parseNote("note.md", content);
  const found = note.headings.find(
    (h) => h.title.toLowerCase() === heading.toLowerCase(),
  );
  const addition = text.trim().replace(/\r?\n/g, nl);
  if (!found)
    return (
      content.replace(/\s*$/, "") +
      `${nl}${nl}## ${heading}${nl}${addition}${nl}`
    );
  const next =
    note.headings.find((h) => h.line > found.line && h.level <= found.level)
      ?.line || lines.length + 1;
  const existing = lines
    .slice(found.line, next - 1)
    .join(nl)
    .trimEnd();
  return [
    ...lines.slice(0, found.line),
    replace ? addition : `${existing}${existing ? nl + nl : ""}${addition}`,
    "",
    ...lines.slice(next - 1),
  ].join(nl);
}

export function updateSummary(content, text) {
  const note = parseNote("note.md", content);
  if (note.headings.some((h) => /^summary$/i.test(h.title)))
    return updateSection(content, "Summary", text, true);
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm && Object.hasOwn(note.metadata, "summary")) {
    const doc = parseDocument(fm[1]);
    if (doc.errors.length)
      throw new Error(
        "Fix invalid frontmatter in Obsidian before updating its summary.",
      );
    const originalRange = doc.get("summary", true)?.range;
    doc.set("summary", text.trim());
    const serialized = doc.toString();
    const replacementRange = parseDocument(serialized).get(
      "summary",
      true,
    )?.range;
    // Serialize the changed scalar with YAML's quoting rules, but splice only
    // that value into the original frontmatter to retain unrelated formatting.
    const properties =
      originalRange && replacementRange
        ? fm[1].slice(0, originalRange[0]) +
          serialized.slice(replacementRange[0], replacementRange[1]) +
          fm[1].slice(originalRange[1])
        : serialized.trimEnd();
    const nl = content.includes("\r\n") ? "\r\n" : "\n";
    return `---${nl}${properties.replace(/\r?\n/g, nl)}${nl}---${nl}${content.slice(fm[0].length)}`;
  }
  return updateSection(content, "Summary", text, true);
}

export async function preparePromotion(root, request) {
  const full = await safeNotePath(root, request.path, {
    allowNew: request.mode === "new",
  });
  const exists = existsSync(full);
  if (request.mode === "new" && exists)
    throw new Error(
      "This note already exists. Choose it as an existing destination.",
    );
  if (request.mode !== "new" && !exists)
    throw new Error(
      "The destination note no longer exists. Refresh your vault.",
    );
  const before = exists ? readFileSync(full, "utf8") : "";
  let after;
  if (request.mode === "summary") after = updateSummary(before, request.text);
  else if (request.mode === "new")
    after = `---\ntags: [${request.noteType || "idea"}]\n---\n# ${request.title.replace(/[\r\n]/g, " ")}\n\n## Intuition\n${request.text.trim()}\n\n## Connections\n${request.links.map((p) => `[[${p.replace(/\.md$/, "")}]]`).join("\n")}\n`;
  else after = updateSection(before, request.heading, request.text);
  if (request.provenance)
    after = after.trimEnd() + "\n\n" + request.provenance + "\n";
  return {
    ...request,
    before,
    after,
    beforeHash: exists ? digest(before) : null,
    afterHash: digest(after),
    vaultRoot: realpathSync(root),
    status: "draft",
    createdAt: new Date().toISOString(),
  };
}

export async function applyPromotion(root, draft) {
  if (draft.status !== "draft")
    throw new Error("Only an unapplied draft can be approved.");
  if (realpathSync(root) !== draft.vaultRoot)
    throw new Error("This draft belongs to a different vault.");
  const full = await safeNotePath(root, draft.path, {
    allowNew: draft.mode === "new",
  });
  const current = existsSync(full) ? readFileSync(full, "utf8") : null;
  if ((current === null ? null : digest(current)) !== draft.beforeHash)
    throw new Error(
      "The note changed since this preview. Create a fresh proposal to preserve your edits.",
    );
  atomicNoteWrite(full, draft.after, draft.beforeHash);
  return { ...draft, status: "applied", appliedAt: new Date().toISOString() };
}

export async function undoPromotion(root, draft) {
  if (draft.status !== "applied")
    throw new Error("Only an applied promotion can be undone.");
  if (realpathSync(root) !== draft.vaultRoot)
    throw new Error("This promotion belongs to a different vault.");
  const full = await safeNotePath(root, draft.path);
  if (digest(readFileSync(full, "utf8")) !== draft.afterHash)
    throw new Error(
      "The note has newer edits. Restore the saved original manually from this promotion.",
    );
  if (draft.beforeHash === null) unlinkSync(full);
  else {
    const temp = join(dirname(full), `.margin-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, draft.before, { flag: "wx" });
      if (digest(readFileSync(full, "utf8")) !== draft.afterHash)
        throw new Error("The note changed while restoring.");
      renameSync(temp, full);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  return { ...draft, status: "undone", undoneAt: new Date().toISOString() };
}
