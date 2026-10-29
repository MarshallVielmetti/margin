import { createHash } from "node:crypto";
import { searchNotes, resolveLinks } from "./vault.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const normalize = (text) =>
  String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
const stop = new Set(
  "this that with from have which there their when where what your about then into does these those each some such them they will would should could through under notes note source explain result theorem".split(
    " ",
  ),
);
const termsFor = (text) =>
  [...new Set(normalize(text).match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(
    (word) => !stop.has(word),
  );

/** Split a section into bounded, contiguous, non-overlapping passages. */
function splitPassages(text, maxChars) {
  const result = [];
  let start = 0;
  while (start < text.length) {
    while (/\s/.test(text[start] || "")) start++;
    if (start >= text.length) break;
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const floor = start + Math.floor(maxChars * 0.55);
      const window = text.slice(floor, end);
      const breaks = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" "),
      ];
      const boundary = Math.max(...breaks);
      if (boundary > 0)
        end = floor + boundary + (window[boundary] === "." ? 1 : 0);
    }
    if (end <= start) end = Math.min(text.length, start + maxChars);
    const excerpt = text.slice(start, end).trim();
    if (excerpt.length > 0)
      result.push({ excerpt, offset: start, endOffset: end });
    start = end;
  }
  return result;
}

export function passagesFor(note, { maxChars = 1400, minChars = 1 } = {}) {
  const sections = note.sections?.length
    ? note.sections
    : [
        {
          title: note.title,
          headingPath: [note.title],
          text: note.body || note.content || "",
          line: 0,
          endLine: (note.body || note.content || "").split("\n").length,
          blockIds: note.blockIds || [],
        },
      ];
  const passages = [];
  for (const section of sections) {
    const text = String(section.text || "");
    for (const part of splitPassages(text, maxChars)) {
      if (part.excerpt.length < minChars) continue;
      const line = Math.max(
        1,
        (section.line || section.startLine || 0) +
          1 +
          text.slice(0, part.offset).split("\n").length -
          1,
      );
      const endLine = line + part.excerpt.split("\n").length - 1;
      const blockId =
        (section.blockIds || note.blockIds || []).find(
          (block) => block.line >= line && block.line <= endLine,
        )?.id ||
        (part.excerpt.match(/(?:^|\s)\^([\p{L}\p{N}_-]+)\s*$/u)?.[1] ?? null);
      passages.push({
        path: note.path,
        title: note.title,
        type: note.type,
        aliases: note.aliases || [],
        section: section.title || note.title,
        headingPath: section.headingPath || [section.title || note.title],
        line,
        endLine,
        blockId,
        excerpt: part.excerpt,
      });
    }
  }
  return passages;
}

/** Discovery results are passage-level and may include several passages per note. */
export function searchPassages(
  notes,
  query = "",
  { limit = 20, exclude, onlyPaths, maxPerNote = 4 } = {},
) {
  const terms = termsFor(query);
  const allowedPaths = onlyPaths ? new Set(onlyPaths) : null;
  const queryKey = normalize(String(query).trim());
  const matches = [];
  for (const note of notes) {
    if (note.path === exclude || (allowedPaths && !allowedPaths.has(note.path)))
      continue;
    const identity = normalize(
      `${note.title} ${note.aliases.join(" ")} ${note.path.split("/").at(-1)?.replace(/\.md$/i, "")}`,
    );
    const exactIdentity =
      queryKey &&
      [
        note.title,
        ...(note.aliases || []),
        note.path.split("/").at(-1)?.replace(/\.md$/i, ""),
      ].some((value) => normalize(value) === queryKey);
    const passages = passagesFor(note);
    const ranked = passages
      .map((passage) => {
        const location = normalize(
          `${passage.headingPath.join(" ")} ${passage.excerpt}`,
        );
        const score = terms.reduce(
          (sum, word) =>
            sum +
            (identity.includes(word) ? 10 : 0) +
            (normalize(passage.headingPath.join(" ")).includes(word) ? 4 : 0) +
            (location.includes(word) ? 1 : 0),
          0,
        );
        return {
          ...passage,
          score: exactIdentity ? score + 100 : score,
          reason: terms.length
            ? "Matching passage candidate · not inspected evidence"
            : "Vault passage candidate · not inspected evidence",
          kind: "candidate",
          inspected: false,
        };
      })
      .filter((passage) => exactIdentity || !terms.length || passage.score > 0)
      .sort((a, b) => b.score - a.score || a.line - b.line);
    matches.push(...ranked.slice(0, maxPerNote));
  }
  return matches
    .sort(
      (a, b) =>
        b.score - a.score || a.title.localeCompare(b.title) || a.line - b.line,
    )
    .slice(0, Math.max(0, limit));
}

// Kept for callers that still use note-level semantic chunks. Each chunk now
// has a complete heading path and an exact line span for navigation.
export function chunksFor(notes) {
  return notes.flatMap((note) => passagesFor(note));
}

export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b) || 1);
}

const passageKey = (passage) =>
  `${passage.path}\u0000${passage.line}\u0000${passage.endLine}\u0000${hash(passage.excerpt)}`;

export class Retrieval {
  constructor(store, ollama) {
    Object.assign(this, { store, ollama });
    this.status = {
      running: false,
      done: 0,
      total: 0,
      error: "",
      model: "",
      indexedAt: null,
    };
  }
  statusFor(notes, model) {
    const cache = this.store.setting("semanticIndex");
    return {
      ...this.status,
      model,
      indexedAt: cache?.model === model ? cache.indexedAt : null,
      cached: cache?.model === model ? cache.chunks.length : 0,
      stale:
        !!cache &&
        (cache.model !== model || cache.signature !== this.signature(notes)),
    };
  }
  signature(notes) {
    return hash(
      notes
        .map((n) => `${n.path}:${n.hash}`)
        .sort()
        .join("\n"),
    );
  }
  async build(notes, model) {
    if (this.status.running)
      throw new Error("Semantic indexing is already running.");
    if (!model)
      throw new Error("Choose an installed embedding model in Settings.");
    const chunks = chunksFor(notes),
      previous = this.store.setting("semanticIndex");
    const cached = new Map(
      previous?.model === model
        ? previous.chunks.map((c) => [c.key, c.vector])
        : [],
    );
    this.status = {
      running: true,
      done: 0,
      total: chunks.length,
      error: "",
      model,
      indexedAt: previous?.indexedAt,
    };
    try {
      for (const chunk of chunks) {
        chunk.key = hash(JSON.stringify(chunk));
        chunk.vector = cached.get(chunk.key);
      }
      const missing = chunks.filter((c) => !c.vector);
      this.status.done = chunks.length - missing.length;
      for (let i = 0; i < missing.length; i += 24) {
        const batch = missing.slice(i, i + 24);
        const vectors = await this.ollama.embed(
          model,
          batch.map(
            (c) => `${c.title}\n${c.headingPath.join(" / ")}\n${c.excerpt}`,
          ),
        );
        batch.forEach((c, j) => {
          c.vector = vectors[j];
        });
        this.status.done += batch.length;
      }
      this.store.setting("semanticIndex", {
        model,
        signature: this.signature(notes),
        indexedAt: new Date().toISOString(),
        chunks,
      });
    } catch (e) {
      this.status.error = e.message;
    } finally {
      this.status.running = false;
    }
  }
  async retrieve(notes, query, source, model, limit = 5) {
    const current = notes.find((n) => n.path === source.notePath);
    const lexical = searchPassages(notes, query, {
      limit: Math.max(12, limit * 4),
      exclude: current?.path,
      maxPerNote: 4,
    });
    const linked = current
      ? current.links
          .flatMap((link) => resolveLinks(notes, link, current.path))
          .flatMap((note) => {
            const found = searchPassages(notes, query, {
              onlyPaths: [note.path],
              limit: 3,
              maxPerNote: 3,
            });
            const passages = found.length
              ? found
              : passagesFor(note).slice(0, 2);
            return passages.map((passage) => ({
              ...passage,
              reason:
                "Passage in an explicitly linked note; relationship unverified",
              relation: "explicit-link",
            }));
          })
          .slice(0, 12)
      : [];
    let semantic = [],
      warning = "";
    const cache = this.store.setting("semanticIndex");
    if (cache?.model === model && model) {
      try {
        const [vector] = await this.ollama.embed(model, [query.slice(0, 1600)]);
        // Never send stale or deleted note passages to the tutor.
        const liveChunks = new Set(
          chunksFor(notes).map((c) => hash(JSON.stringify(c))),
        );
        semantic = cache.chunks
          .filter((c) => liveChunks.has(c.key) && c.path !== current?.path)
          .map((c) => ({
            ...c,
            score: cosine(vector, c.vector),
            reason: "Local semantic match; relationship unverified",
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(12, limit * 3));
      } catch (e) {
        warning = `${e.message} Using text matches and explicit links.`;
      }
    }
    const currentPassages = current
      ? passagesFor(current, { maxChars: 1400 })
          .sort(
            (a, b) =>
              (b.section === "Summary" ? 1 : 0) -
              (a.section === "Summary" ? 1 : 0),
          )
          .slice(0, 2)
          .map((passage) => ({
            ...passage,
            reason: "Current literature note",
          }))
      : [];
    const candidates = [
      ...currentPassages,
      ...semantic.slice(0, 3),
      ...lexical,
      ...linked,
      ...semantic.slice(3),
    ];
    const seen = new Set();
    return {
      notes: candidates
        .filter((passage) => {
          const key = passageKey(passage);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit)
        .map(({ vector, key, ...passage }) => ({
          ...passage,
          section: passage.headingPath?.at(-1) || passage.section,
          headingPath: passage.headingPath || [passage.section],
        })),
      warning,
    };
  }
}
