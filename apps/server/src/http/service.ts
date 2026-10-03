import type { AssetDiffService } from "../asset/content-diff.js";
import type { AssetSearchService, AssetLibraryListQuery } from "../asset/search.js";
import { AssetNotFoundError } from "../asset/search.js";
import type { CandidateService } from "../asset/candidate-service.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { KnowledgeProjection } from "../knowledge/projection.js";
import { loadWorkspaceConfig } from "../workspace/config.js";

export class HubAssetApplicationService {
  constructor(readonly assetSearchService: Pick<AssetSearchService, "listLibrary" | "readLibrary">,
    readonly projection: KnowledgeProjection, readonly usageService: Pick<KnowledgeRepository, "summarizeByAsset">,
    readonly diffService?: AssetDiffService) {}
  async diff(assetId: string) { if (!this.diffService) throw new Error("Diff unavailable"); return this.diffService.get(assetId); }
  list(query: AssetLibraryListQuery) { return this.assetSearchService.listLibrary(query); }
  async get(assetId: string) {
    const asset = await this.projection.assetDetail(assetId);
    if (!asset) throw new AssetNotFoundError(assetId);
    return asset;
  }
}
export type AssetDetailDto = Awaited<ReturnType<HubAssetApplicationService["get"]>>;
export type SystemReadiness = "READY" | "DEGRADED";
export interface StatusDiagnosticDto { code: string; message: string; source: "DATABASE" | "WORKSPACE" }
export interface SystemStatusDto {
  buildId?: string; diagnostics: StatusDiagnosticDto[];
  storage: { formalAssetCount: number | null; inboxAssetCount: number | null };
  mcpEndpoint: { path: "/mcp"; ready: boolean };
  service: { name: "precedent"; readiness: SystemReadiness; uptimeSeconds: number; version: string };
}
export interface SystemStatusDependencies {
  buildId?: string; workspaceConfigPath: string; candidateService: CandidateService;
  mcpEndpointReady: () => boolean; uptimeSeconds?: () => number;
}
export class SystemStatusApplicationService {
  constructor(readonly dependencies: SystemStatusDependencies) {}
  async get(): Promise<SystemStatusDto> {
    let formalAssetCount: number | null = null, inboxAssetCount: number | null = null;
    const diagnostics: StatusDiagnosticDto[] = [];
    try {
      const workspaces = (await loadWorkspaceConfig(this.dependencies.workspaceConfigPath)).workspaces.map(workspace => workspace.name);
      const counts = this.dependencies.candidateService.read((candidates, assets) => ({
        assets: assets.list(workspaces).length, candidates: candidates.list().filter(row => row.scope === "GLOBAL" || workspaces.includes(row.workspace!)).length,
      }));
      formalAssetCount = counts.assets; inboxAssetCount = counts.candidates;
    } catch { diagnostics.push({ code: "STORAGE_UNAVAILABLE", message: "无法读取知识或工作区配置", source: "DATABASE" }); }
    return { ...(this.dependencies.buildId ? { buildId: this.dependencies.buildId } : {}),
      service: { name: "precedent", readiness: diagnostics.length ? "DEGRADED" : "READY",
        uptimeSeconds: Math.max(0, this.dependencies.uptimeSeconds?.() ?? process.uptime()), version: "0.0.0" },
      storage: { formalAssetCount, inboxAssetCount },
      mcpEndpoint: { path: "/mcp", ready: this.dependencies.mcpEndpointReady() }, diagnostics };
  }
}
