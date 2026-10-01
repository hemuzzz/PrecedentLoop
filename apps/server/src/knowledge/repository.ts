import Database from "better-sqlite3";
import { openDatabase } from "../storage/schema.js";
import type { RecallResult, RecallItem, ReadFact, UsedFact, Source } from "./model.js";
import { KnowledgeError } from "./model.js";

export class KnowledgeRepository {
  readonly db: Database.Database;
  constructor(databasePath: string) {
    this.db = openDatabase(databasePath, { timeout: 1000 });
    try {
      this.db.pragma("foreign_keys = ON");
      for (const table of ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event"]) this.db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
      this.db.prepare("SELECT queries_json FROM recall_operation LIMIT 0").all();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  recordRecall(result: RecallResult): void {
    this.write(() => {
      for (const item of result.items) assertSourceScope(item, result.authorizedWorkspaces);
      this.db.prepare(`INSERT INTO recall_operation (recall_id, authorized_workspaces_json, queries_json,
        occurred_at, diagnostics_json, budget_json) VALUES (?,?,?,?,?,?)`).run(result.recallId,
        JSON.stringify(result.authorizedWorkspaces), JSON.stringify(result.queries),
        result.occurredAt, JSON.stringify(result.diagnostics), JSON.stringify(result.budget));
      const insert = this.db.prepare("INSERT INTO recall_item VALUES (?,?,?,?,?,?,?,?,?)");
      result.items.forEach((item, ordinal) => insert.run(item.recallItemId, result.recallId, item.assetId, item.contentHash,
        item.assetScope, item.assetWorkspace,
        item.deliveredMode, JSON.stringify(item.deliveryReasons), ordinal));
    });
  }
  item(id: string): (Source & { recallId: string; recallItemId: string }) | undefined {
    const row = this.db.prepare<[string], { recallId: string; recallItemId: string; assetId: string; contentHash: string;
      assetScope: RecallItem["assetScope"]; assetWorkspace: string | null }>(`SELECT recall_id AS recallId, recall_item_id AS recallItemId,
      asset_id AS assetId, content_hash AS contentHash, asset_scope AS assetScope, asset_workspace AS assetWorkspace
      FROM recall_item WHERE recall_item_id=?`).get(id);
    return row;
  }
  readFact(id: string): ReadFact | undefined {
    const row = this.db.prepare<[string], Omit<ReadFact, "authorizedWorkspaces"> & { scopes: string }>(`SELECT read_ref AS readRef,
      authorized_workspaces_json AS scopes, asset_id AS assetId, content_hash AS contentHash, asset_scope AS assetScope,
      asset_workspace AS assetWorkspace, recall_item_id AS recallItemId, occurred_at AS occurredAt FROM read_operation WHERE read_ref=?`).get(id);
    return row ? { ...row, authorizedWorkspaces: JSON.parse(row.scopes) as string[] } : undefined;
  }
  recordRead(fact: ReadFact): void {
    this.write(() => {
      assertSourceScope(fact, fact.authorizedWorkspaces);
      if (fact.recallItemId) {
        const source = this.item(fact.recallItemId);
        if (!source || source.assetId !== fact.assetId || source.contentHash !== fact.contentHash || source.assetScope !== fact.assetScope || source.assetWorkspace !== fact.assetWorkspace) throw new KnowledgeError("SOURCE_INVALID");
      }
      this.db.prepare("INSERT INTO read_operation VALUES (?,?,?,?,?,?,?,?)").run(fact.readRef, JSON.stringify(fact.authorizedWorkspaces),
        fact.assetId, fact.contentHash, fact.assetScope, fact.assetWorkspace, fact.recallItemId, fact.occurredAt);
    });
  }
  recordUsed(fact: UsedFact): { usedId: string; assetId: string; created: boolean } {
    return this.write(() => {
      const source = fact.recallItemId ? this.item(fact.recallItemId) : this.readFact(fact.directReadRef!);
      if (!source || source.assetId !== fact.assetId) throw new KnowledgeError("SOURCE_INVALID");
      assertSourceScope(source, fact.authorizedWorkspaces);
      const inserted = this.db.prepare("INSERT INTO used_event VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(fact.usedId, JSON.stringify(fact.authorizedWorkspaces), fact.recallItemId, fact.directReadRef, fact.assetId, fact.occurredAt);
      const row = this.db.prepare<[string | null, string | null], { usedId: string }>("SELECT used_id AS usedId FROM used_event WHERE recall_item_id=? OR direct_read_ref=?").get(fact.recallItemId, fact.directReadRef);
      if (!row) throw new KnowledgeError("SOURCE_INVALID");
      return { usedId: row.usedId, assetId: fact.assetId, created: inserted.changes === 1 };
    });
  }
  summarizeByAsset(assetId: string) {
    const count = (table: string) => this.db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE asset_id=?`).get(assetId)!.n;
    return { recallCount: count("recall_item"), readCount: count("read_operation"), totalUsedCount: count("used_event") };
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
