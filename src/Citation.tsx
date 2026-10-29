import { useEffect, useState } from "react";
import {
  citationLabel,
  readableCitationMarkdown,
  resolveCitationTarget,
  resolveEvidenceHandle,
} from "./citations.mjs";
import type { CitationContext, CitationEvidence } from "./citations.mjs";
import type { Anchor } from "./types";
import { api } from "./api";

type CurrentEvidenceStatus = {
  freshness?: string;
  currentPath?: string;
};

export function Citation({
  handle,
  original,
  evidence = [],
  citationContext,
  onAnchor,
}: {
  handle: string;
  original: string;
  evidence?: CitationEvidence[];
  citationContext?: Partial<CitationContext>;
  onAnchor?: (anchor: Anchor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentStatus, setCurrentStatus] =
    useState<CurrentEvidenceStatus | null>(null);
  const [freshnessCheckFailed, setFreshnessCheckFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const source = resolveEvidenceHandle(evidence, handle);
  const evidenceId = source?.id;
  const isLegacyCitation = Boolean(evidenceId && !evidenceId.startsWith("ev_"));
  useEffect(() => {
    if (!evidenceId || isLegacyCitation) {
      setCurrentStatus(null);
      setFreshnessCheckFailed(false);
      return;
    }
    let active = true;
    setCurrentStatus(null);
    setFreshnessCheckFailed(false);
    void api<CurrentEvidenceStatus>(
      `/evidence/${encodeURIComponent(evidenceId)}`,
    )
      .then((status) => {
        if (active) setCurrentStatus(status);
      })
      .catch(() => {
        if (active) setFreshnessCheckFailed(true);
      });
    return () => {
      active = false;
    };
  }, [evidenceId, isLegacyCitation]);
  if (!source)
    return (
      <span
        className="citation-unresolved"
        title={`No matching evidence in this saved answer: ${handle}`}
      >
        {original}
      </span>
    );
  const citationSource = source;

  const freshnessStatus = currentStatus?.freshness;
  const returnedPath = currentStatus?.currentPath;
  const currentPathVerified = Boolean(
    returnedPath &&
    !freshnessCheckFailed &&
    ((freshnessStatus === "renamed" && returnedPath !== citationSource.path) ||
      ((freshnessStatus === "current" || freshnessStatus === "legacy") &&
        returnedPath === citationSource.path) ||
      (freshnessStatus === "changed" && returnedPath === citationSource.path)),
  );
  const legacyPath =
    isLegacyCitation && typeof citationSource.path === "string"
      ? citationSource.path
      : undefined;
  const navigationPath =
    legacyPath || (currentPathVerified ? returnedPath : undefined);
  const target = navigationPath
    ? resolveCitationTarget(
        { ...citationSource, path: navigationPath },
        citationContext,
      )
    : undefined;
  const pathUnavailable = Boolean(
    citationSource.path &&
    !isLegacyCitation &&
    (freshnessCheckFailed ||
      freshnessStatus === "ambiguous" ||
      freshnessStatus === "unavailable" ||
      (currentStatus && !navigationPath)),
  );
  const label = citationLabel(citationSource);
  const sourceId = citationSource.sourceId || citationContext?.sourceId;
  const page = Number(citationSource.page);
  const hasPage = Number.isFinite(page) && page > 0;
  const provenance = citationSource.provenance;
  const provenanceLabel =
    typeof provenance === "string"
      ? provenance
      : provenance && typeof provenance === "object"
        ? [
            (provenance as Record<string, unknown>).origin,
            (provenance as Record<string, unknown>).kind,
            (provenance as Record<string, unknown>).author,
            (provenance as Record<string, unknown>).method,
          ]
            .filter((value) => typeof value === "string" && value.trim())
            .join(" · ") || "Recorded source metadata"
        : "Unavailable in this snapshot";
  let freshness = "Revision unavailable (legacy snapshot)";
  if (isLegacyCitation) {
    freshness = legacyPath
      ? "Legacy artifact citation; using its saved path without a current-file check"
      : "Legacy artifact citation; no saved vault path is available";
  } else if (freshnessCheckFailed) {
    freshness =
      "Current file could not be checked; saved excerpt preserved; no Obsidian redirect is available";
  } else if (freshnessStatus === "ambiguous") {
    freshness =
      "Several current files match; no Obsidian redirect is available";
  } else if (freshnessStatus === "unavailable") {
    freshness =
      "Current file is unavailable; saved excerpt preserved; no Obsidian redirect is available";
  } else if (freshnessStatus === "renamed") {
    freshness = currentPathVerified
      ? "Renamed file matches the saved snapshot revision"
      : "Renamed file could not be verified; no Obsidian redirect is available";
  } else if (citationSource.path && !navigationPath) {
    freshness = currentStatus
      ? "No current path was verified; saved excerpt preserved; no Obsidian redirect is available"
      : "Checking the current path; saved excerpt remains available";
  } else if (freshnessStatus === "current") {
    freshness = "Snapshot revision matches the current file";
  } else if (freshnessStatus === "changed") {
    freshness =
      "Current file differs from the saved snapshot; saved excerpt preserved";
  } else if (freshnessStatus === "legacy") {
    freshness = "Legacy snapshot; revision was not recorded";
  } else if (freshnessStatus === "snapshot") {
    freshness = "Source snapshot saved; current file was not checked";
  } else if (citationSource.freshness === "current") {
    freshness = "Revision matched when retrieved";
  } else if (citationSource.freshness === "stale") {
    freshness = "Revision differed when retrieved";
  } else if (citationSource.freshness === "unchecked") {
    freshness = "Revision saved; current file was not checked";
  }

  async function copyCitation() {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable.");
      const exportSource = navigationPath
        ? { ...citationSource, path: navigationPath }
        : { ...citationSource, path: undefined };
      const exportContext = navigationPath
        ? citationContext
        : { sourceId: citationContext?.sourceId };
      const markdown = readableCitationMarkdown(exportSource, exportContext);
      const locatorNote =
        citationSource.path && !navigationPath
          ? ` (saved path: ${citationSource.path}; current path not verified)`
          : "";
      await navigator.clipboard.writeText(`${markdown}${locatorNote}`);
      setCopyStatus("Citation copied.");
    } catch {
      setCopyStatus(
        "Could not copy citation. The saved source preview remains available above.",
      );
    }
  }

  function openSourcePage() {
    if (!sourceId || !hasPage) return;
    onAnchor?.({
      sourceId,
      page,
      quote: citationSource.text,
      section: citationSource.section,
      revision: citationSource.revision || undefined,
    });
  }

  return (
    <span className="citation-wrap">
      <button
        type="button"
        className="citation-trigger"
        aria-expanded={open}
        aria-label={`Show source preview: ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {target && (
        <a
          className="citation-open"
          href={target}
          aria-label={`Open ${citationSource.title} in Obsidian`}
          title="Open in Obsidian"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M6 3H3.75A1.75 1.75 0 0 0 2 4.75v7.5C2 13.216 2.784 14 3.75 14h7.5A1.75 1.75 0 0 0 13 12.25V10" />
            <path d="M8 2h6v6M14 2 7 9" />
          </svg>
        </a>
      )}
      {sourceId && hasPage && onAnchor && (
        <button
          type="button"
          className="citation-open"
          aria-label={`Open ${citationSource.title}, page ${page} in Margin`}
          title={`Open source · p. ${page}`}
          onClick={openSourcePage}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3 2.5h7.5A1.5 1.5 0 0 1 12 4v9.5H4.5A1.5 1.5 0 0 1 3 12z" />
            <path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H12M5.5 5h4M5.5 7.5h4" />
          </svg>
        </button>
      )}
      {open && (
        <span
          className="citation-preview"
          role="group"
          aria-label={`Source preview: ${label}`}
        >
          <span className="citation-preview-heading">
            <strong>{label}</strong>
            <span className="citation-kind">
              {citationSource.kind || "source"}
            </span>
          </span>
          <span className="citation-preview-text">{citationSource.text}</span>
          <span className="citation-preview-meta">
            <span>
              <strong>Provenance:</strong> {provenanceLabel}
            </span>
            <span>
              <strong>Version:</strong>{" "}
              {citationSource.revision
                ? String(citationSource.revision)
                : "unknown legacy revision"}
            </span>
            <span>
              <strong>Freshness:</strong> {freshness}
            </span>
            {typeof citationSource.path === "string" && (
              <>
                <span>
                  <strong>Snapshot path:</strong> {citationSource.path}
                  {citationSource.line ? ` · line ${citationSource.line}` : ""}
                </span>
                {navigationPath && navigationPath !== citationSource.path && (
                  <span>
                    <strong>Current path (verified):</strong> {navigationPath}
                  </span>
                )}
                {pathUnavailable && (
                  <span>
                    <strong>Current path:</strong>{" "}
                    {freshnessCheckFailed
                      ? "not checked"
                      : freshnessStatus === "ambiguous"
                        ? "ambiguous"
                        : freshnessStatus === "unavailable"
                          ? "unavailable"
                          : "not verified"}
                    ; redirect disabled
                  </span>
                )}
              </>
            )}
          </span>
          <span className="citation-preview-actions">
            {target && (
              <a
                href={target}
                aria-label={`Open ${citationSource.title} in Obsidian`}
              >
                Open in Obsidian
              </a>
            )}
            {sourceId && hasPage && onAnchor && (
              <button type="button" onClick={openSourcePage}>
                Open source · p. {page}
              </button>
            )}
            {typeof citationSource.zotero === "string" &&
              citationSource.zotero.startsWith("zotero://") && (
                <a href={citationSource.zotero}>Open in Zotero</a>
              )}
            <button type="button" onClick={() => void copyCitation()}>
              Copy citation
            </button>
            {copyStatus && (
              <span role="status" aria-live="polite">
                {copyStatus}
              </span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
