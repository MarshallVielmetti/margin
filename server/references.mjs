import { createHash } from "node:crypto";
import { matchReferenceToLibrary } from "./zotero.mjs";

const MAX_LABELS = 30;
const MAX_PAGES = 2000;
const MAX_REFERENCE_CHARS = 6000;
export const REFERENCE_PARSER_VERSION = "bibliography-v3";
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

/** Parse numbered reference labels only when the question names citations/references. */
export function referenceLabels(question) {
  const value =
    typeof question === "string" ? question : String(question ?? "");
  const labels = [];
  const seen = new Set();
  const keyword = /\b(?:citations?|references?|refs?)\b/gi;
  const number =
    /^(?:\[\s*(\d{1,3})(?!\d)\s*\]|\(\s*(\d{1,3})(?!\d)\s*\)|#?\s*(\d{1,3})(?!\d))/;
  const groupedNumbers =
    /^(?:\[\s*(\d{1,3}(?!\d)(?:\s*,\s*\d{1,3}(?!\d))+?)\s*\]|\(\s*(\d{1,3}(?!\d)(?:\s*,\s*\d{1,3}(?!\d))+?)\s*\))/;
  const nextLabels = (text) => {
    const group = groupedNumbers.exec(text);
    if (group) {
      return {
        labels: (group[1] || group[2]).match(/\d{1,3}/g) || [],
        length: group[0].length,
      };
    }
    const single = number.exec(text);
    if (!single) return undefined;
    return {
      labels: [single[1] || single[2] || single[3]],
      length: single[0].length,
    };
  };
  let match;

  while ((match = keyword.exec(value)) && labels.length < MAX_LABELS) {
    const tail = value.slice(keyword.lastIndex);
    let cursor = tail.match(/^\s*[:#]?\s*/)?.[0].length || 0;
    let token = nextLabels(tail.slice(cursor));
    if (!token) continue;
    while (token && labels.length < MAX_LABELS) {
      for (const label of token.labels) {
        if (labels.length >= MAX_LABELS) break;
        if (label && Number(label) > 0 && !seen.has(label)) {
          labels.push(label);
          seen.add(label);
        }
      }
      cursor += token.length;
      const rest = tail.slice(cursor);
      const connector =
        /^(?:\s*,\s*(?:\band\b\s*)?|\s*(?:;|\/|&|\band\b|\bor\b)\s*|\s+(?=\[|\())/i.exec(
          rest,
        );
      if (!connector) break;
      cursor += connector[0].length;
      token = nextLabels(tail.slice(cursor));
    }
  }
  return labels;
}

const pageText = (page) =>
  typeof page === "string"
    ? page
    : typeof page?.text === "string"
      ? page.text
      : "";

function bibliographyHeading(text) {
  const lines = [];
  const linePattern = /[^\r\n]+/g;
  let match;
  while ((match = linePattern.exec(text))) {
    const line = match[0];
    const leading = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    const clean = trimmed.replace(/^(?:\d+(?:\.\d+)*[.)]?\s+)?/, "");
    if (
      /^(?:references(?:\s+(?:and\s+notes|and\s+citations|and\s+further\s+reading|cited))?|selected references|bibliography|works cited|literature(?: cited| references)?)(?:\s*\([^)]*\))?\s*[:.]?$/i.test(
        clean,
      )
    ) {
      lines.push({
        start: match.index + leading,
        end: match.index + line.length,
      });
    }
  }

  // Some PDF extractors flatten a heading and the first entry onto one line.
  if (!lines.length) {
    const flat =
      /\b(?:references(?:\s+(?:and\s+notes|and\s+citations|and\s+further\s+reading|cited))?|selected references|bibliography|works cited|literature(?: cited| references)?)\b\s*(?=(?:\[\s*\d{1,3}(?!\d)\s*\]|\(\s*\d{1,3}(?!\d)\s*\)|\d{1,3}(?!\d)[.)]\s))/gi;
    while ((match = flat.exec(text))) {
      lines.push({ start: match.index, end: flat.lastIndex });
    }
  }
  return lines;
}

const stopHeading = (line) => {
  const clean = line.trim().replace(/^(?:\d+(?:\.\d+)*[.)]?\s+)?/, "");
  return /^(?:appendix(?:\s+[A-Z0-9])?|acknowledg(?:e)?ments?|supplement(?:ary material)?|author contributions|funding|conflict of interest|data availability|index)\s*[:.]?$/i.test(
    clean,
  );
};

function bibliographySegments(pages) {
  const sections = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    for (const heading of bibliographyHeading(pages[pageIndex])) {
      const pieces = [];
      let ended = false;
      for (let index = pageIndex; index < pages.length && !ended; index++) {
        const start = index === pageIndex ? heading.end : 0;
        const remaining = pages[index].slice(start);
        let stopAt = remaining.length;
        const linePattern = /[^\r\n]+/g;
        let line;
        while ((line = linePattern.exec(remaining))) {
          if (stopHeading(line[0])) {
            stopAt = line.index;
            ended = true;
            break;
          }
        }
        pieces.push({
          page: index + 1,
          pageStart: start,
          text: remaining.slice(0, stopAt),
        });
      }
      sections.push({ startPage: pageIndex + 1, pieces });
    }
  }
  return sections;
}

function referenceMarkers(text) {
  const lineStart =
    /(?:^|[\r\n])[ \t]{0,12}(?:[•*\-][ \t]*)?(?:\[\s*(\d{1,3})\s*\]|\(\s*(\d{1,3})\s*\)|(\d{1,3})[.)])(?=[ \t])/g;
  const markers = [];
  let match;
  while ((match = lineStart.exec(text))) {
    const label = match[1] || match[2] || match[3];
    const markerAt =
      match.index +
      match[0].search(/(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|\d{1,3}[.)])/);
    if (label && Number(label) > 0) markers.push({ label, at: markerAt });
  }
  if (markers.length) return markers;

  // Flattened extraction has no line boundaries. Restrict this fallback to bracketed labels.
  const flat = /(?<![\p{L}\p{N}])\[\s*(\d{1,3})\s*\][ \t]+/gu;
  while ((match = flat.exec(text))) {
    if (Number(match[1]) > 0)
      markers.push({ label: match[1], at: match.index });
  }
  return markers;
}

function hasInterleavedColumns(markers) {
  const labels = markers.map((marker) => Number(marker.label));
  if (labels.length < 4) return false;
  for (let i = 0; i + 3 < labels.length; i++) {
    if (
      labels[i + 1] > labels[i] + 1 &&
      labels[i + 2] === labels[i] + 1 &&
      labels[i + 3] === labels[i + 1] + 1
    )
      return true;
  }
  let drops = 0;
  for (let i = 1; i < labels.length; i++)
    if (labels[i] < labels[i - 1]) drops++;
  return drops > 0 && new Set(labels).size >= 4;
}

function candidateEntries(sections) {
  const all = [];
  for (const section of sections) {
    const chunks = [];
    for (const piece of section.pieces) {
      const start = chunks.length
        ? chunks.at(-1).start + chunks.at(-1).text.length + 1
        : 0;
      chunks.push({
        ...piece,
        start,
        end: start + piece.text.length,
      });
    }
    const text = chunks.map((chunk) => chunk.text).join("\n");
    const markers = referenceMarkers(text);
    const locationAt = (offset) => {
      let selected = chunks[0];
      for (const chunk of chunks) {
        if (offset >= chunk.start) selected = chunk;
        else break;
      }
      return {
        page: selected.page,
        offset:
          selected.pageStart +
          Math.max(0, Math.min(selected.text.length, offset - selected.start)),
      };
    };
    markers.forEach((marker, index) => {
      const end = markers[index + 1]?.at ?? text.length;
      const fullText = text.slice(marker.at, end).trim();
      const startLocation = locationAt(marker.at);
      const endLocation = locationAt(end);
      const firstPage = startLocation.page;
      const lastPage = locationAt(Math.max(marker.at, end - 1)).page;
      const pages = [];
      for (let page = firstPage; page <= lastPage; page++) pages.push(page);
      all.push({
        label: marker.label,
        text: fullText.slice(0, MAX_REFERENCE_CHARS),
        textTruncated: fullText.length > MAX_REFERENCE_CHARS,
        page: firstPage,
        pages,
        start: marker.at,
        span: {
          start: startLocation,
          end: endLocation,
          offsetUnit: "utf16-code-unit",
        },
        sectionStart: section.startPage,
        markers,
      });
    });
  }
  return all;
}

function referenceIdentity(sourceId, revision, label) {
  return `ref_${hash(`${sourceId}\0${revision}\0${label}`).slice(0, 28)}`;
}

function paperReferenceCacheId(sourceId, revision, label) {
  return `pr_${hash(`${REFERENCE_PARSER_VERSION}\0${sourceId}\0${revision}\0${label}`).slice(0, 32)}`;
}

function cachedExtraction(record, sourceId, revision, label) {
  if (
    !record ||
    record.parserVersion !== REFERENCE_PARSER_VERSION ||
    record.sourceId !== sourceId ||
    record.revision !== revision ||
    record.label !== label ||
    record.referenceId !== referenceIdentity(sourceId, revision, label)
  )
    return undefined;
  const { id: _cacheId, referenceId, updatedAt: _updatedAt, ...entry } = record;
  return { ...entry, id: referenceId };
}

function metadataMatchFor(extracted, store) {
  if (!extracted.text)
    return {
      status: "unavailable",
      reason: "No extracted entry text to compare.",
    };
  if (extracted.status === "ambiguous")
    return {
      status: "ambiguous",
      reason:
        "Metadata comparison was withheld because reference extraction is ambiguous.",
    };
  return matchReferenceToLibrary(extracted.text, store);
}

function layoutPagesFor(source) {
  const pages = source?.extraction?.pages;
  if (!Array.isArray(pages)) return new Set();
  return new Set(
    pages
      .filter((item) => {
        const layout = String(
          item?.layout || item?.quality || "",
        ).toLowerCase();
        return (
          layout.includes("two-column") ||
          layout.includes("two_column") ||
          item?.status === "ambiguous"
        );
      })
      .map((item, index) => Number(item?.page || index + 1))
      .filter((page) => Number.isInteger(page) && page > 0),
  );
}

function sourceRevision(source, pages) {
  const content = pages.map((page) => page).join("\u0000");
  return `sha256:${hash(`${source.revision || source.fingerprint || ""}\0${content}`)}`;
}

export function revisionForSource(source) {
  const pages = (Array.isArray(source?.pages) ? source.pages : [])
    .slice(0, MAX_PAGES)
    .map(pageText);
  return sourceRevision(source || {}, pages);
}

/** Resolve requested numeric labels by scanning every extracted page of a registered source. */
export async function resolveReferences(
  source,
  labels,
  { store, signal } = {},
) {
  signal?.throwIfAborted();
  if (!source || typeof source !== "object")
    throw new TypeError("A registered source is required.");
  const sourceId = String(source.id || source.sourceId || "");
  if (!sourceId) throw new TypeError("The source has no registered identity.");
  if (!Array.isArray(source.pages))
    throw new TypeError("The source has no page text.");
  if (!Array.isArray(labels))
    throw new TypeError("Reference labels must be an array.");
  const requested = [...new Set(labels.map(String))].slice(0, MAX_LABELS);
  if (requested.some((label) => !/^\d{1,3}$/.test(label) || Number(label) < 1))
    throw new TypeError(
      "Reference labels must be positive integers up to three digits.",
    );

  const truncated = source.pages.length > MAX_PAGES;
  const pages = [];
  for (
    let index = 0;
    index < Math.min(source.pages.length, MAX_PAGES);
    index++
  ) {
    signal?.throwIfAborted();
    pages.push(pageText(source.pages[index]));
    if (index % 25 === 24)
      await new Promise((resolve) => setImmediate(resolve));
  }
  const revision = sourceRevision(source, pages);
  const cache = new Map();
  if (typeof store?.get === "function") {
    for (const label of requested) {
      signal?.throwIfAborted();
      const record = await store.get(
        "paperReference",
        paperReferenceCacheId(sourceId, revision, label),
      );
      const entry = cachedExtraction(record, sourceId, revision, label);
      if (entry) cache.set(label, entry);
    }
  }
  const labelsToExtract = requested.filter((label) => !cache.has(label));
  const readableChars = pages.reduce(
    (sum, page) => sum + page.trim().length,
    0,
  );
  const readablePageCount = pages.filter(
    (page) => page.trim().length >= 20,
  ).length;
  const trailingPages = pages.slice(-Math.min(3, pages.length));
  const scannedAtEnd =
    pages.length > 1 &&
    readablePageCount > 0 &&
    trailingPages.some((page) => page.trim().length < 20);
  const fullyScanned = readableChars < 20;
  const sections =
    !labelsToExtract.length || fullyScanned ? [] : bibliographySegments(pages);
  const entries = candidateEntries(sections);
  const interleaved = entries.some((entry) =>
    hasInterleavedColumns(entry.markers),
  );
  const byLabel = new Map();
  for (const entry of entries) {
    const group = byLabel.get(entry.label) || [];
    group.push(entry);
    byLabel.set(entry.label, group);
  }
  const pageLayouts = layoutPagesFor(source);
  const hasPageLayoutMetadata = Array.isArray(source.extraction?.pages);
  const explicitLayoutWarning =
    source.extractionStatus === "ambiguous" ||
    source.extraction?.status === "ambiguous" ||
    source.layoutQuality === "two-column-uncertain";
  const globalLayoutAmbiguous =
    interleaved || (explicitLayoutWarning && !hasPageLayoutMetadata);
  const bibliographyLayoutPages = [
    ...new Set(
      sections
        .flatMap((section) => section.pieces.map((piece) => piece.page))
        .filter((page) => pageLayouts.has(page)),
    ),
  ].sort((a, b) => a - b);

  const resolved = [];
  for (const label of requested) {
    signal?.throwIfAborted();
    const cached = cache.get(label);
    if (cached) {
      const metadataMatch = metadataMatchFor(cached, store);
      resolved.push({ ...cached, metadataMatch });
      continue;
    }
    const candidates = byLabel.get(label) || [];
    let status = "missing";
    let reason;
    let extractionStatus = sections.length
      ? "bibliography_text_extracted"
      : "bibliography_heading_missing";
    let result = { label, text: "", page: null, pages: [], span: null };
    const base = {
      sourceId,
      revision,
      id: referenceIdentity(sourceId, revision, label),
    };
    if (
      fullyScanned ||
      (sections.length &&
        entries.length === 0 &&
        sections.every((section) =>
          section.pieces.every((piece) => piece.text.trim().length < 30),
        )) ||
      (!sections.length && scannedAtEnd)
    ) {
      status = "scanned";
      extractionStatus =
        scannedAtEnd && !fullyScanned
          ? "sparse_trailing_pages"
          : "no_readable_bibliography_text";
      reason =
        scannedAtEnd && !fullyScanned
          ? "The final source pages contain no readable text. The bibliography may be scanned, so a missing text match cannot rule out an entry."
          : "No readable text was extracted from the source or bibliography pages; the PDF may be scanned.";
    } else if (candidates.length > 1) {
      status = "ambiguous";
      extractionStatus = "duplicate_label";
      reason = `The bibliography contains ${candidates.length} entries labeled ${label}.`;
      result = {
        ...result,
        text: candidates.map((candidate) => candidate.text).join("\n\n"),
        textTruncated: candidates.some((candidate) => candidate.textTruncated),
        page: candidates[0].page,
        pages: [
          ...new Set(candidates.flatMap((candidate) => candidate.pages)),
        ].sort((a, b) => a - b),
        candidates: candidates.map(
          ({
            label: _label,
            text,
            textTruncated,
            page,
            pages: entryPages,
            span,
          }) => ({ text, textTruncated, page, pages: entryPages, span }),
        ),
      };
    } else if (candidates.length === 1) {
      const candidate = candidates[0];
      result = {
        ...result,
        text: candidate.text,
        textTruncated: candidate.textTruncated,
        page: candidate.page,
        pages: candidate.pages,
        span: candidate.span,
      };
      if (candidate.textTruncated) {
        status = "incomplete";
        extractionStatus = "entry_text_limit";
        reason = `The extracted entry for ${label} exceeded the ${MAX_REFERENCE_CHARS}-character text limit.`;
      } else if (
        globalLayoutAmbiguous ||
        candidate.pages.some((page) => pageLayouts.has(page))
      ) {
        status = "ambiguous";
        extractionStatus = "possible_two_column_layout";
        reason =
          "PDF text order or page layout suggests two columns. The extracted entry may combine text from separate columns.";
      } else {
        status = "found";
        extractionStatus = "text_extracted";
      }
    } else if (bibliographyLayoutPages.length) {
      status = "ambiguous";
      extractionStatus = "possible_two_column_layout";
      result = {
        ...result,
        page: bibliographyLayoutPages[0],
        pages: bibliographyLayoutPages,
      };
      reason = `The bibliography includes pages with uncertain two-column text order (${bibliographyLayoutPages.join(", ")}); no safe match for label ${label} was extracted.`;
    } else if (truncated) {
      status = "incomplete";
      extractionStatus = "page_scan_limit";
      reason = `The source has more than ${MAX_PAGES} pages; the scan stopped at the configured page limit.`;
    } else if (!sections.length) {
      reason =
        "No recognizable bibliography heading was found in the extracted source text.";
    } else {
      reason = `No numbered bibliography entry labeled ${label} was found.`;
    }
    const extracted = {
      ...base,
      ...result,
      status,
      extractionStatus,
      ...(reason ? { reason } : {}),
    };
    if (typeof store?.put === "function") {
      signal?.throwIfAborted();
      await store.put("paperReference", {
        ...extracted,
        id: paperReferenceCacheId(sourceId, revision, label),
        referenceId: extracted.id,
        parserVersion: REFERENCE_PARSER_VERSION,
      });
    }
    resolved.push({
      ...extracted,
      metadataMatch: metadataMatchFor(extracted, store),
    });
  }
  signal?.throwIfAborted();
  return {
    sourceId,
    revision,
    parserVersion: REFERENCE_PARSER_VERSION,
    entries: resolved,
  };
}
