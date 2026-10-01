import type { KnowledgeRepository } from "./repository.js";
import type { RecallResult, Source } from "./model.js";
import type { WorkspaceCapabilityService } from "../workspace/capability.js";
import { scanAssetRepository, type AssetScanOptions } from "../asset/index.js";
export interface RecallProjection {
  recallId: string; authorizedWorkspaces: string[]; queries: string[];
  occurredAt: string; diagnostics: string[]; budget: RecallResult["budget"];
}
export interface ItemProjection extends Source { recallItemId: string;
  deliveredMode: string; deliveryReasons: string[]; readCount: number; totalUsedCount: number }
export interface UsageProjection extends Source { id: string; kind: "READ" | "USED"; authorizedWorkspaces: string[];
  occurredAt: string; recallItemId: string | null; readRef: string | null; assetTitle: string | null }
export class KnowledgeProjection {
  constructor(readonly repository: KnowledgeRepository, readonly capabilities: WorkspaceCapabilityService,
    readonly scanOptions: AssetScanOptions) {}
  recalls(offset = 0, limit = 50) {
    const rows = this.repository.db.prepare<[number, number], { recallId: string; scopes: string; queriesJson: string;
      occurredAt: string; diagnostics: string; budget: string }>(`SELECT recall_id AS recallId,
      authorized_workspaces_json AS scopes, queries_json AS queriesJson,
      occurred_at AS occurredAt, diagnostics_json AS diagnostics, budget_json AS budget FROM recall_operation
      ORDER BY occurred_at DESC, recall_id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const items: RecallProjection[] = rows.map(({ queriesJson, ...r }) => ({ ...r, queries: JSON.parse(queriesJson) as string[], authorizedWorkspaces: JSON.parse(r.scopes) as string[],
      diagnostics: JSON.parse(r.diagnostics) as string[], budget: JSON.parse(r.budget) as RecallResult["budget"] }));
    return { items, total: this.count("recall_operation") };
  }
  recall(id: string) {
    const row = this.repository.db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM recall_operation WHERE recall_id=?").get(id);
    if (!row?.n) return null;
    const { queriesJson, ...raw } = this.repository.db.prepare<[string], { recallId: string; scopes: string; queriesJson: string;
      occurredAt: string; diagnostics: string; budget: string }>(`SELECT recall_id AS recallId,
      authorized_workspaces_json AS scopes, queries_json AS queriesJson,
      occurred_at AS occurredAt, diagnostics_json AS diagnostics, budget_json AS budget FROM recall_operation WHERE recall_id=?`).get(id)!;
    const operation: RecallProjection = { ...raw, queries: JSON.parse(queriesJson) as string[], authorizedWorkspaces: JSON.parse(raw.scopes) as string[],
      diagnostics: JSON.parse(raw.diagnostics) as string[], budget: JSON.parse(raw.budget) as RecallResult["budget"] };
    return { operation, items: this.items("i.recall_id=?", id) };
  }
  items(condition: "i.recall_id=?" | "i.asset_id=?", id: string): ItemProjection[] {
    const rows = this.repository.db.prepare<[string], Omit<ItemProjection, "deliveryReasons"> & { delivery: string }>(`SELECT
      i.recall_item_id AS recallItemId, i.asset_id AS assetId, i.content_hash AS contentHash, i.asset_scope AS assetScope,
      i.asset_workspace AS assetWorkspace,
      i.delivered_mode AS deliveredMode, i.delivery_reasons_json AS delivery,
      (SELECT count(*) FROM read_operation r WHERE r.recall_item_id=i.recall_item_id) AS readCount,
      (SELECT count(*) FROM used_event u WHERE u.recall_item_id=i.recall_item_id) AS totalUsedCount
      FROM recall_item i WHERE ${condition} ORDER BY ${condition === "i.recall_id=?" ? "i.ordinal ASC" : "i.rowid DESC"} LIMIT 100`).all(id);
    return rows.map((r) => ({ ...r, deliveryReasons: JSON.parse(r.delivery) as string[] }));
  }
  async usage(offset = 0, limit = 50, assetId?: string) {
    const sql = `SELECT r.read_ref AS id, 'READ' AS kind, r.authorized_workspaces_json AS scopes, r.asset_id AS assetId,
      r.content_hash AS contentHash, r.asset_scope AS assetScope, r.asset_workspace AS assetWorkspace,
      r.occurred_at AS occurredAt, r.recall_item_id AS recallItemId, r.read_ref AS readRef FROM read_operation r
      UNION ALL SELECT u.used_id, 'USED', u.authorized_workspaces_json, u.asset_id,
      coalesce(i.content_hash,r.content_hash), coalesce(i.asset_scope,r.asset_scope), coalesce(i.asset_workspace,r.asset_workspace),
      u.occurred_at,u.recall_item_id,u.direct_read_ref FROM used_event u LEFT JOIN recall_item i ON i.recall_item_id=u.recall_item_id
      LEFT JOIN read_operation r ON r.read_ref=u.direct_read_ref`;
    const filter = assetId ? " WHERE assetId=?" : "";
    const rows = this.repository.db.prepare<unknown[], Omit<UsageProjection, "authorizedWorkspaces" | "assetTitle"> & { scopes: string }>(
      `SELECT * FROM (${sql})${filter} ORDER BY occurredAt DESC,id DESC LIMIT ? OFFSET ?`).all(...(assetId ? [assetId] : []), limit, offset);
    const total = this.repository.db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM (${sql})${filter}`).get(...(assetId ? [assetId] : []))!.n;
    const titles = new Map<string, string>();
    if (rows.length) {
      const scan = await scanAssetRepository(this.scanOptions);
      if (!scan.isComplete) throw new Error("Asset qualification unavailable");
      for (const asset of scan.assets) titles.set(asset.frontmatter.id, asset.frontmatter.title);
    }
    return { items: rows.map((r) => ({ ...r, assetTitle: titles.get(r.assetId) ?? null,
      authorizedWorkspaces: JSON.parse(r.scopes) as string[] })), total };
  }
  totals() { return { recallOperations: this.count("recall_operation"), recallItems: this.count("recall_item"), reads: this.count("read_operation"), used: this.count("used_event") }; }
  async workspaces() {
    const config = await this.capabilities.config();
    const scan = await scanAssetRepository(this.scanOptions);
    if (!scan.isComplete) throw new Error("Asset qualification unavailable");
    const items = config.workspaces.map(({ name, paths, aliases, description }) => {
      const authorized = (table: string) => this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} o WHERE EXISTS (SELECT 1 FROM json_each(o.authorized_workspaces_json) WHERE value=?)`).get(name)!.n;
      const source = (table: string) => this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE asset_workspace=?`).get(name)!.n;
      return { name, paths, aliases: aliases ?? [], description: description ?? "",
        assetCount: scan.assets.filter((asset) => asset.frontmatter.scope === "WORKSPACE" && asset.frontmatter.workspace === name).length,
        authorizedRecallCount: authorized("recall_operation"), authorizedReadCount: authorized("read_operation"), authorizedUsedCount: authorized("used_event"),
        sourceRecallCount: source("recall_item"), sourceReadCount: source("read_operation"),
        sourceUsedCount: this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM used_event u LEFT JOIN recall_item i ON i.recall_item_id=u.recall_item_id LEFT JOIN read_operation r ON r.read_ref=u.direct_read_ref WHERE coalesce(i.asset_workspace,r.asset_workspace)=?`).get(name)!.n };
    });
    return { items, globalAssetCount: scan.assets.filter((a) => a.frontmatter.scope === "GLOBAL").length,
      globalRecallCount: this.repository.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM recall_item WHERE asset_scope='GLOBAL'").get()!.n,
      diagnostics: scan.diagnostics.map((d) => d.code) };
  }
  private count(table: string) { return this.repository.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n; }
}
