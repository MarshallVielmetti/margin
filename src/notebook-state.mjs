export const notebookModes = ["thoughts", "tutor", "synthesis"];
export function nextNotebookMode(mode, backwards = false) {
  return notebookModes[(notebookModes.indexOf(mode) + (backwards ? 2 : 1)) % 3];
}
export function freezeDraft(draft, text, anchor) {
  return {
    ...draft,
    text,
    anchor: draft.anchor || (text ? structuredClone(anchor) : null),
  };
}
export function synthesisTabAction(text, start, end, backwards = false) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
    if (backwards) {
      const removed = line.match(/^(?: {1,2}|\t)/)?.[0].length || 0;
      return {
        text: text.slice(0, lineStart) + text.slice(lineStart + removed),
        start: Math.max(lineStart, start - removed),
        end: Math.max(lineStart, end - removed),
      };
    }
    return {
      text: text.slice(0, lineStart) + "  " + text.slice(lineStart),
      start: start + 2,
      end: end + 2,
    };
  }
  if (line.trim().startsWith("|")) {
    const pipes = [...text.matchAll(/\|/g)]
      .map((m) => m.index)
      .filter(
        (p) => p >= lineStart && p <= (lineEnd < 0 ? text.length : lineEnd),
      );
    const next = backwards
      ? pipes.filter((p) => p < start - 1).at(-1)
      : pipes.find((p) => p >= end);
    if (next !== undefined) return { text, start: next + 1, end: next + 1 };
  }
  return null;
}
export function tutorThreads(artifacts) {
  const threads = [];
  for (const artifact of artifacts) {
    if (
      artifact.origin === "user" &&
      artifact.kind === "question" &&
      artifact.surface !== "thoughts"
    )
      threads.push({
        id: artifact.runId || artifact.id,
        question: artifact,
        answers: [],
      });
    else if (["ai", "tool"].includes(artifact.origin)) {
      let thread = artifact.runId
        ? threads.find((t) => t.id === artifact.runId)
        : threads.at(-1);
      if (!thread) {
        thread = {
          id: artifact.runId || artifact.id,
          question: null,
          answers: [],
        };
        threads.push(thread);
      }
      thread.answers.push(artifact);
    }
  }
  return threads;
}
