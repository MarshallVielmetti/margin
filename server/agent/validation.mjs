const handlePattern = /^(?:ev_[A-Za-z0-9_-]{1,128}|[A-Za-z][A-Za-z0-9_-]*\d+)$/;

function aliases(evidence) {
  return [
    evidence?.id,
    evidence?.handle,
    evidence?.promptHandle,
    evidence?.label,
    ...(Array.isArray(evidence?.handles) ? evidence.handles : []),
    ...(Array.isArray(evidence?.aliases) ? evidence.aliases : []),
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function protectedRanges(text) {
  const ranges = [];
  let offset = 0;
  let fence = null;
  for (const line of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    const body = line.replace(/\r?\n$/, "");
    const marker = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && marker) {
      fence = { char: marker[1][0], length: marker[1].length, start: offset };
    } else if (
      fence &&
      new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(body)
    ) {
      ranges.push([fence.start, offset + line.length]);
      fence = null;
    }
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, text.length]);

  const inRange = (index) =>
    ranges.some(([start, end]) => index >= start && index < end);
  for (let i = 0; i < text.length;) {
    if (inRange(i)) {
      i = ranges.find(([, end]) => i < end)[1];
      continue;
    }
    const char = text[i];
    if (char === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(close, i + 2);
      if (end >= 0) {
        ranges.push([i, end + 2]);
        i = end + 2;
        continue;
      }
    }
    if (char === "`") {
      let length = 1;
      while (text[i + length] === "`") length++;
      const delimiter = "`".repeat(length);
      const end = text.indexOf(delimiter, i + length);
      if (end >= 0) {
        ranges.push([i, end + length]);
        i = end + length;
        continue;
      }
    }
    if (char === "$" && (i === 0 || text[i - 1] !== "\\")) {
      const length = text[i + 1] === "$" ? 2 : 1;
      const delimiter = "$".repeat(length);
      let end = text.indexOf(delimiter, i + length);
      if (length === 1 && end >= 0 && text.slice(i + 1, end).includes("\n"))
        end = -1;
      if (end >= 0) {
        ranges.push([i, end + length]);
        i = end + length;
        continue;
      }
    }
    i++;
  }
  for (const match of text.matchAll(
    /\\\{\{cite:[^}\s]+\}\}|\\\[(?:[SNC]\d+(?:\s*,\s*[SNC]\d+)*)\]/gi,
  ))
    ranges.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/\[[^\]\n]*\]\([^\n)]*\)/g))
    ranges.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/\[[^\]\n]+\]\[[^\]\n]*\]/g))
    ranges.push([match.index, match.index + match[0].length]);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function visibleText(text) {
  const ranges = protectedRanges(text);
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    result += text.slice(cursor, start) + " ".repeat(end - start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

function citationHandles(text) {
  const visible = visibleText(text);
  const results = [];
  const pattern =
    /\{\{cite:([^}\s]+)\}\}|\[((?:[SNC]\d+)(?:\s*,\s*[SNC]\d+)*)\]/gi;
  for (const match of visible.matchAll(pattern)) {
    const explicit = match[1] !== undefined;
    const handles = explicit
      ? [match[1]]
      : match[2].split(",").map((value) => value.trim());
    results.push({
      raw: match[0],
      handles,
      explicit,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
}

function requiredLabelPresent(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^\d+$/.test(label)) {
    const visible = visibleText(text);
    return (
      new RegExp(`\\[\\s*${escaped}\\s*\\]`).test(visible) ||
      new RegExp(`(?:^|\\n)\\s*${escaped}[.)]\\s+`).test(visible) ||
      new RegExp(
        `\\b(?:reference|citation|entry)\\s+#?${escaped}\\b`,
        "i",
      ).test(visible)
    );
  }
  return citationHandles(text).some((citation) =>
    citation.handles.some(
      (handle) => handle.toLowerCase() === label.toLowerCase(),
    ),
  );
}

function normalizeQuote(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateQuoteAnnotations({
  visibleAnswer,
  sources,
  quotes,
  byHandle,
  issues,
}) {
  const quoteChecks = [];
  const checked = new Set();
  const answerText = normalizeQuote(visibleAnswer);

  for (const annotation of Array.isArray(quotes) ? quotes : []) {
    const evidenceId = String(annotation?.evidenceId || "").trim();
    const quote = normalizeQuote(annotation?.text);
    if (!evidenceId || !quote) {
      issues.push({
        code: "invalid-quote-annotation",
        evidenceId: evidenceId || undefined,
      });
      continue;
    }
    checked.add(`${evidenceId}\0${quote}`);
    const matches = sources.filter((source) => source.id === evidenceId);
    if (matches.length !== 1) {
      issues.push({
        code: matches.length
          ? "ambiguous-quote-evidence"
          : "unresolved-quote-evidence",
        evidenceId,
      });
      continue;
    }
    if (!answerText.includes(quote)) {
      issues.push({ code: "quotation-not-in-answer", evidenceId, text: quote });
      continue;
    }
    if (!normalizeQuote(matches[0].text).includes(quote)) {
      issues.push({ code: "quotation-mismatch", evidenceId, text: quote });
      continue;
    }
    quoteChecks.push({ evidenceId, text: quote, status: "matched" });
  }

  const quotePatterns = [
    /“([^”\n]{1,2000})”\s*[.,;:!?]?\s*(\{\{cite:[^}\s]+\}\}|\[(?:[SNC]\d+(?:\s*,\s*[SNC]\d+)*)\])/gi,
    /"([^"\n]{1,2000})"\s*[.,;:!?]?\s*(\{\{cite:[^}\s]+\}\}|\[(?:[SNC]\d+(?:\s*,\s*[SNC]\d+)*)\])/gi,
  ];
  for (const pattern of quotePatterns) {
    for (const match of visibleAnswer.matchAll(pattern)) {
      const quote = normalizeQuote(match[1]);
      const citation = citationHandles(match[2])[0];
      if (!citation || citation.handles.length !== 1) continue;
      const candidates = byHandle.get(citation.handles[0].toLowerCase()) || [];
      if (candidates.length !== 1) continue;
      const evidenceId = candidates[0].id;
      if (checked.has(`${evidenceId}\0${quote}`)) continue;
      if (!normalizeQuote(candidates[0].text).includes(quote)) {
        issues.push({ code: "quotation-mismatch", evidenceId, text: quote });
        checked.add(`${evidenceId}\0${quote}`);
      } else {
        quoteChecks.push({ evidenceId, text: quote, status: "matched" });
        checked.add(`${evidenceId}\0${quote}`);
      }
    }
  }
  return quoteChecks;
}

/** Validate citation references against the evidence attached to one answer. */
export function validateAnswer({
  text,
  evidence = [],
  requiredLabels = [],
  quotes = [],
} = {}) {
  const answer = typeof text === "string" ? text : "";
  const sources = Array.isArray(evidence) ? evidence : [];
  const byHandle = new Map();
  for (const item of sources) {
    for (const handle of aliases(item)) {
      const key = handle.toLowerCase();
      const candidates = byHandle.get(key) || [];
      if (
        !candidates.some(
          (candidate) =>
            candidate === item ||
            (candidate.id != null &&
              item.id != null &&
              candidate.id === item.id),
        )
      )
        candidates.push(item);
      byHandle.set(key, candidates);
    }
  }

  const issues = [];
  const citations = [];
  for (const citation of citationHandles(answer)) {
    for (const handle of citation.handles) {
      if (!handlePattern.test(handle)) {
        issues.push({
          code: "invalid-citation-handle",
          handle,
          raw: citation.raw,
        });
        citations.push({ handle, status: "invalid" });
        continue;
      }
      const candidates = byHandle.get(handle.toLowerCase()) || [];
      if (candidates.length === 0) {
        issues.push({ code: "unresolved-citation", handle, raw: citation.raw });
        citations.push({ handle, status: "unresolved" });
      } else if (candidates.length > 1) {
        issues.push({ code: "ambiguous-citation", handle, raw: citation.raw });
        citations.push({ handle, status: "ambiguous" });
      } else {
        citations.push({
          handle,
          evidenceId: candidates[0].id,
          status: "resolved",
        });
      }
    }
  }

  const required = Array.isArray(requiredLabels) ? requiredLabels : [];
  for (const rawLabel of required) {
    const label = String(rawLabel).trim();
    if (!label || requiredLabelPresent(answer, label)) continue;
    issues.push({ code: "missing-required-label", label });
  }

  const visibleAnswer = visibleText(answer);
  const quoteChecks = validateQuoteAnnotations({
    visibleAnswer,
    sources,
    quotes,
    byHandle,
    issues,
  });

  return { valid: issues.length === 0, issues, citations, quotes: quoteChecks };
}
