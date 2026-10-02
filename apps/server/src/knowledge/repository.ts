import { AssetRepository } from "../asset/asset-repository.js";
import type { WorkspaceCapabilityService } from "../workspace/capability.js";
import Database from "better-sqlite3";
import { openDatabase } from "../storage/schema.js";
import type { RecallResult, RecallItem, ReadFact, UsedFact, Source } from "./model.js";
import { KnowledgeError } from "./model.js";

export class KnowledgeRepository {
  readonly db: Database.Database;
  constructor(databasePath: string) {
    this.db = openDatabase(databasePath, { timeout: 1000 });
  }
  readTransaction<T>(fn: (assets: AssetRepository) => T): T {
    return this.db.transaction(() => fn(new AssetRepository(this.db)))();
  }
  capability(digest: string): { workspace: string; hash: string } | undefined {
    return this.db.prepare<[string], { workspace: string; hash: string }>("SELECT workspace,trusted_workspace_mapping_hash AS hash FROM workspace_capability WHERE capability_key_hash=? AND is_deleted = 0").get(digest);
  }
  issueCapabilities(rows: Array<{ digest: string; workspace: string; hash: string }>): void {
    this.db.transaction(() => {
      const insert = this.db.prepare("INSERT INTO workspace_capability (capability_key_hash,workspace,trusted_workspace_mapping_hash,created_at,updated_at) VALUES (?,?,?,?,?)");
      const now = new Date().toISOString();
      for (const row of rows) insert.run(row.digest, row.workspace, row.hash, now, now);
    }).immediate();
  }
  revokeCapability(digest: string): number {
    return this.db.transaction(() => this.db.prepare("UPDATE workspace_capability SET is_deleted=1,updated_at=? WHERE capability_key_hash=? AND is_deleted = 0")
      .run(new Date().toISOString(), digest).changes).immediate();
  }
  close(): void { this.db.close(); }
  recordRecall(result: RecallResult): void {
    this.write(() => {
      for (const item of result.items) assertSourceScope(item, result.authorizedWorkspaces);
      this.db.prepare(`INSERT INTO recall_operation (recall_id, authorized_workspaces_json, queries_json,
        created_at, diagnostics_json, budget_json, updated_at) VALUES (?,?,?,?,?,?,?)`).run(result.recallId,
        JSON.stringify(result.authorizedWorkspaces), JSON.stringify(result.queries),
        result.occurredAt, JSON.stringify(result.diagnostics), JSON.stringify(result.budget), result.occurredAt);
      const insert = this.db.prepare("INSERT INTO recall_item (recall_item_id,recall_id,asset_id,asset_version,asset_scope,asset_workspace,delivered_mode,delivery_reasons_json,ordinal,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      result.items.forEach((item, ordinal) => insert.run(item.recallItemId, result.recallId, item.assetId, item.version,
        item.assetScope, item.assetWorkspace,
        item.deliveredMode, JSON.stringify(item.deliveryReasons), ordinal, result.occurredAt, result.occurredAt));
    });
  }
  item(id: string): (Source & { recallId: string; recallItemId: string }) | undefined {
    const row = this.db.prepare<[string], { recallId: string; recallItemId: string; assetId: string; version: number;
      assetScope: RecallItem["assetScope"]; assetWorkspace: string | null }>(`SELECT recall_id AS recallId, recall_item_id AS recallItemId,
      asset_id AS assetId, asset_version AS version, asset_scope AS assetScope, asset_workspace AS assetWorkspace
      FROM recall_item WHERE recall_item_id=? AND is_deleted = 0`).get(id);
    return row;
  }
  readFact(id: string): ReadFact | undefined {
    const row = this.db.prepare<[string], Omit<ReadFact, "authorizedWorkspaces"> & { scopes: string }>(`SELECT read_ref AS readRef,
      authorized_workspaces_json AS scopes, asset_id AS assetId, asset_version AS version, asset_scope AS assetScope,
      asset_workspace AS assetWorkspace, recall_item_id AS recallItemId, created_at AS occurredAt FROM read_operation WHERE read_ref=? AND is_deleted = 0`).get(id);
    return row ? { ...row, authorizedWorkspaces: JSON.parse(row.scopes) as string[] } : undefined;
  }
  recordRead(fact: ReadFact): void {
    this.write(() => {
      assertSourceScope(fact, fact.authorizedWorkspaces);
      if (fact.recallItemId) {
        const source = this.item(fact.recallItemId);
        if (!source || source.assetId !== fact.assetId || source.version !== fact.version || source.assetScope !== fact.assetScope || source.assetWorkspace !== fact.assetWorkspace) throw new KnowledgeError("SOURCE_INVALID");
      }
      this.db.prepare("INSERT INTO read_operation (read_ref,authorized_workspaces_json,asset_id,asset_version,asset_scope,asset_workspace,recall_item_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(fact.readRef, JSON.stringify(fact.authorizedWorkspaces),
        fact.assetId, fact.version, fact.assetScope, fact.assetWorkspace, fact.recallItemId, fact.occurredAt, fact.occurredAt);
    });
  }
  recordUsed(fact: UsedFact): { usedId: string; assetId: string; created: boolean } {
    return this.write(() => {
      const source = fact.recallItemId ? this.item(fact.recallItemId) : this.readFact(fact.directReadRef!);
      if (!source || source.assetId !== fact.assetId) throw new KnowledgeError("SOURCE_INVALID");
      assertSourceScope(source, fact.authorizedWorkspaces);
      const current = new AssetRepository(this.db).get(fact.assetId);
      if (!current) throw new KnowledgeError("ASSET_NOT_ACCESSIBLE");
      if (current.scope === "WORKSPACE" && !fact.authorizedWorkspaces.includes(current.workspace!)) throw new KnowledgeError("ASSET_NOT_ACCESSIBLE");
      const inserted = this.db.prepare("INSERT INTO used_event (used_id,authorized_workspaces_json,recall_item_id,direct_read_ref,asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(fact.usedId, JSON.stringify(fact.authorizedWorkspaces), fact.recallItemId, fact.directReadRef, fact.assetId, fact.occurredAt, fact.occurredAt);
      const row = this.db.prepare<[string | null, string | null], { usedId: string }>("SELECT used_id AS usedId FROM used_event WHERE (recall_item_id=? OR direct_read_ref=?) AND is_deleted = 0").get(fact.recallItemId, fact.directReadRef);
      if (!row) throw new KnowledgeError("SOURCE_INVALID");
      return { usedId: row.usedId, assetId: fact.assetId, created: inserted.changes === 1 };
    });
  }
  summarizeByAsset(assetId: string) {
    return this.readTransaction(() => {
    const count = (table: string) => this.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE asset_id=? AND is_deleted = 0`).get(assetId)!.n;
    return { recallCount: count("recall_item"), readCount: count("read_operation"), totalUsedCount: count("used_event") };
    });
  }
  private write<T>(operation: () => T): T {
    try { return this.db.transaction(operation).immediate(); }
    catch (error) {
      if (error instanceof Database.SqliteError) throw new KnowledgeError("USAGE_WRITE_FAILED", { cause: error });
      throw error;
    }
  }
}

function assertSourceScope(source: Source, workspaces: readonly string[]): void {
  if ((source.assetScope === "GLOBAL" && source.assetWorkspace !== null) ||
      (source.assetScope === "WORKSPACE" && (!source.assetWorkspace || !workspaces.includes(source.assetWorkspace)))) {
    throw new KnowledgeError("SOURCE_INVALID");
  }
}

export interface RecallProjection {
  recallId: string; authorizedWorkspaces: string[]; queries: string[];
  occurredAt: string; diagnostics: string[]; budget: RecallResult["budget"];
}
export interface ItemProjection extends Source { recallItemId: string; assetTitle: string | null;
  deliveredMode: string; deliveryReasons: string[]; readCount: number; totalUsedCount: number }
export interface UsageProjection extends Source { id: string; kind: "READ" | "USED"; authorizedWorkspaces: string[];
  occurredAt: string; recallItemId: string | null; readRef: string | null; assetTitle: string | null }
export class KnowledgeProjectionRepository {
  constructor(readonly repository: KnowledgeRepository, readonly capabilities: WorkspaceCapabilityService,
    readonly options: { workspaceConfigPath: string }) {}
  recalls(offset = 0, limit = 50) {
    return this.repository.readTransaction(() => {
    const rows = this.repository.db.prepare<[number, number], { recallId: string; scopes: string; queriesJson: string;
      occurredAt: string; diagnostics: string; budget: string }>(`SELECT recall_id AS recallId,
      authorized_workspaces_json AS scopes, queries_json AS queriesJson,
      created_at AS occurredAt, diagnostics_json AS diagnostics, budget_json AS budget FROM recall_operation WHERE is_deleted = 0
      ORDER BY created_at DESC, recall_id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const items: RecallProjection[] = rows.map(({ queriesJson, ...r }) => ({ ...r, queries: JSON.parse(queriesJson) as string[], authorizedWorkspaces: JSON.parse(r.scopes) as string[],
      diagnostics: JSON.parse(r.diagnostics) as string[], budget: JSON.parse(r.budget) as RecallResult["budget"] }));
    return { items, total: this.count("recall_operation") };
    });
  }
  async recall(id: string) {
    const config = await this.capabilities.config();
    return this.repository.readTransaction(assets => {
    const row = this.repository.db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM recall_operation WHERE is_deleted = 0 AND recall_id=?").get(id);
    if (!row?.n) return null;
    const { queriesJson, ...raw } = this.repository.db.prepare<[string], { recallId: string; scopes: string; queriesJson: string;
      occurredAt: string; diagnostics: string; budget: string }>(`SELECT recall_id AS recallId,
      authorized_workspaces_json AS scopes, queries_json AS queriesJson,
      created_at AS occurredAt, diagnostics_json AS diagnostics, budget_json AS budget FROM recall_operation WHERE is_deleted = 0 AND recall_id=?`).get(id)!;
    const operation: RecallProjection = { ...raw, queries: JSON.parse(queriesJson) as string[], authorizedWorkspaces: JSON.parse(raw.scopes) as string[],
      diagnostics: JSON.parse(raw.diagnostics) as string[], budget: JSON.parse(raw.budget) as RecallResult["budget"] };
    const rows = this.items("i.recall_id=?", id);
    const titles = new Map<string, string>();
    if (rows.length) {
      for (const asset of assets.list(config.workspaces.map(workspace => workspace.name))) titles.set(asset.assetId, asset.title);
    }
    const items: ItemProjection[] = rows.map((r) => ({ ...r, assetTitle: titles.get(r.assetId) ?? null }));
    return { operation, items };
    });
  }
  items(condition: "i.recall_id=?" | "i.asset_id=?", id: string): Omit<ItemProjection, "assetTitle">[] {
    const rows = this.repository.db.prepare<[string], Omit<ItemProjection, "deliveryReasons" | "assetTitle"> & { delivery: string }>(`SELECT
      i.recall_item_id AS recallItemId, i.asset_id AS assetId, i.asset_version AS version, i.asset_scope AS assetScope,
      i.asset_workspace AS assetWorkspace,
      i.delivered_mode AS deliveredMode, i.delivery_reasons_json AS delivery,
      (SELECT count(*) FROM read_operation r WHERE r.recall_item_id=i.recall_item_id AND r.is_deleted = 0) AS readCount,
      (SELECT count(*) FROM used_event u WHERE u.recall_item_id=i.recall_item_id AND u.is_deleted = 0) AS totalUsedCount
      FROM recall_item i WHERE i.is_deleted = 0 AND ${condition} ORDER BY ${condition === "i.recall_id=?" ? "i.ordinal ASC" : "i.created_at DESC,i.recall_item_id DESC"} LIMIT 100`).all(id);
    return rows.map((r) => ({ ...r, deliveryReasons: JSON.parse(r.delivery) as string[] }));
  }
  async usage(offset = 0, limit = 50, assetId?: string) {
    const config = await this.capabilities.config();
    return this.repository.readTransaction(() => this.usageSnapshot(config.workspaces.map(workspace => workspace.name), offset, limit, assetId));
  }
  async assetDetail(assetId: string) {
    const workspaces = (await this.capabilities.config()).workspaces.map(workspace => workspace.name);
    return this.repository.readTransaction(assets => {
      const asset = assets.get(assetId);
      if (!asset || (asset.scope === "WORKSPACE" && !workspaces.includes(asset.workspace!))) return null;
      const { previousContent: _previous, ...content } = asset;
      return { ...content, recentRecalls: this.items("i.asset_id=?", assetId),
        recentUsage: this.usageSnapshot(workspaces, 0, 20, assetId).items, usageSummary: this.repository.summarizeByAsset(assetId) };
    });
  }
  private usageSnapshot(workspaces: string[], offset: number, limit: number, assetId?: string) {
    const sql = `SELECT r.read_ref AS id, 'READ' AS kind, r.authorized_workspaces_json AS scopes, r.asset_id AS assetId,
      r.asset_version AS version, r.asset_scope AS assetScope, r.asset_workspace AS assetWorkspace,
      r.created_at AS occurredAt, r.recall_item_id AS recallItemId, r.read_ref AS readRef FROM read_operation r WHERE r.is_deleted = 0
      UNION ALL SELECT u.used_id, 'USED', u.authorized_workspaces_json, u.asset_id,
      coalesce(i.asset_version,r.asset_version), coalesce(i.asset_scope,r.asset_scope), coalesce(i.asset_workspace,r.asset_workspace),
      u.created_at,u.recall_item_id,u.direct_read_ref FROM used_event u LEFT JOIN recall_item i ON i.recall_item_id=u.recall_item_id AND i.is_deleted = 0
      LEFT JOIN read_operation r ON r.read_ref=u.direct_read_ref AND r.is_deleted = 0 WHERE u.is_deleted = 0`;
    const filter = assetId ? " WHERE assetId=?" : "";
    const rows = this.repository.db.prepare<unknown[], Omit<UsageProjection, "authorizedWorkspaces" | "assetTitle"> & { scopes: string }>(
      `SELECT id,kind,scopes,assetId,version,assetScope,assetWorkspace,occurredAt,recallItemId,readRef FROM (${sql})${filter} ORDER BY occurredAt DESC,id DESC LIMIT ? OFFSET ?`).all(...(assetId ? [assetId] : []), limit, offset);
    const total = this.repository.db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM (${sql})${filter}`).get(...(assetId ? [assetId] : []))!.n;
    const titles = new Map<string, string>();
    if (rows.length) {
      for (const asset of new AssetRepository(this.repository.db).list(workspaces)) titles.set(asset.assetId, asset.title);
    }
    return { items: rows.map((r) => ({ ...r, assetTitle: titles.get(r.assetId) ?? null,
      authorizedWorkspaces: JSON.parse(r.scopes) as string[] })), total };
  }
  totals() { return this.repository.readTransaction(() => ({ recallOperations: this.count("recall_operation"), recallItems: this.count("recall_item"), reads: this.count("read_operation"), used: this.count("used_event") })); }
  async workspaces() {
    const config = await this.capabilities.config();
    return this.repository.readTransaction(() => {
    const assets = new AssetRepository(this.repository.db).list(config.workspaces.map(workspace => workspace.name));
    const items = config.workspaces.map(({ name, paths, aliases, description }) => {
      const authorized = (table: string) => this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} o WHERE o.is_deleted = 0 AND EXISTS (SELECT 1 FROM json_each(o.authorized_workspaces_json) WHERE value=?)`).get(name)!.n;
      const source = (table: string) => this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE is_deleted = 0 AND asset_workspace=?`).get(name)!.n;
      return { name, paths, aliases: aliases ?? [], description: description ?? "",
        assetCount: assets.filter((asset) => asset.scope === "WORKSPACE" && asset.workspace === name).length,
        authorizedRecallCount: authorized("recall_operation"), authorizedReadCount: authorized("read_operation"), authorizedUsedCount: authorized("used_event"),
        sourceRecallCount: source("recall_item"), sourceReadCount: source("read_operation"),
        sourceUsedCount: this.repository.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM used_event u LEFT JOIN recall_item i ON i.recall_item_id=u.recall_item_id AND i.is_deleted = 0 LEFT JOIN read_operation r ON r.read_ref=u.direct_read_ref AND r.is_deleted = 0 WHERE u.is_deleted = 0 AND coalesce(i.asset_workspace,r.asset_workspace)=?`).get(name)!.n };
    });
    return { items, globalAssetCount: assets.filter((a) => a.scope === "GLOBAL").length,
      globalRecallCount: this.repository.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM recall_item WHERE is_deleted = 0 AND asset_scope='GLOBAL'").get()!.n,
      diagnostics: [] };
    });
  }
  private count(table: string) { return this.repository.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE is_deleted = 0`).get()!.n; }
}
