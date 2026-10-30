import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";
import {
  digest,
  parseNote,
  resolveLinkMatches,
  safeNotePath,
} from "../../vault.mjs";
import { searchPassages } from "../../retrieval.mjs";
import { notePassageProvenance } from "../../note-origin.mjs";

const candidateStoreLimit = 512;
const maxNoteBytes = 2_000_000;
const zodTool = (name, description, schema, execute) => ({
  name,
  description,
  schema,
  execute: (args, context) => execute(schema.parse(args), context),
});

function abortIfNeeded(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The research run was cancelled.");
}

function scopeFor({ runId, toolCallId } = {}) {
  return String(runId || (toolCallId ? `tool:${toolCallId}` : "unscoped"));
}

function headingLabel(path) {
  return path?.length ? path.join(" / ") : "Overview";
}

function withinLineRange(
  note,
  startLine,
  endLine,
  maxChars = 6_000,
  maxLines = 80,
) {
  const lines = note.content.split("\n");
  const first = Math.max(1, Math.min(lines.length, startLine || 1));
  const last = Math.max(first, Math.min(lines.length, endLine || lines.length));
  const boundedLast = Math.min(last, first + maxLines - 1);
  const selected = lines.slice(first - 1, boundedLast);
  let text = selected.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd();
  return {
    text,
    lineStart: first,
    lineEnd: first + text.split("\n").length - 1,
  };
}

async function readCurrentNote(vault, indexedNote) {
  if (!vault?.root || !indexedNote?.path)
    throw new Error("Connect a vault and select a current indexed note.");
  const full = await safeNotePath(vault.root, indexedNote.path);
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content;
  try {
    const info = await handle.stat();
    if (info.size > maxNoteBytes)
      throw new Error("This note exceeds the bounded 2 MB read limit.");
    const bytes = Buffer.alloc(maxNoteBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxNoteBytes)
      throw new Error("This note exceeds the bounded 2 MB read limit.");
    content = bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  if ((await realpath(full)) !== full)
    throw new Error("The note path changed while it was being read.");
  const note = parseNote(indexedNote.path, content);
  if (note.hash !== indexedNote.hash)
    throw new Error(
      "This note changed after the current vault index was built. Refresh the vault and search again.",
    );
  return note;
}

function evidenceInput(note, passage, runId) {
  const section = passage.headingPath?.at(-1) || passage.section || "Overview";
  return {
    kind: "vault-note-passage",
    title: note.title,
    path: note.path,
    entity: {
      type: "vault-note",
      id: note.path,
      path: note.path,
      title: note.title,
      aliases: note.aliases,
    },
    source: { type: "vault-note", path: note.path, title: note.title },
    revision: note.hash,
    hash: note.hash,
    text: passage.text,
    locator: {
      path: note.path,
      headingPath: passage.headingPath || [],
      section,
      line: passage.lineStart,
      lineStart: passage.lineStart,
      lineEnd: passage.lineEnd,
      blockId: passage.blockId || null,
      quoteHash: digest(passage.text),
    },
    provenance: {
      origin: "vault-note",
      status: "unverified",
      authorship: "not-inferred",
    },
    freshness: "current",
    line: passage.lineStart,
    runId,
  };
}

export function createVaultTools({ store, getVault, registerEvidence }) {
  if (typeof getVault !== "function")
    throw new TypeError("createVaultTools requires getVault().");
  if (typeof registerEvidence !== "function")
    throw new TypeError("createVaultTools requires registerEvidence().");

  // Candidates are opaque and kept only for this tool instance. The run ID is
  // checked again on read, so an ID from another run cannot be replayed.
  const candidatesByScope = new Map();
  const saveCandidates = (scope, candidates) => {
    let runCandidates = candidatesByScope.get(scope);
    if (!runCandidates) {
      runCandidates = new Map();
      candidatesByScope.set(scope, runCandidates);
    }
    for (const candidate of candidates)
      runCandidates.set(candidate.candidateId, candidate);
    while (runCandidates.size > candidateStoreLimit)
      runCandidates.delete(runCandidates.keys().next().value);
    while (candidatesByScope.size > 64)
      candidatesByScope.delete(candidatesByScope.keys().next().value);
  };

  const search = zodTool(
    "vault.search",
    "Find note and passage candidates in the currently configured vault. Results are discovery previews, not inspected evidence; use vault.read before citing or relying on passage text.",
    z
      .object({
        query: z.string().trim().min(1).max(1200),
        limit: z.number().int().min(1).max(20).default(12),
      })
      .strict(),
    async ({ query, limit }, context = {}) => {
      abortIfNeeded(context.signal);
      const vault = await getVault();
      const notes = Array.isArray(vault?.notes) ? vault.notes : [];
      const found = searchPassages(notes, query, {
        limit,
        maxPerNote: 5,
      });
      const scope = scopeFor(context);
      const candidates = found.map((passage) => ({
        candidateId: `vc_${randomUUID()}`,
        notePath: passage.path,
        noteHash: notes.find((note) => note.path === passage.path)?.hash,
        title: passage.title,
        type: passage.type,
        aliases: passage.aliases,
        section: passage.section,
        headingPath: passage.headingPath,
        line: passage.line,
        endLine: passage.endLine,
        blockId: passage.blockId,
        preview: passage.excerpt.slice(0, 320),
        score: passage.score,
        reason: passage.reason,
        status: "candidate",
        inspected: false,
      }));
      saveCandidates(scope, candidates);
      abortIfNeeded(context.signal);
      return {
        candidates,
        resultKind: "discovery-only",
        inspectedEvidence: false,
      };
    },
  );

  const read = zodTool(
    "vault.read",
    "Read a bounded passage from a current indexed vault note. A search candidate ID is run-scoped; direct reads must name a path in the current vault index. Reads create an evidence snapshot with a version and exact locator.",
    z
      .object({
        candidateId: z.string().trim().min(1).max(100).optional(),
        path: z.string().trim().min(1).max(1000).optional(),
        headingPath: z
          .array(z.string().trim().min(1).max(200))
          .max(6)
          .optional(),
        line: z.number().int().min(1).max(2_000_000).optional(),
        blockId: z.string().trim().min(1).max(200).optional(),
        maxChars: z.number().int().min(1).max(12_000).default(6_000),
        maxLines: z.number().int().min(1).max(200).default(80),
      })
      .strict()
      .refine((input) => Boolean(input.candidateId) !== Boolean(input.path), {
        message: "Provide exactly one of candidateId or path.",
      }),
    async (input, context = {}) => {
      abortIfNeeded(context.signal);
      const vault = await getVault();
      const scope = scopeFor(context);
      let candidate = null;
      if (input.candidateId) {
        candidate = candidatesByScope.get(scope)?.get(input.candidateId);
        if (!candidate)
          throw new Error(
            "This candidate belongs to another run or expired. Search again.",
          );
      }
      const path = candidate?.notePath || input.path;
      const indexedNote = (vault?.notes || []).find(
        (note) => note.path === path,
      );
      if (!indexedNote)
        throw new Error(
          "The requested note is not in the current vault index. Refresh the vault.",
        );
      if (candidate && candidate.noteHash !== indexedNote.hash)
        throw new Error(
          "The note version changed. Refresh the vault and search again.",
        );

      const note = await readCurrentNote(vault, indexedNote);
      abortIfNeeded(context.signal);
      let section = null;
      if (candidate) {
        section = note.sections.find(
          (entry) =>
            entry.line <= candidate.line && entry.endLine >= candidate.line,
        );
      } else if (input.headingPath?.length) {
        section = note.sections.find(
          (entry) =>
            JSON.stringify(entry.headingPath) ===
              JSON.stringify(input.headingPath) &&
            (input.line === undefined ||
              (entry.line <= input.line && entry.endLine >= input.line)),
        );
      } else if (input.blockId) {
        const blocks = note.blockIds.filter(
          (entry) => entry.id === input.blockId,
        );
        if (!blocks.length)
          throw new Error(
            "The requested block ID is not present in this note.",
          );
        if (blocks.length > 1 && input.line === undefined)
          throw new Error(
            "This block ID occurs more than once. Supply the intended line.",
          );
        const block =
          input.line === undefined
            ? blocks[0]
            : blocks.reduce((best, entry) =>
                Math.abs(entry.line - input.line) <
                Math.abs(best.line - input.line)
                  ? entry
                  : best,
              );
        section = note.sections.find(
          (entry) => entry.line <= block.line && entry.endLine >= block.line,
        );
      } else if (input.line !== undefined) {
        section = note.sections.find(
          (entry) => entry.line <= input.line && entry.endLine >= input.line,
        );
      }

      const startLine =
        candidate?.line ?? input.line ?? section?.startLine ?? 1;
      const endLine =
        candidate?.endLine ??
        section?.endLine ??
        note.content.split("\n").length;
      const range = withinLineRange(
        note,
        startLine,
        endLine,
        input.maxChars,
        input.maxLines,
      );
      if (!range.text.trim()) throw new Error("The selected passage is empty.");
      const headingPath = section?.headingPath || candidate?.headingPath || [];
      const blockId =
        candidate?.blockId ||
        input.blockId ||
        note.blockIds.find(
          (entry) =>
            entry.line >= range.lineStart && entry.line <= range.lineEnd,
        )?.id ||
        null;
      const inputEvidence = evidenceInput(
        note,
        {
          text: range.text,
          lineStart: range.lineStart,
          lineEnd: range.lineEnd,
          headingPath,
          section: headingPath.at(-1) || section?.title || "Overview",
          blockId,
        },
        context.runId,
      );
      inputEvidence.provenance = notePassageProvenance(
        store,
        vault.root,
        note,
        range.text,
      );
      const evidence = await registerEvidence(
        inputEvidence,
        context.toolCallId,
      );
      abortIfNeeded(context.signal);
      return {
        evidence: [evidence],
        title: note.title,
        path: note.path,
        version: note.hash,
        locator: {
          headingPath,
          section: headingLabel(headingPath),
          lineStart: range.lineStart,
          lineEnd: range.lineEnd,
          blockId,
        },
        text: range.text,
        freshness: "current",
      };
    },
  );

  const resolveLink = zodTool(
    "vault.resolve_link",
    "Resolve a wikilink, title, alias, or relative note path in the current vault. Ambiguous results are returned separately; no note contents are registered as evidence.",
    z
      .object({
        link: z.string().trim().min(1).max(1000),
        fromPath: z.string().trim().max(1000).optional(),
      })
      .strict(),
    async ({ link, fromPath }, context = {}) => {
      abortIfNeeded(context.signal);
      const vault = await getVault();
      const notes = vault?.notes || [];
      if (fromPath && !notes.some((note) => note.path === fromPath))
        throw new Error("The source path is not in the current vault index.");
      const matches = resolveLinkMatches(notes, link, fromPath || "").map(
        ({ note, matchType, originalTarget, fragment, blockId }) => ({
          path: note.path,
          title: note.title,
          aliases: note.aliases,
          type: note.type,
          matchType,
          version: note.hash,
          originalTarget,
          fragment,
          blockId,
        }),
      );
      return {
        originalLink: link,
        candidates: matches,
        ambiguous: matches.length > 1,
        resolved: matches.length === 1,
        resultKind: "identity-only",
      };
    },
  );

  const outline = zodTool(
    "vault.outline",
    "List a current note's hierarchical headings, line anchors, and existing block IDs without reading passage contents as evidence.",
    z.object({ path: z.string().trim().min(1).max(1000) }).strict(),
    async ({ path }, context = {}) => {
      abortIfNeeded(context.signal);
      const vault = await getVault();
      const note = (vault?.notes || []).find((entry) => entry.path === path);
      if (!note) throw new Error("The note is not in the current vault index.");
      return {
        path: note.path,
        title: note.title,
        version: note.hash,
        headings: note.headings.map((heading) => ({
          title: heading.title,
          level: heading.level,
          headingPath: heading.headingPath,
          line: heading.line,
          sectionEndLine:
            note.sections.find((section) => section.line === heading.line)
              ?.endLine || heading.line,
        })),
        blockIds: note.blockIds,
        resultKind: "outline-only",
      };
    },
  );

  const links = zodTool(
    "vault.links",
    "List explicit outgoing or incoming wikilinks for a current note, preserving their original heading and block fragments. Link metadata is not inspected passage evidence.",
    z
      .object({
        path: z.string().trim().min(1).max(1000),
        direction: z.enum(["outbound", "inbound", "both"]).default("both"),
        limit: z.number().int().min(1).max(100).default(40),
      })
      .strict(),
    async ({ path, direction, limit }, context = {}) => {
      abortIfNeeded(context.signal);
      const vault = await getVault();
      const notes = vault?.notes || [];
      const target = notes.find((note) => note.path === path);
      if (!target)
        throw new Error("The note is not in the current vault index.");
      const outgoing =
        direction === "inbound"
          ? []
          : target.links.map((link) => ({
              direction: "outbound",
              sourcePath: target.path,
              sourceTitle: target.title,
              originalTarget: link.originalTarget,
              fragment: link.fragment,
              blockId: link.blockId,
              display: link.display,
              headingPath: link.headingPath,
              line: link.line,
              embedded: link.embedded,
              candidates: resolveLinkMatches(notes, link, target.path).map(
                (match) => ({
                  path: match.note.path,
                  title: match.note.title,
                  matchType: match.matchType,
                  fragment: match.fragment,
                  blockId: match.blockId,
                }),
              ),
            }));
      const inbound =
        direction === "outbound"
          ? []
          : notes.flatMap((note) =>
              note.links
                .filter((link) =>
                  resolveLinkMatches(notes, link, note.path).some(
                    (match) => match.note.path === target.path,
                  ),
                )
                .map((link) => ({
                  direction: "inbound",
                  sourcePath: note.path,
                  sourceTitle: note.title,
                  originalTarget: link.originalTarget,
                  fragment: link.fragment,
                  blockId: link.blockId,
                  display: link.display,
                  headingPath: link.headingPath,
                  line: link.line,
                  embedded: link.embedded,
                })),
            );
      return {
        path: target.path,
        links: [...outgoing, ...inbound].slice(0, limit),
        resultKind: "link-metadata-only",
      };
    },
  );

  return [search, read, resolveLink, outline, links];
}
