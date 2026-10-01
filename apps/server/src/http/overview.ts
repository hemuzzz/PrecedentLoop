import { AssetSearchUnavailableError, scanAssetRepository, type AssetScanOptions, type InboxApplicationService } from "../asset/index.js";
import type { KnowledgeProjection } from "../knowledge/projection.js";
import { loadWorkspaceConfig } from "../asset/scanner.js";
import { readKnowledgeNumbers } from "../asset/knowledge-number.js";
export interface OverviewItem {
  assetId: string; title: string; type: "MEMORY" | "DOCUMENT" | "SKILL"; pending: boolean;
  knowledgeNumber: number | null; candidateId?: string | null;
}
export interface OverviewDto {
  scopes: { workspace: string | null; assets: { MEMORY: number; DOCUMENT: number; SKILL: number }; inboxCount: number; items: OverviewItem[] }[];
  facts: { recallOperations: number; recallItems: number; reads: number; used: number };
  generatedAt: string; diagnosticCount: number;
}
export class OverviewApplicationService {
  constructor(readonly dependencies: AssetScanOptions & {
    inboxService: Pick<InboxApplicationService, "scan">;
    projection: Pick<KnowledgeProjection, "totals" | "repository">;
  }) {}
  async get(): Promise<OverviewDto> {
    const config = this.dependencies.workspaceConfigSnapshot ?? await loadWorkspaceConfig(this.dependencies.workspaceConfigPath).catch(() => { throw new AssetSearchUnavailableError("ASSET_QUALIFICATION"); });
    const [scan, inbox] = await Promise.all([scanAssetRepository({ ...this.dependencies, workspaceConfigSnapshot: config }), this.dependencies.inboxService.scan()]);
    if (!scan.isComplete) throw new AssetSearchUnavailableError("ASSET_QUALIFICATION");
    const numbers = readKnowledgeNumbers(this.dependencies.projection.repository.db);
    const scopes = new Map<string | null, OverviewDto["scopes"][number]>();
    const scope = (workspace: string | null) => {
      let result = scopes.get(workspace);
      if (!result) { result = { workspace, assets: { MEMORY: 0, DOCUMENT: 0, SKILL: 0 }, inboxCount: 0, items: [] }; scopes.set(workspace, result); }
      return result;
    };
    scope(null);
    for (const workspace of config.workspaces) scope(workspace.name);
    for (const { frontmatter } of scan.assets) {
      const entry = scope(frontmatter.scope === "GLOBAL" ? null : frontmatter.workspace);
      entry.assets[frontmatter.type]++;
      entry.items.push({ assetId: frontmatter.id, title: frontmatter.title, type: frontmatter.type, pending: false, knowledgeNumber: numbers.get(frontmatter.id) ?? null });
    }
    for (const item of inbox.items) {
      const entry = scope(item.workspace);
      entry.inboxCount++;
      entry.items.push({ assetId: item.assetId, title: item.title, type: item.type, pending: true, candidateId: item.candidateId ?? null, knowledgeNumber: null });
    }
    for (const entry of scopes.values()) entry.items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN") || a.assetId.localeCompare(b.assetId));
    return { scopes: [...scopes.values()].sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? "")),
      facts: this.dependencies.projection.totals(), generatedAt: new Date().toISOString(), diagnosticCount: scan.diagnostics.length + inbox.diagnostics.length };
  }
}
