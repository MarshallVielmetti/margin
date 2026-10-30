import { diffArrays } from "diff";

function edits(base, next) {
  let position = 0;
  const result = [];
  for (const part of diffArrays(base, next)) {
    if (!part.added && !part.removed) {
      position += part.value.length;
      continue;
    }
    const previous = result.at(-1);
    if (part.removed) {
      result.push({
        start: position,
        end: position + part.value.length,
        lines: [],
      });
      position += part.value.length;
    } else if (previous && previous.end === position)
      previous.lines.push(...part.value);
    else result.push({ start: position, end: position, lines: part.value });
  }
  return result;
}
function overlaps(a, b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}
function applyRange(lines, changes, start, end) {
  let cursor = start,
    output = [];
  for (const change of changes.sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    output.push(...lines.slice(cursor, change.start), ...change.lines);
    cursor = change.end;
  }
  output.push(...lines.slice(cursor, end));
  return output.join("");
}

// Line-scoped diff3. Non-overlapping edits survive on both sides. Conflicts keep
// local wording in the working text and carry exact ranges for inline resolution.
export function mergeMarkdown(base, local, remote) {
  if (local === remote) return { text: local, conflicts: [] };
  if (local === base) return { text: remote, conflicts: [] };
  if (remote === base) return { text: local, conflicts: [] };
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) || [];
  const split = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const left = edits(lines, split(local)),
    right = edits(lines, split(remote));
  const all = [
    ...left.map((e) => ({ ...e, side: "local" })),
    ...right.map((e) => ({ ...e, side: "remote" })),
  ];
  const groups = [];
  for (const edit of all.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const touching = groups.filter((group) =>
      group.some((other) => overlaps(edit, other)),
    );
    if (!touching.length) groups.push([edit]);
    else {
      const group = [edit, ...touching.flat()];
      for (const old of touching) groups.splice(groups.indexOf(old), 1);
      groups.push(group);
    }
  }
  let cursor = 0,
    text = "";
  const conflicts = [];
  for (const group of groups.sort(
    (a, b) =>
      Math.min(...a.map((e) => e.start)) - Math.min(...b.map((e) => e.start)) ||
      Math.max(...a.map((e) => e.end)) - Math.max(...b.map((e) => e.end)),
  )) {
    const start = Math.min(...group.map((e) => e.start)),
      end = Math.max(...group.map((e) => e.end));
    text += lines.slice(cursor, start).join("");
    const l = group.filter((e) => e.side === "local"),
      r = group.filter((e) => e.side === "remote");
    const localText = applyRange(lines, l, start, end),
      remoteText = applyRange(lines, r, start, end);
    const value = l.length ? localText : remoteText;
    if (l.length && r.length && localText !== remoteText)
      conflicts.push({
        start: text.length,
        end: text.length + value.length,
        base: lines.slice(start, end).join(""),
        local: localText,
        remote: remoteText,
      });
    text += value;
    cursor = end;
  }
  text += lines.slice(cursor).join("");
  return { text, conflicts };
}
