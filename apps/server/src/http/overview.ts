import type { CandidateService } from "../asset/candidate-service.js";
import { CandidateRepository } from "../asset/candidate-repository.js";
import { IssueRepository } from "../asset/issue-repository.js";
import type { KnowledgeProjection } from "../knowledge/projection.js";
import { loadWorkspaceConfig } from "../workspace/config.js";
export interface OverviewItem {
  assetId: string; title: string; type: "MEMORY" | "DOCUMENT" | "SKILL"; pending: boolean;
  knowledgeNumber: number | null; candidateId?: string | null; number?: number;
}
export interface OverviewDto {
  scopes: { workspace: string | null; assets: { MEMORY: number; DOCUMENT: number; SKILL: number }; inboxCount: number; items: OverviewItem[] }[];
  facts: { recallOperations: number; recallItems: number; reads: number; used: number };
  generatedAt: string; diagnosticCount: number;
}
export class OverviewApplicationService {
  constructor(readonly dependencies: { workspaceConfigPath: string; candidateService: CandidateService; projection: KnowledgeProjection }) {}
  async get(): Promise<OverviewDto> {
    const config = await loadWorkspaceConfig(this.dependencies.workspaceConfigPath);
    return this.dependencies.projection.repository.readTransaction(repository => {
    const workspaces = config.workspaces.map(workspace => workspace.name);
    const assets = repository.list(workspaces);
    const inbox = new CandidateRepository(this.dependencies.projection.repository.db).list()
      .filter(item => item.scope === "GLOBAL" || workspaces.includes(item.workspace!));
    const scopes = new Map<string | null, OverviewDto["scopes"][number]>();
    const scope = (workspace: string | null) => {
      let result = scopes.get(workspace);
      if (!result) { result = { workspace, assets: { MEMORY: 0, DOCUMENT: 0, SKILL: 0 }, inboxCount: 0, items: [] }; scopes.set(workspace, result); }
      return result;
    };
    scope(null);
    for (const workspace of config.workspaces) scope(workspace.name);
    for (const asset of assets) {
      const entry = scope(asset.workspace);
      entry.assets[asset.type]++;
      entry.items.push({ assetId: asset.assetId, title: asset.title, type: asset.type, pending: false, knowledgeNumber: asset.knowledgeNumber });
    }
    for (const item of inbox) {
      const entry = scope(item.workspace);
      entry.inboxCount++;
      entry.items.push({ assetId: item.assetId, title: item.title, type: item.type, pending: true, candidateId: item.candidateId, number: item.number, knowledgeNumber: null });
    }
    for (const card of new IssueRepository(this.dependencies.projection.repository.db).cards()) {
      if (card.scope !== "GLOBAL" && !workspaces.includes(card.workspace!)) continue;
      if (!inbox.some(item => item.assetId === card.assetId)) scope(card.workspace).inboxCount++;
    }
    for (const entry of scopes.values()) entry.items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN") || a.assetId.localeCompare(b.assetId));
    return { scopes: [...scopes.values()].sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? "")),
      facts: this.dependencies.projection.totals(), generatedAt: new Date().toISOString(), diagnosticCount: 0 };
    });
  }
}
