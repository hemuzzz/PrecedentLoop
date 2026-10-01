import { isAbsolute, relative, resolve, win32 } from "node:path";

import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";

import type { AssetDiffService } from "../asset/content-diff.js";
import {
  AssetSearchService,
  InboxApplicationService,
  scanAssetRepository,
  type AssetIndexStatus,
  type AssetLibraryListQuery,
  type AssetLibraryListResult,
  type AssetScanOptions,
  type IndexDiagnostic,
} from "../asset/index.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { KnowledgeProjection, ItemProjection, UsageProjection } from "../knowledge/projection.js";

const SERVICE_NAME = "precedent";
const SERVICE_VERSION = "0.0.0";

export interface AssetDetailDto {
  assetId: string;
  contentHash: string;
  frontmatter: Awaited<ReturnType<AssetSearchService["readLibrary"]>>["frontmatter"];
  modifiedAt: string;
  rawMarkdown: string;
  recentRecalls: Omit<ItemProjection, "assetTitle">[];
  recentUsage: UsageProjection[];
  relativePath: string;
  renderedMarkdown: string;
  scope: Awaited<ReturnType<AssetSearchService["readLibrary"]>>["frontmatter"]["scope"];
  summary: string;
  title: string;
  type: Awaited<ReturnType<AssetSearchService["readLibrary"]>>["frontmatter"]["type"];
  usageSummary: ReturnType<KnowledgeRepository["summarizeByAsset"]>;
  workspace: string | null;
}

export class HubAssetApplicationService {
  readonly #renderer = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(markdownItCjkFriendly);

  constructor(
    readonly assetSearchService: Pick<AssetSearchService, "listLibrary" | "readLibrary">,
    readonly projection: KnowledgeProjection,
    readonly usageService: Pick<KnowledgeRepository, "summarizeByAsset">,
    readonly diffService?: AssetDiffService,
  ) {}

  async diff(assetId: string) {
    if (!this.diffService) throw new Error("Content version service is unavailable");
    return this.diffService.get(assetId);
  }

  list(query: AssetLibraryListQuery): Promise<AssetLibraryListResult> {
    return this.assetSearchService.listLibrary(query);
  }

  async get(assetId: string): Promise<AssetDetailDto> {
    const asset = await this.assetSearchService.readLibrary(assetId);
    return {
      assetId: asset.frontmatter.id,
      contentHash: asset.contentHash,
      frontmatter: asset.frontmatter,
      modifiedAt: asset.modifiedAt,
      rawMarkdown: asset.markdown,
      recentRecalls: this.projection.items("i.asset_id=?", assetId),
      recentUsage: (await this.projection.usage(0, 20, assetId)).items,
      relativePath: asset.relativePath,
      renderedMarkdown: this.#renderer.render(asset.bodyMarkdown),
      scope: asset.frontmatter.scope,
      summary: asset.frontmatter.summary,
      title: asset.frontmatter.title,
      type: asset.frontmatter.type,
      usageSummary: this.usageService.summarizeByAsset(assetId),
      workspace: asset.frontmatter.scope === "WORKSPACE" ? asset.frontmatter.workspace : null,
    };
  }
}

export type SystemReadiness = "READY" | "DEGRADED" | "REBUILD_REQUIRED";

export interface StatusDiagnosticDto {
  code: string;
  message: string;
  occurredAt?: string;
  relativePath?: string;
  source: "INBOX" | "INDEX" | "SCANNER" | "WATCHER" | "WORKSPACE";
}

export interface SystemStatusDto {
  buildId?: string;
  diagnostics: StatusDiagnosticDto[];
  index: {
    catalogCount: number | null;
    ftsCount: number | null;
    indexState: SystemReadiness;
    lastSuccessfulScanAt: string | null;
    rebuildRequired: boolean;
    watcherState: AssetIndexStatus["watcherState"];
  };
  mcpEndpoint: {
    path: "/mcp";
    ready: boolean;
  };
  repository: {
    assetRepositoryPath: string;
    formalAssetCount: number | null;
    inboxAssetCount: number | null;
  };
  service: {
    name: typeof SERVICE_NAME;
    readiness: SystemReadiness;
    uptimeSeconds: number;
    version: typeof SERVICE_VERSION;
  };
}

export interface SystemStatusDependencies extends AssetScanOptions {
  buildId?: string;
  indexStatus: () => AssetIndexStatus;
  inboxService: Pick<InboxApplicationService, "scan">;
  mcpEndpointReady: () => boolean;
  uptimeSeconds?: () => number;
}

export class SystemStatusApplicationService {
  readonly #uptimeSeconds: () => number;

  constructor(readonly dependencies: SystemStatusDependencies) {
    this.#uptimeSeconds = dependencies.uptimeSeconds ?? (() => process.uptime());
  }

  async get(): Promise<SystemStatusDto> {
    const diagnostics: StatusDiagnosticDto[] = [];
    let indexStatus: AssetIndexStatus;
    try {
      indexStatus = this.dependencies.indexStatus();
      diagnostics.push(
        ...indexStatus.diagnostics.map((item) => this.#safeIndexDiagnostic(item)),
      );
    } catch {
      indexStatus = {
        catalogCount: null,
        diagnostics: [],
        ftsCount: null,
        indexState: "NOT_READY",
        lastSuccessfulScanAt: null,
        rebuildRequired: false,
        watcherState: "NOT_STARTED",
      };
      diagnostics.push({
        code: "INDEX_STATUS_UNAVAILABLE",
        message: "Index status could not be calculated",
        source: "INDEX",
      });
    }

    let formalAssetCount: number | null = null;
    let formalScanReady = false;
    try {
      const scan = await scanAssetRepository(this.dependencies);
      formalScanReady = scan.isComplete;
      formalAssetCount = scan.isComplete ? scan.assets.length : null;
      diagnostics.push(
        ...scan.diagnostics.map((item) => ({
          code: item.code,
          message: redactPaths(item.message, this.dependencies),
          relativePath: safeRelativePath(item.path, this.dependencies),
          source: item.code === "INVALID_WORKSPACE_CONFIG" ? "WORKSPACE" as const : "SCANNER" as const,
        })),
      );
    } catch {
      diagnostics.push({
        code: "FORMAL_ASSET_SCAN_UNAVAILABLE",
        message: "Formal Assets could not be scanned",
        source: "SCANNER",
      });
    }

    let inboxAssetCount: number | null = null;
    let inboxScanReady = false;
    try {
      const inbox = await this.dependencies.inboxService.scan();
      inboxAssetCount = inbox.items.length;
      inboxScanReady = true;
      diagnostics.push(
        ...inbox.diagnostics.map((item) => ({
          code: item.code,
          message: redactPaths(item.message, this.dependencies),
          relativePath: item.relativePath,
          source: item.code === "UNKNOWN_WORKSPACE" ? "WORKSPACE" as const : "INBOX" as const,
        })),
      );
    } catch {
      diagnostics.push({
        code: "INBOX_SCAN_UNAVAILABLE",
        message: "Inbox could not be scanned completely",
        source: "INBOX",
      });
    }

    const indexState = normalizedIndexState(indexStatus.indexState);
    const readiness: SystemReadiness = indexState === "REBUILD_REQUIRED"
      ? "REBUILD_REQUIRED"
      : indexState === "READY" && indexStatus.watcherState === "RUNNING" && formalScanReady && inboxScanReady
        ? "READY"
        : "DEGRADED";
    return {
      ...(this.dependencies.buildId === undefined ? {} : { buildId: this.dependencies.buildId }),
      service: {
        name: SERVICE_NAME,
        readiness,
        uptimeSeconds: Math.max(0, this.#uptimeSeconds()),
        version: SERVICE_VERSION,
      },
      repository: {
        assetRepositoryPath: resolve(this.dependencies.repositoryPath),
        formalAssetCount,
        inboxAssetCount,
      },
      index: {
        catalogCount: indexStatus.catalogCount,
        ftsCount: indexStatus.ftsCount,
        indexState,
        lastSuccessfulScanAt: indexStatus.lastSuccessfulScanAt,
        rebuildRequired: indexState === "REBUILD_REQUIRED",
        watcherState: indexStatus.watcherState,
      },
      mcpEndpoint: {
        path: "/mcp",
        ready: this.dependencies.mcpEndpointReady(),
      },
      diagnostics: diagnostics.sort(compareStatusDiagnostics),
    };
  }

  #safeIndexDiagnostic(item: IndexDiagnostic): StatusDiagnosticDto {
    return {
      code: item.code,
      message: redactPaths(item.message, this.dependencies),
      occurredAt: item.occurredAt,
      ...(item.path === undefined ? {} : { relativePath: safeRelativePath(item.path, this.dependencies) }),
      source: item.code === "INVALID_WORKSPACE_CONFIG"
        ? "WORKSPACE"
        : item.source === "WATCHER"
          ? "WATCHER"
          : item.source,
    };
  }
}

function normalizedIndexState(state: AssetIndexStatus["indexState"]): SystemReadiness {
  return state === "REBUILD_REQUIRED" ? "REBUILD_REQUIRED" : state === "READY" ? "READY" : "DEGRADED";
}

function safeRelativePath(path: string, options: AssetScanOptions): string {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    return path;
  }
  const fromRepository = relative(resolve(options.repositoryPath), resolve(path));
  if (fromRepository !== "" && !fromRepository.startsWith("..") && !isAbsolute(fromRepository)) {
    return fromRepository.replaceAll("\\", "/");
  }
  return "<redacted-path>";
}

function redactPaths(message: string, options: AssetScanOptions): string {
  const configured = [resolve(options.repositoryPath), resolve(options.workspaceConfigPath)];
  let safe = message;
  for (const path of configured) {
    safe = safe.replaceAll(path, path === configured[0] ? "<asset-repository>" : "<workspace-config>");
  }
  return safe.replace(/(^|[\s('"`])(?:[A-Za-z]:[\\/]|\/)[^\s)'"`,;]*/gu, "$1<redacted-path>");
}

function compareStatusDiagnostics(left: StatusDiagnosticDto, right: StatusDiagnosticDto): number {
  return left.source.localeCompare(right.source) ||
    (left.relativePath ?? "").localeCompare(right.relativePath ?? "") ||
    left.code.localeCompare(right.code);
}
