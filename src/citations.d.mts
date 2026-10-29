export interface CitationEvidence {
  id: string;
  title: string;
  text: string;
  kind?: string;
  sourceId?: string;
  path?: string;
  page?: number;
  line?: number;
  section?: string;
  revision?: string | null;
  locator?: Record<string, unknown>;
  provenance?: unknown;
  handles?: string[];
  handle?: string;
  promptHandle?: string;
  label?: string;
  aliases?: string[];
  freshness?: "current" | "stale" | "unchecked" | "unknown" | string;
  legacySnapshot?: boolean;
  headingOccurrence?: number;
  blockId?: string;
  zotero?: string;
  [key: string]: unknown;
}

export interface CitationContext {
  vaultRoot: string;
  vaultId?: string;
  bridge?: boolean;
  sourceId?: string;
}

export function evidenceAliases(evidence: CitationEvidence): string[];
export function resolveEvidenceHandle(
  evidence: CitationEvidence[],
  handle: string,
): CitationEvidence | undefined;
export function citationLabel(evidence: CitationEvidence): string;
export function resolveCitationTarget(
  evidence: CitationEvidence,
  context?: Partial<CitationContext>,
): string | undefined;
export function readableCitationMarkdown(
  evidence: CitationEvidence,
  context?: Partial<CitationContext>,
): string;
export function remarkCitations(options?: {
  evidence?: CitationEvidence[];
}): (tree: unknown) => void;
export function exportReadableMarkdown(
  text: string,
  evidence: CitationEvidence[],
  context?: Partial<CitationContext>,
): string;
