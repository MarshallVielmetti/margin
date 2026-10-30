export type View =
  "desk" | "library" | "vault" | "history" | "promotions" | "settings";
export interface Anchor {
  sourceId: string;
  scope?: "page" | "paper";
  regions?: RegionAnchor[];
  page: number;
  quote: string;
  section?: string;
  regionId?: string;
  revision?: string;
  box?: [number, number, number, number];
}
export interface RegionAnchor {
  regionId: string;
  page: number;
  quote: string;
  section?: string;
  revision?: string;
  box?: [number, number, number, number];
}
export interface Workspace {
  id: string;
  title: string;
  question: string;
}
export interface Source {
  id: string;
  title: string;
  authors: string;
  year?: number;
  kind: "pdf" | "reading-note" | "source-excerpt";
  pages?: string[];
  pageCount: number;
  hasFile: boolean;
  notePath?: string;
  zotero?: string;
}
export interface Artifact {
  id: string;
  sessionId: string;
  text: string;
  kind: string;
  origin: "user" | "ai" | "prompt" | "tool";
  revision?: number;
  surface?: "thoughts" | "tutor";
  selectedText?: string;
  anchor?: Anchor;
  assumptions?: string;
  status: string;
  createdAt: string;
  model?: string;
  provider?: string;
  cloud?: boolean;
  referenceResults?: {
    label: string;
    status: string;
    page?: number;
    pages?: number[];
    text?: string;
    candidates?: { text: string; page: number }[];
    extractionStatus?: string;
    reason?: string;
    metadataMatch?: { status: string; title?: string; matchedBy?: string };
  }[];
  runId?: string;
  runStatus?: string;
  partial?: boolean;
  routing?: { model: string; reason: string; fallback: boolean };
  retrievalWarning?: string;
  evidence?: {
    id: string;
    title: string;
    page?: number;
    path?: string;
    line?: number;
    text: string;
    sourceId?: string;
    kind?: string;
    section?: string;
    revision?: string;
    locator?: Record<string, unknown>;
    provenance?: { origin?: string; status?: string; method?: string };
    handles?: string[];
    loadedInPrompt?: boolean;
    state?: string;
  }[];
}
export interface Session {
  id: string;
  workspaceId: string;
  sourceId: string;
  title: string;
  page: number;
  status: string;
  takeaway: string;
  nextStep?: string;
  revisitAt?: string;
  artifacts?: Artifact[];
  updatedAt: string;
  createdAt: string;
}
export interface Note {
  path: string;
  title: string;
  type: string;
  summary?: string;
  excerpt?: string;
  section?: string;
  line?: number;
  reason?: string;
  content?: string;
  body?: string;
  aliases?: string[];
  headings?: { title: string; line: number; level: number }[];
  backlinks?: { path: string; title: string; section: string; line: number }[];
}
export interface Promotion {
  origin?: string;
  evidenceIds?: string[];
  assumptions?: string[];
  rationale?: string;
  id: string;
  sessionId: string;
  path: string;
  mode: string;
  text: string;
  status: string;
  before?: string;
  after?: string;
  heading?: string;
  appliedAt?: string;
  createdAt: string;
}
export interface Relationship {
  id: string;
  sessionId: string;
  notePath: string;
  relation: string;
  evidence: string;
  status: string;
}
export interface Config {
  synthesis: {
    provider: "ollama" | "openai";
    model: string;
    cloud: boolean;
    available: boolean;
  };
  vaultId?: string;
  features?: {
    agentHarness: boolean;
    citations: boolean;
    sourceExpansion: boolean;
  };
  vault: {
    root: string;
    count: number;
    links: number;
    types: Record<string, number>;
    warnings: string[];
    indexedAt: string | null;
  };
  provider: "ollama" | "openai";
  cloud: boolean;
  localModel: string;
  openaiConfigured: boolean;
  chatModels: { name: string; provider: "ollama" | "openai"; cloud: boolean }[];
  cloudModelError: string;
  models: {
    name: string;
    size: number;
    capabilities: string[];
    cloud: boolean;
  }[];
  modelError: string;
  embeddingModel: string;
  semantic: {
    running: boolean;
    done: number;
    total: number;
    cached: number;
    error: string;
    stale: boolean;
  };
  zoteroDir: string;
  linkedDir: string;
  aiConfigured: boolean;
  aiEnabled: boolean;
  model: string;
  bridge: boolean;
  port: number;
  dataDir: string;
}
export interface Bootstrap {
  token: string;
  config: Config;
  workspaces: Workspace[];
  sources: Source[];
  sessions: Session[];
  promotions: Promotion[];
  relationships: Relationship[];
}

export interface Region {
  id: string;
  sourceId: string;
  page: number;
  kind: string;
  text: string;
  box: [number, number, number, number];
  parentId: string | null;
  order: number;
  origin: string;
  role?: "equation-line" | "equation-block";
  lineCount?: number;
  revision?: string;
  latex?: string;
  heuristic?: boolean;
}
export interface DocumentLayout {
  sourceId: string;
  revision: string;
  extractor: string;
  regions: Region[];
  warnings: string[];
}
export interface IntakeJob {
  id: string;
  sourceId: string;
  status: string;
  done: number;
  total: number;
  errors: number;
  message: string;
  model: string;
  extractor: string;
}
export interface ChunkContext {
  id: string;
  regionId: string;
  status: string;
  stale: boolean;
  model: string | null;
  error?: string;
  createdAt: string;
  notes: {
    path: string;
    title: string;
    section?: string;
    line?: number;
    excerpt: string;
    reason: string;
  }[];
  candidates: {
    regionId: string;
    page: number;
    kind: string;
    text: string;
    reason: string;
  }[];
  analysis: null | {
    summary: string;
    concepts: string[];
    assumptions: string[];
    questions: string[];
    noteLinks: {
      path: string;
      reason: string;
      sourceQuote: string;
      targetQuote: string;
    }[];
    connections: {
      regionId: string;
      relation: string;
      reason: string;
      sourceQuote: string;
      targetQuote: string;
    }[];
  };
}

export type NotebookMode = "thoughts" | "tutor" | "synthesis";
export interface NotebookDraft {
  text: string;
  anchor?: Anchor | null;
  start: number;
  end: number;
  scroll: number;
  interim: string;
}
export interface NotebookState {
  schemaVersion: 1;
  mode: NotebookMode;
  thoughts: NotebookDraft;
  tutor: NotebookDraft;
  activeThread: string;
  synthesis: { start: number; end: number; scroll: number };
  tabCycles: boolean;
  updatedAt?: string;
}
export interface DocumentBlock {
  id: string;
  start: number;
  end: number;
  text: string;
  section: string;
}
export interface LiteratureDocument {
  id: string;
  title: string;
  vaultId: string;
  notePath: string;
  sourceIds: string[];
  markdown: string;
  revision: number;
  syncedRevision: number;
  syncedHash: string | null;
  syncEnabled: boolean;
  syncMethod: "bridge" | "closed-note";
  syncStatus: "local" | "synced" | "offline" | "conflict";
  syncError?: string;
  organizeAsRead: boolean;
  organizationModel: string;
  legacyOffered: boolean;
  conflict: {
    text: string;
    external: string;
    externalHash: string;
    conflicts: {
      start: number;
      end: number;
      base: string;
      local: string;
      remote: string;
    }[];
  } | null;
}
export interface DocumentRevision {
  id: string;
  revision: number;
  parentRevision: number | null;
  before: string;
  markdown: string;
  createdAt: string;
  attribution: {
    origin: string;
    acceptedBy?: string;
    verified?: boolean;
    suggestionId?: string;
  };
}
export interface SynthesisSuggestion {
  id: string;
  baseRevision: number;
  target: DocumentBlock;
  text: string;
  operation: "replace" | "insert_after";
  artifactRevisionIds: string[];
  evidenceIds: string[];
  rationale: string;
  inputs: Artifact[];
  inspectedEvidence: NonNullable<Artifact["evidence"]>;
  status: "pending" | "accepted" | "dismissed" | "stale";
  selection: { model: string; provider: string; cloud: boolean };
}
export interface SynthesisRun {
  id: string;
  status: string;
  error?: string;
  selection: { model: string; provider: string; cloud: boolean };
}
export interface DocumentView {
  schemaVersion: 1;
  document: LiteratureDocument;
  blocks: DocumentBlock[];
  suggestions: SynthesisSuggestion[];
  pending: (Artifact & { artifactRevisionId: string })[];
  revisions: DocumentRevision[];
  run: SynthesisRun | null;
}
