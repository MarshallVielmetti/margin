export interface KnowledgeAnchor {
  origin: "source" | "note";
  sourceId?: string;
  regionId?: string;
  revision: string;
  page?: number;
  path?: string;
  lineStart?: number;
  authorship?: string;
  text: string;
  box?: [number, number, number, number];
}
export interface KnowledgeCard {
  id: string;
  title: string;
  kind?: string;
  relation?: string;
  markdown: string;
  generation?: string;
  origin: string;
  freshness: string;
  issues?: string[];
  anchors: KnowledgeAnchor[];
  review: {
    state: "proposed" | "accepted" | "rejected" | "corrected";
    correction?: string;
    verification: string;
  };
}
export interface KnowledgeEntry {
  entityId: string;
  title: string;
  type: string;
  description: string;
  freshness: string;
  notePath?: string;
}
export interface KnowledgeSettings {
  enabled: boolean;
  model: string;
  maxUnits: number;
  maxCalls: number;
  maxComparisons: number;
}
export interface KnowledgeView {
  comparisons: KnowledgeCard[];
  comparisonsTruncated: boolean;
  entity: {
    id: string;
    title: string;
    type: string;
    notePath?: string;
    sourceIds: string[];
    availability: string;
  };
  navigation: {
    nodes: { entityId: string; title: string; type: string }[];
    links: { unresolved?: string; status?: string }[];
    truncated: boolean;
  };
  snapshot: null | {
    revisionId: string;
    markdown: string;
    freshness: string;
    origin: string;
    generation: string;
    generationCompletion?: {
      generatedUnits: number;
      failedUnits: number;
      ungeneratedUnits: number;
    };
    overviewCoverage?: {
      unitIds: string[];
      omittedUnits: number;
      maxSourceCharsPerUnit: number;
    };
    coverage: {
      totalPages: number;
      extractedPages: number;
      coveredPages: number[];
      missingPages: number[];
      selectedUnits: number;
      availableUnits: number;
      preparation: string;
      warnings: string[];
    };
    units: KnowledgeCard[];
    connections: KnowledgeCard[];
    issues: string[];
  };
  jobs: {
    id: string;
    status: string;
    message: string;
    done: number;
    total: number;
    modelCalls: number;
  }[];
}
