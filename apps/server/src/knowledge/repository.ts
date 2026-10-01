import Database from "better-sqlite3";
import { CONTENT_VERSION_TABLE_SQL } from "../asset/content-version.js";
import type { RecallResult, RecallItem, ReadFact, UsedFact, Source } from "./model.js";
import { KnowledgeError } from "./model.js";

const schema = `
CREATE TABLE workspace_capability (capability_key_hash TEXT PRIMARY KEY, workspace TEXT NOT NULL,
 created_at TEXT NOT NULL, trusted_workspace_mapping_hash TEXT NOT NULL);
CREATE TABLE recall_operation (recall_id TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 queries_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
 diagnostics_json TEXT NOT NULL, budget_json TEXT NOT NULL);
CREATE TABLE recall_item (recall_item_id TEXT PRIMARY KEY, recall_id TEXT NOT NULL REFERENCES recall_operation(recall_id),
 asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, asset_scope TEXT NOT NULL, asset_workspace TEXT,
 delivered_mode TEXT NOT NULL, delivery_reasons_json TEXT NOT NULL, ordinal INTEGER NOT NULL,
 CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL)),
 UNIQUE(recall_id,asset_id), UNIQUE(recall_id,ordinal));
CREATE TABLE read_operation (read_ref TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, asset_scope TEXT NOT NULL, asset_workspace TEXT,
 recall_item_id TEXT REFERENCES recall_item(recall_item_id), occurred_at TEXT NOT NULL,
 CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL)));
CREATE TABLE used_event (used_id TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 recall_item_id TEXT UNIQUE REFERENCES recall_item(recall_item_id), direct_read_ref TEXT UNIQUE REFERENCES read_operation(read_ref),
 asset_id TEXT NOT NULL, occurred_at TEXT NOT NULL, CHECK ((recall_item_id IS NULL) != (direct_read_ref IS NULL)));
CREATE INDEX recall_item_asset ON recall_item(asset_id);
CREATE INDEX read_operation_asset ON read_operation(asset_id);
CREATE INDEX used_event_asset ON used_event(asset_id);
`;

/** Explicit offline upgrade only; constructors do not migrate production storage. */
export function migrateKnowledge(databasePath: string, retire = false, initialize = false): number {
  const db = new Database(databasePath, { fileMustExist: !initialize });
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const version = db.pragma("user_version", { simple: true });
      if (retire && ![2, 3, 4, 5, 6].includes(Number(version))) throw new KnowledgeError("MIGRATE_AND_VERIFY_BEFORE_RETIREMENT");
      if (version === 0 && initialize) {
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new KnowledgeError("INITIALIZE_REQUIRES_EMPTY_DATABASE");
        db.exec(CONTENT_VERSION_TABLE_SQL);
        db.exec(schema); db.pragma("user_version = 5");
      }
      else if (version === 1) { db.exec(schema); db.pragma("user_version = 5"); }
      else if (![2, 3, 4, 5, 6].includes(Number(version))) throw new KnowledgeError("KNOWLEDGE_SCHEMA_UNSUPPORTED");
      if (retire && version !== 3) {
        db.exec("DROP TABLE IF EXISTS task_asset_usage; DROP TABLE IF EXISTS task_turn_binding; DROP TABLE IF EXISTS task_loadout;");
        if (Number(version) < 4) db.pragma("user_version = 3");
      }
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new KnowledgeError("KNOWLEDGE_SCHEMA_INVALID");
    }).immediate();
    return Number(db.pragma("user_version", { simple: true }));
  } finally { db.close(); }
}

/** Preserve historical query text exactly as one expression, even if it looks like JSON. */
export function migrateRecallStorage(databasePath: string): number {
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const version = Number(db.pragma("user_version", { simple: true }));
      if (![2, 3, 4, 5, 6].includes(version)) throw new KnowledgeError("KNOWLEDGE_SCHEMA_UNSUPPORTED");
      if (version < 4) {
        db.exec("ALTER TABLE recall_operation RENAME COLUMN query TO queries_json");
        db.exec("UPDATE recall_operation SET queries_json = json_array(queries_json)");
      }
      if (version < 5) {
        // Legacy names are confined to the offline upgrade; keep all operation identities and references.
        db.exec(`ALTER TABLE recall_operation DROP COLUMN active_scenarios_json;
          ALTER TABLE recall_operation DROP COLUMN policy_hash;
          ALTER TABLE recall_item DROP COLUMN selection_reasons_json;
          ALTER TABLE recall_item DROP COLUMN bucket;
          ALTER TABLE recall_item DROP COLUMN requested_mode;
          UPDATE recall_operation SET budget_json=json_remove(budget_json, '$.directBucketAssets', '$.queryBucketAssets'),
            diagnostics_json=(SELECT json_group_array(value) FROM json_each(diagnostics_json)
              WHERE value NOT GLOB 'POLICY_*' AND value <> 'SCENARIO_SKIPPED');`);
        db.pragma("user_version = 5");
      }
      db.prepare("SELECT queries_json FROM recall_operation LIMIT 0").all();
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new KnowledgeError("KNOWLEDGE_SCHEMA_INVALID");
    }).immediate();
    return Number(db.pragma("user_version", { simple: true }));
  } finally { db.close(); }
}

export class KnowledgeRepository {
  readonly db: Database.Database;
  constructor(databasePath: string) {
    this.db = new Database(databasePath, { fileMustExist: true, timeout: 1000 });
    try {
      this.db.pragma("foreign_keys = ON");
      if (![5, 6].includes(Number(this.db.pragma("user_version", { simple: true })))) throw new KnowledgeError("KNOWLEDGE_MIGRATION_REQUIRED");
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
