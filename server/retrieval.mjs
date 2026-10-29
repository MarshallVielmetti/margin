import { createHash } from "node:crypto";
import { searchNotes, resolveLinks } from "./vault.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
export function chunksFor(notes) {
  return notes.flatMap((note) => {
    const sections = note.sections.length
      ? note.sections
      : [{ title: note.title, text: note.body, line: 1 }];
    return sections.flatMap((section) => {
      const chunks = [],
        text = section.text.trim();
      // Overlap keeps nearby qualifiers available; the full section remains inspectable in the vault.
      for (let offset = 0; offset < text.length; offset += 1100) {
        const excerpt = text.slice(offset, offset + 1400);
        if (excerpt.length < 30) continue;
        chunks.push({
          path: note.path,
          title: note.title,
          type: note.type,
          section: section.title,
          line: section.line + 1 + text.slice(0, offset).split("\n").length - 1,
          excerpt,
        });
      }
      return chunks;
    });
  });
}
export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b) || 1);
}
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
          batch.map((c) => `${c.title}\n${c.section}\n${c.excerpt}`),
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
    const lexical = searchNotes(notes, query, {
      limit: 10,
      exclude: current?.path,
    });
    const linked = current
      ? current.links
          .flatMap((l) => resolveLinks(notes, l.target, current.path))
          .slice(0, 6)
          .map((n) => ({
            path: n.path,
            title: n.title,
            excerpt: n.summary || n.body.slice(0, 1400),
            line: 1,
            section: "Linked concept",
            reason: "Explicit wiki-link",
          }))
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
          .slice(0, 12);
      } catch (e) {
        warning = `${e.message} Using text matches and explicit links.`;
      }
    }
    const candidates = [
      current && {
        path: current.path,
        title: current.title,
        section: "Summary / reading notes",
        line: 1,
        excerpt: (current.summary || current.body).slice(0, 1400),
        reason: "Current literature note",
      },
      ...semantic.slice(0, 3),
      ...lexical,
      ...linked,
      ...semantic.slice(3),
    ].filter(Boolean);
    const seen = new Set();
    return {
      notes: candidates
        .filter((n) => {
          if (seen.has(n.path)) return false;
          seen.add(n.path);
          return true;
        })
        .slice(0, limit)
        .map(({ vector, key, ...n }) => n),
      warning,
    };
  }
}
