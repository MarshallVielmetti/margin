// Attribution comes from application-owned acceptance records and exact current
// text matches. A note's residence, comments, or self-declared author are not proof.
export function notePassageProvenance(store, vaultRoot, note, text) {
  const base = {
    origin: "vault-note",
    status: "unverified",
    authorship: "not-inferred",
  };
  if (!store || !text) return base;
  const offset = note.content.indexOf(text);
  if (offset < 0 || note.content.indexOf(text, offset + 1) !== -1) return base;
  const documentIds = new Set(
    store
      .list("literatureDocument")
      .filter((d) => d.vaultId === vaultRoot && d.notePath === note.path)
      .map((d) => d.id),
  );
  const known = [];
  for (const suggestion of store.list("synthesisSuggestion")) {
    if (
      !documentIds.has(suggestion.documentId) ||
      suggestion.status !== "accepted"
    )
      continue;
    const rendered = suggestion.acceptedRenderedText || suggestion.acceptedText;
    if (!rendered) continue;
    const start = note.content.indexOf(rendered);
    if (start < 0 || note.content.indexOf(rendered, start + 1) !== -1) continue;
    const first = Math.max(offset, start),
      last = Math.min(offset + text.length, start + rendered.length);
    if (last > first)
      known.push({
        start: first - offset,
        end: last - offset,
        origin: "ai-assisted",
        acceptedBy: "user",
        suggestionId: suggestion.id,
        verification: "unverified",
      });
  }
  if (!known.length) return base;
  const spans = [],
    boundaries = [
      ...new Set([0, text.length, ...known.flatMap((s) => [s.start, s.end])]),
    ].sort((a, b) => a - b);
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1],
      end = boundaries[i],
      match = known.find((s) => s.start <= start && s.end >= end);
    spans.push({
      ...(match || { origin: "unknown", authorship: "not-inferred" }),
      start,
      end,
    });
  }
  return {
    ...base,
    authorship: spans.every(
      (s) => s.origin === "ai-assisted" || !text.slice(s.start, s.end).trim(),
    )
      ? "ai-assisted"
      : "mixed-or-unknown",
    spans,
  };
}
