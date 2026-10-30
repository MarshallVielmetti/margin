const legacyHandle = /^[SNC]\d+$/i;
const explicitHandle = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;
const protectedNodeTypes = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "html",
  "definition",
]);

export function sourceCitationAnchor(evidence, fallbackSourceId) {
  const sourceId = evidence.sourceId || fallbackSourceId;
  const page = Number(evidence.page ?? evidence.locator?.page);
  if (!sourceId || !Number.isInteger(page) || page < 1) return undefined;
  const locator = evidence.locator || {};
  const regionId =
    typeof locator.regionId === "string"
      ? locator.regionId
      : typeof evidence.regionId === "string"
        ? evidence.regionId
        : undefined;
  const box = locator.box || evidence.box;
  return {
    sourceId,
    page,
    quote: evidence.text,
    section: evidence.section,
    regionId,
    revision:
      (regionId && typeof locator.revision === "string"
        ? locator.revision
        : evidence.revision) || undefined,
    ...(Array.isArray(box) &&
    box.length === 4 &&
    box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
      ? { box }
      : {}),
  };
}

export function evidenceAliases(evidence) {
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

export function resolveEvidenceHandle(evidence, handle) {
  const candidates = (Array.isArray(evidence) ? evidence : []).filter((item) =>
    evidenceAliases(item).some(
      (alias) =>
        alias.toLocaleLowerCase() === String(handle).toLocaleLowerCase(),
    ),
  );
  const unique = candidates.filter(
    (item, index) =>
      candidates.findIndex(
        (candidate) =>
          candidate === item ||
          (candidate.id != null && item.id != null && candidate.id === item.id),
      ) === index,
  );
  return unique.length === 1 ? unique[0] : undefined;
}

export function citationLabel(evidence) {
  const title = String(evidence?.title || "Untitled source");
  const locator =
    evidence?.locator && typeof evidence.locator === "object"
      ? evidence.locator
      : {};
  const headingPath = Array.isArray(locator.headingPath)
    ? locator.headingPath.filter(
        (item) => typeof item === "string" && item.trim(),
      )
    : [];
  const section =
    [evidence?.section, locator.section, headingPath.at(-1)]
      .find((value) => typeof value === "string" && value.trim())
      ?.trim() || "";
  if (section) return `${title} · ${section}`;
  const page = evidence?.page ?? locator.page;
  if (Number.isFinite(Number(page)) && Number(page) > 0)
    return `${title} · p. ${page}`;
  return title;
}

function vaultName(context) {
  if (typeof context?.vaultId === "string" && context.vaultId.trim()) {
    const configured = context.vaultId.trim().replace(/[\\/]+$/, "");
    return configured.includes("/") || configured.includes("\\")
      ? configured.split(/[\\/]/).filter(Boolean).at(-1) || ""
      : configured;
  }
  const root = String(context?.vaultRoot || "").replace(/[\\/]+$/, "");
  return root.split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function safeVaultPath(path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0"))
    return "";
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !/\.md$/i.test(normalized)
  )
    return "";
  return normalized;
}

/** Build a source-controlled Obsidian URI from evidence and configured vault identity. */
export function resolveCitationTarget(evidence, context = {}) {
  if (
    evidence?.sourceId &&
    context.marginOrigin &&
    (evidence.sessionId || context.sessionId)
  ) {
    try {
      const origin = new URL(context.marginOrigin);
      if (
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname)
      ) {
        const anchor = {
          ...evidence.locator,
          sourceId: evidence.sourceId,
          page: evidence.page || evidence.locator?.page || 1,
        };
        origin.search = new URLSearchParams({
          session: evidence.sessionId || context.sessionId,
          anchor: JSON.stringify(anchor),
        }).toString();
        return origin.href;
      }
    } catch {
      /* Fall back to a readable source locator. */
    }
  }
  const path = safeVaultPath(evidence?.path);
  const vault = vaultName(
    typeof evidence?.vaultId === "string"
      ? { ...context, vaultId: evidence.vaultId }
      : context,
  );
  if (!path || !vault) return undefined;

  const locator =
    evidence.locator && typeof evidence.locator === "object"
      ? evidence.locator
      : {};
  const blockId = String(locator.blockId || evidence.blockId || "").replace(
    /^\^/,
    "",
  );
  const headingPath = Array.isArray(locator.headingPath)
    ? locator.headingPath.filter(
        (item) => typeof item === "string" && item.trim(),
      )
    : [];
  const section = String(
    locator.heading ||
      locator.section ||
      evidence.section ||
      headingPath.at(-1) ||
      "",
  ).trim();
  const occurrence = Number(
    locator.headingOccurrence || evidence.headingOccurrence || 1,
  );
  const lineValue = evidence.line ?? locator.lineStart ?? locator.line;
  const numericLine = Number(lineValue);
  const line =
    Number.isFinite(numericLine) && numericLine > 0
      ? Math.floor(numericLine)
      : 1;
  const params = new URLSearchParams({ vault, file: path });

  if (context.bridge) {
    // The installed bridge jumps to the supplied heading, or exact line when
    // duplicate headings or block IDs make a heading-name jump ambiguous.
    if (headingPath.length)
      params.set("headingPath", JSON.stringify(headingPath));
    else if (!blockId && section && occurrence <= 1)
      params.set("heading", section);
    if (blockId) params.set("blockId", blockId);
    params.set("line", String(line));
    return `obsidian://margin?${params.toString()}`;
  }

  if (blockId) params.set("file", `${path}#^${blockId}`);
  else if (section && occurrence <= 1) params.set("file", `${path}#${section}`);
  return `obsidian://open?${params.toString()}`;
}

function markdownEscape(value) {
  return String(value).replace(/[\\`*_{}[\]()#+.!|>]/g, "\\$&");
}

function safeZoteroTarget(value) {
  if (typeof value !== "string" || !value.startsWith("zotero://")) return "";
  try {
    return new URL(value).protocol === "zotero:" ? value : "";
  } catch {
    return "";
  }
}

export function readableCitationMarkdown(evidence, context = {}) {
  const label = markdownEscape(citationLabel(evidence));
  const target =
    resolveCitationTarget(evidence, context) ||
    safeZoteroTarget(evidence?.zotero);
  if (target) return `[${label}](<${target}>)`;

  const locators = [];
  if (evidence?.sourceId) locators.push(`source ${String(evidence.sourceId)}`);
  if (Number.isFinite(Number(evidence?.page)) && Number(evidence.page) > 0)
    locators.push(`page ${evidence.page}`);
  if (evidence?.locator?.span) locators.push(String(evidence.locator.span));
  if (evidence?.revision)
    locators.push(`revision ${String(evidence.revision)}`);
  return locators.length
    ? `${label} (${locators.map(markdownEscape).join(", ")})`
    : label;
}

function parseCitationText(text) {
  const pattern =
    /\{\{cite:([A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127})\}\}|\[((?:[SNC]\d+)(?:\s*,\s*[SNC]\d+)*)\]/gi;
  const tokens = [];
  for (const match of text.matchAll(pattern)) {
    const explicit = match[1] !== undefined;
    const handles = explicit
      ? [match[1]]
      : match[2].split(",").map((handle) => handle.trim());
    if (handles.some((handle) => !explicitHandle.test(handle))) continue;
    if (!explicit && handles.some((handle) => !legacyHandle.test(handle)))
      continue;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      explicit,
      handles,
    });
  }
  return tokens;
}

function citationNode(handle, raw) {
  return {
    type: "citation",
    data: {
      hName: "citation",
      hProperties: { handle, original: raw },
    },
  };
}

function rawOffsetAtParsedText(sourceText, parsedText, parsedOffset) {
  let sourceIndex = 0;
  let parsedIndex = 0;
  while (parsedIndex < parsedOffset && sourceIndex < sourceText.length) {
    if (
      sourceText[sourceIndex] === "\\" &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/.test(
        sourceText[sourceIndex + 1] || "",
      )
    )
      sourceIndex++;
    if (sourceText[sourceIndex] === parsedText[parsedIndex]) {
      sourceIndex++;
      parsedIndex++;
    } else {
      const next = sourceText.indexOf(parsedText[parsedIndex], sourceIndex);
      if (next < 0) return -1;
      sourceIndex = next + 1;
      parsedIndex++;
    }
  }
  return parsedIndex === parsedOffset ? sourceIndex : -1;
}

function rewriteTextNode(node, sourceValue = "") {
  const text = String(node.value || "");
  const citations = parseCitationText(text);
  if (!citations.length) return [node];
  const sourceStart = node.position?.start?.offset;
  const sourceEnd = node.position?.end?.offset;
  const sourceText =
    Number.isInteger(sourceStart) && Number.isInteger(sourceEnd)
      ? sourceValue.slice(sourceStart, sourceEnd)
      : "";
  const latexRanges = [
    ...sourceText.matchAll(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g),
  ].map((match) => [match.index, match.index + match[0].length]);
  const visibleCitations = citations.filter((citation) => {
    const rawStart = rawOffsetAtParsedText(sourceText, text, citation.start);
    if (rawStart < 0) return true;
    return !latexRanges.some(
      ([start, end]) => rawStart >= start && rawStart < end,
    );
  });
  if (!visibleCitations.length) return [node];
  const children = [];
  let cursor = 0;
  for (const citation of visibleCitations) {
    if (citation.start > cursor)
      children.push({
        type: "text",
        value: text.slice(cursor, citation.start),
      });
    citation.handles.forEach((handle, index) => {
      if (index) children.push({ type: "text", value: ", " });
      const original = citation.explicit ? citation.raw : `[${handle}]`;
      children.push(citationNode(handle, original));
    });
    cursor = citation.end;
  }
  if (cursor < text.length)
    children.push({ type: "text", value: text.slice(cursor) });
  return children;
}

/** Remark plugin: only ordinary mdast text nodes are eligible for citation parsing. */
export function remarkCitations(options = {}) {
  return (tree, file) => {
    const sourceValue = typeof file?.value === "string" ? file.value : "";
    function visit(node) {
      if (
        !node ||
        protectedNodeTypes.has(node.type) ||
        !Array.isArray(node.children)
      )
        return;
      const next = [];
      for (const child of node.children) {
        if (child.type === "text")
          next.push(...rewriteTextNode(child, sourceValue));
        else {
          visit(child);
          next.push(child);
        }
      }
      node.children = next;
    }
    visit(tree);
  };
}

function markdownLiteralRanges(text) {
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
    if (text[i] === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(close, i + 2);
      if (end >= 0) {
        ranges.push([i, end + 2]);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
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
    if (text[i] === "$" && text[i - 1] !== "\\") {
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

  // Match the AST plugin's behavior for existing Markdown links: their labels
  // are already an authored link target and must not become nested citations.
  for (const match of text.matchAll(/\[[^\]\n]*\]\([^\n)]*\)/g))
    ranges.push([match.index, match.index + match[0].length]);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function replaceReadableText(text, evidence, context) {
  const tokens = parseCitationText(text);
  if (!tokens.length) return text;
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    result += text.slice(cursor, token.start);
    const items = token.handles.map((handle) =>
      resolveEvidenceHandle(evidence, handle),
    );
    if (items.some((item) => !item)) result += token.raw;
    else
      result += items
        .map((item) => readableCitationMarkdown(item, context))
        .join(", ");
    cursor = token.end;
  }
  return result + text.slice(cursor);
}

/** Replace citation handles in copy/export text while leaving code and math literal. */
export function exportReadableMarkdown(text, evidence, context = {}) {
  const source = String(text || "");
  const ranges = markdownLiteralRanges(source);
  let output = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    output += replaceReadableText(
      source.slice(cursor, start),
      evidence,
      context,
    );
    output += source.slice(start, end);
    cursor = end;
  }
  return output + replaceReadableText(source.slice(cursor), evidence, context);
}
