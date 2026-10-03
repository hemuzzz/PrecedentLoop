export type AssetType = "MEMORY" | "DOCUMENT" | "SKILL";
export type AssetScope = "GLOBAL" | "WORKSPACE";
export type SearchStrategy = "FTS" | "HYBRID" | "LITERAL";

export interface AssetLibraryItem {
  assetId: string;
  knowledgeNumber: number | null;
  version: number;
  matchedSnippet?: string;
  updatedAt: string;
  scope: AssetScope;
  score?: number;
  searchStrategy?: SearchStrategy;
  summary: string;
  retrievalTerms: string[];
  title: string;
  type: AssetType;
  workspace: string | null;
}

export interface AssetUsageSummary { readCount: number; recallCount: number; totalUsedCount: number }
export type { RecallProjection, ItemProjection, UsageProjection } from "../../../server/src/knowledge/projection.js";
import type { ItemProjection, UsageProjection, KnowledgeProjection } from "../../../server/src/knowledge/projection.js";
export type WorkspaceProjection = Awaited<ReturnType<KnowledgeProjection["workspaces"]>>;
export type RecallDetail = NonNullable<Awaited<ReturnType<KnowledgeProjection["recall"]>>>;

export interface AssetDetail extends AssetLibraryItem {
  bodyMarkdown: string;
  recentRecalls: Omit<ItemProjection, "assetTitle">[];
  recentUsage: UsageProjection[];
  usageSummary: AssetUsageSummary;
}

export interface InboxItem {
  knowledgeNumber: number | null;
  candidateId: string;
  number: number;
  intent?: "NEW" | "REVISION";
  status: "PENDING" | "DEFERRED";
  baseVersion: number | null;
  baselineMarkdown?: string;
  currentFormalVersion?: number;
  assetId: string;
  version: number;
  updatedAt: string;
  bodyMarkdown: string;
  scope: AssetScope;
  summary: string;
  retrievalTerms: string[];
  title: string;
  type: AssetType;
  workspace: string | null;
}

export interface InboxResult {
  managed?: boolean;
  items: InboxItem[];
}

export interface AiOperation {
  requestId: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "NOT_COMMITTED";
  operation?: string;
  result?: { count?: number; changed?: boolean; candidateId?: string; warnings?: string[]; sourceResults?: Array<{ name: string; explanation: string }> };
  error?: { code: string; message: string };
}
export interface AiProvider { id: "codex" | "claude"; available: boolean; reason?: string; isDefault?: boolean }
export type { AiConfiguration, AiOverrides } from "../../../server/src/ai/cli.js";
export type { AiTestResult } from "../../../server/src/ai/service.js";

export interface AssetListFilters {
  limit?: 20 | 50 | 100;
  offset?: number;
  query?: string;
  scope?: AssetScope;
  type?: AssetType;
  workspace?: string | null;
}

export interface AssetListResult {
  items: AssetLibraryItem[];
  total: number;
  offset: number;
  limit: number;
}

export type { SystemReadiness, SystemStatusDto as SystemStatus } from "../../../server/src/http/service.js";

export type { OverviewDto } from "../../../server/src/http/overview.js";
