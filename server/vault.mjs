import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  resolve,
  relative,
  dirname,
  sep,
  extname,
  posix,
} from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const cleanLink = (value) =>
  String(value || "")
    .replace(/^!/, "")
    .split("|")[0]
    .split("#")[0]
    .replace(/\.md$/i, "")
    .trim();
const normalize = (value) => value.normalize("NFKC").toLocaleLowerCase();
const stop = new Set(
  "this that with from have which there their when where what your about then into does these those each some such them they will would should could through under notes note source explain result theorem".split(
    " ",
  ),
);
const words = (text) =>
  [...new Set(normalize(text).match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(
    (w) => !stop.has(w),
  );

export function parseNote(path, content) {
  let metadata = {},
    frontmatterEnd = 0;
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    try {
      const parsed = YAML.parse(fm[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        metadata = parsed;
    } catch {
      /* Keep the original note readable even with invalid YAML. */
    }
    frontmatterEnd = fm[0].length;
  }
  const lines = content.split("\n");
  const headings = [],
    links = [],
    callouts = [],
    blockIds = [];
  let fence = null,
    section = "Overview",
    headingStack = [],
    fmLines = content.slice(0, frontmatterEnd).split("\n").length - 1;
  lines.forEach((line, i) => {
    if (i < fmLines) return;
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\r?$/);
    if (h) {
      section = h[2];
      const level = h[1].length;
      while (headingStack.length && headingStack.at(-1).level >= level)
        headingStack.pop();
      const headingPath = [
        ...headingStack.map((entry) => entry.title),
        section,
      ];
      headings.push({ title: section, level, line: i + 1, headingPath });
      headingStack.push({ title: section, level });
    }
    const c = line.match(/^\s*>\s*\[!([^\]]+)\][+-]?\s*(.*)/);
    if (c) callouts.push({ type: c[1], title: c[2], line: i + 1, section });
    for (const m of line.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const originalTarget = m[2];
      const [linkTarget, alias] = originalTarget.split("|");
      const hashAt = linkTarget.indexOf("#");
      const fragment = hashAt < 0 ? "" : linkTarget.slice(hashAt + 1).trim();
      const blockId = /^\^([\p{L}\p{N}_-]+)$/u.exec(fragment)?.[1] || null;
      links.push({
        // `target` remains the path-only legacy field. Keep the exact wikilink
        // input beside it so heading and block anchors are never discarded.
        target: cleanLink(originalTarget),
        originalTarget,
        raw: m[0],
        display: alias || linkTarget,
        fragment,
        blockId,
        section,
        headingPath: [...headingStack.map((entry) => entry.title)],
        line: i + 1,
        embedded: !!m[1],
        relation: "explicit-link",
        evidence: line.trim(),
      });
    }
    if (!fence) {
      for (const match of line.matchAll(/(?:^|\s)\^([\p{L}\p{N}_-]+)\s*$/gu))
        blockIds.push({
          id: match[1],
          line: i + 1,
          section,
          headingPath: [...headingStack.map((entry) => entry.title)],
        });
    }
  });
  const tags = [
    ...(Array.isArray(metadata.tags)
      ? metadata.tags
      : String(metadata.tags || "").split(/[ ,]+/)),
    ...(content.match(/#[\p{L}_][\p{L}\p{N}_/-]*/gu) || []).map((t) =>
      t.slice(1),
    ),
  ].map(String);
  const type =
    tags.some((t) => /literature_note/i.test(t)) ||
    basename(path).startsWith("@")
      ? "literature"
      : tags.some((t) => /^MOC$/i.test(t))
        ? "MOC"
        : tags.some((t) => /definition/i.test(t))
          ? "definition"
          : tags.some((t) => /theorem/i.test(t)) ||
              /theorem/i.test(basename(path))
            ? "theorem"
            : tags.some((t) => /tool|technique/i.test(t))
              ? "tool"
              : "note";
  const title =
    typeof metadata.title === "string"
      ? metadata.title
      : headings.find((h) => h.level === 1)?.title || basename(path, ".md");
  const aliases = Array.isArray(metadata.aliases)
    ? metadata.aliases.map(String)
    : metadata.aliases
      ? [String(metadata.aliases)]
      : [];
  const sections = headings.map((h, i) => {
    const endLine = (headings[i + 1]?.line || lines.length + 1) - 1;
    const text = lines.slice(h.line, endLine).join("\n");
    const sectionBlocks = blockIds.filter(
      (block) => block.line > h.line && block.line <= endLine,
    );
    return {
      ...h,
      endLine,
      startLine: h.line + 1,
      text,
      blockIds: sectionBlocks,
    };
  });
  return {
    id: path,
    path,
    title,
    type,
    aliases,
    tags: [...new Set(tags)],
    metadata,
    content,
    body: content.slice(frontmatterEnd),
    headings,
    sections,
    links,
    blockIds,
    callouts,
    hash: digest(content),
    zotero: content.match(/zotero:\/\/[^\s)]+/)?.[0],
    summary:
      sections.find((s) => /^summary$/i.test(s.title))?.text.trim() ||
      (typeof metadata.summary === "string" ? metadata.summary : ""),
  };
}

export async function scanVault(root, { excludePaths = [] } = {}) {
  const canonical = await realpath(root);
  const excluded = await Promise.all(
    excludePaths.map(async (path) => {
      try {
        return await realpath(path);
      } catch {
        return resolve(await realpath(dirname(resolve(path))), basename(path));
      }
    }),
  );
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Choose a vault directory.");
  const notes = [],
    warnings = [];
  async function walk(dir) {
    if (excluded.includes(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "scripts", "templates"].includes(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        try {
          if ((await stat(full)).size > 2_000_000) {
            warnings.push(`${relative(canonical, full)} exceeds 2 MB`);
            continue;
          }
          notes.push(
            parseNote(relative(canonical, full), await readFile(full, "utf8")),
          );
        } catch (e) {
          warnings.push(`${relative(canonical, full)}: ${e.message}`);
        }
      }
    }
  }
  await walk(canonical);
  return {
    root: canonical,
    notes,
    warnings,
    indexedAt: new Date().toISOString(),
  };
}

const slashPath = (value) => String(value || "").replaceAll("\\", "/");
const withoutMarkdown = (value) => slashPath(value).replace(/\.md$/i, "");

/**
 * Resolve an Obsidian link without pretending that a shared basename or alias
 * identifies one note. Exact source-relative and vault-relative paths win;
 * title, basename, and alias matches remain explicitly ambiguous when shared.
 */
export function resolveLinkMatches(notes, link, fromPath = "") {
  const original =
    typeof link === "object" && link !== null
      ? link.originalTarget || link.target || ""
      : link;
  const rawTarget = String(original || "")
    .trim()
    .split("|")[0];
  const hashAt = rawTarget.indexOf("#");
  const fragment = hashAt < 0 ? "" : rawTarget.slice(hashAt + 1).trim();
  const blockId = /^\^([\p{L}\p{N}_-]+)$/u.exec(fragment)?.[1] || null;
  const target = cleanLink(original);
  const exactMatch = (note, matchType) => ({
    note,
    matchType,
    originalTarget: String(original || ""),
    fragment,
    blockId,
  });
  if (!target) {
    if (!fromPath || !rawTarget.startsWith("#") || !fragment) return [];
    const sourcePath = slashPath(fromPath).replace(/^\.\//, "");
    const exactSource = notes.find(
      (note) => slashPath(note.path) === sourcePath,
    );
    const normalizedSources = notes.filter(
      (note) => normalize(slashPath(note.path)) === normalize(sourcePath),
    );
    const source =
      exactSource ||
      (normalizedSources.length === 1 ? normalizedSources[0] : null);
    return source ? [exactMatch(source, "local-fragment")] : [];
  }
  const targetKey = normalize(withoutMarkdown(target));

  if (fromPath) {
    const relativeTarget = posix.normalize(
      posix.join(posix.dirname(slashPath(fromPath)), withoutMarkdown(target)),
    );
    if (relativeTarget !== ".." && !relativeTarget.startsWith("../")) {
      const relativeMatches = notes.filter(
        (note) =>
          normalize(withoutMarkdown(note.path)) === normalize(relativeTarget),
      );
      if (relativeMatches.length)
        return relativeMatches.map((note) =>
          exactMatch(note, "source-relative-path"),
        );
    }
  }

  // A path-bearing link is an identity request. Do not silently fall back to
  // another note with the same basename when that path does not exist.
  if (target.includes("/") || target.startsWith("/")) {
    const pathKey = normalize(withoutMarkdown(target).replace(/^\/+/, ""));
    return notes
      .filter((note) => normalize(withoutMarkdown(note.path)) === pathKey)
      .map((note) => exactMatch(note, "vault-relative-path"));
  }

  const candidates = [];
  for (const note of notes) {
    const path = withoutMarkdown(note.path);
    const base = basename(path);
    let matchType = null;
    if (normalize(path) === targetKey) matchType = "vault-relative-path";
    else if (normalize(note.title) === targetKey) matchType = "title";
    else if (normalize(base) === targetKey) matchType = "basename";
    else if (note.aliases.some((alias) => normalize(alias) === targetKey))
      matchType = "alias";
    if (matchType) candidates.push(exactMatch(note, matchType));
  }
  return candidates;
}

export function resolveLinks(notes, link, fromPath = "") {
  return resolveLinkMatches(notes, link, fromPath).map(({ note }) => note);
}

export function searchNotes(
  notes,
  query = "",
  { type, limit = 50, exclude } = {},
) {
  const terms = words(query);
  return notes
    .filter((n) => (!type || n.type === type) && n.path !== exclude)
    .map((note) => {
      const title = normalize(
        `${note.title} ${note.aliases.join(" ")} ${basename(note.path, ".md")}`,
      );
      const body = normalize(note.content.replace(/```[\s\S]*?```/g, ""));
      const score = terms.reduce(
        (sum, w) =>
          sum + (title.includes(w) ? 10 : 0) + (body.includes(w) ? 1 : 0),
        0,
      );
      const matching = note.sections
        .map((s) => ({
          ...s,
          score: terms.filter((w) =>
            normalize(s.title + " " + s.text).includes(w),
          ).length,
        }))
        .sort((a, b) => b.score - a.score)[0];
      return {
        path: note.path,
        title: note.title,
        type: note.type,
        summary: note.summary,
        aliases: note.aliases,
        year: note.metadata.year,
        score,
        section: matching?.title || "Overview",
        line: matching?.line || 1,
        excerpt: (matching?.text || note.body)
          .replace(/```[\s\S]*?```/g, "")
          .trim()
          .slice(0, 420),
        reason: terms.length
          ? "Matching words in your notes · connection unverified"
          : "Existing vault note",
      };
    })
    .filter((n) => !terms.length || n.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export async function safeNotePath(root, path, { allowNew = false } = {}) {
  if (
    !path ||
    !path.endsWith(".md") ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((p) => p.startsWith("."))
  )
    throw new Error("Choose a Markdown note inside the vault.");
  const canonical = await realpath(root),
    full = resolve(canonical, path);
  if (!full.startsWith(canonical + sep))
    throw new Error("Path is outside the vault.");
  let actual;
  try {
    actual = await realpath(full);
  } catch (error) {
    if (!allowNew || error.code !== "ENOENT") throw error;
    actual = resolve(await realpath(dirname(full)), basename(full));
  }
  if (!actual.startsWith(canonical + sep))
    throw new Error("Linked path is outside the vault.");
  if (actual !== full)
    throw new Error("Symlinked notes are not writable through Margin.");
  return full;
}
