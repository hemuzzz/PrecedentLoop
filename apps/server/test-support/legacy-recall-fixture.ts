import Database from "better-sqlite3";
import { AssetContentVersionRepository } from "../src/asset/content-version.js";

// Historical storage only, for verifying lossless identity/reference upgrades.
export function createLegacyRecallDatabase(path: string, version: 2 | 3 | 4): void {
  const content = new AssetContentVersionRepository(path); content.close();
  const db = new Database(path);
  try {
    db.exec(`
CREATE TABLE workspace_capability (capability_key_hash TEXT PRIMARY KEY, workspace TEXT NOT NULL,
 created_at TEXT NOT NULL, trusted_workspace_mapping_hash TEXT NOT NULL);
CREATE TABLE recall_operation (recall_id TEXT PRIMARY KEY, authorized_workspaces_json TEXT NOT NULL,
 query TEXT NOT NULL, active_scenarios_json TEXT NOT NULL, policy_hash TEXT, occurred_at TEXT NOT NULL,
 diagnostics_json TEXT NOT NULL, budget_json TEXT NOT NULL);
CREATE TABLE recall_item (recall_item_id TEXT PRIMARY KEY, recall_id TEXT NOT NULL REFERENCES recall_operation(recall_id),
 asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, asset_scope TEXT NOT NULL, asset_workspace TEXT,
 selection_reasons_json TEXT NOT NULL, bucket TEXT NOT NULL CHECK(bucket IN ('DIRECT','QUERY')),
 requested_mode TEXT, delivered_mode TEXT NOT NULL, delivery_reasons_json TEXT NOT NULL, ordinal INTEGER NOT NULL,
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
CREATE INDEX used_event_asset ON used_event(asset_id);`);
    if (version === 4) db.exec("ALTER TABLE recall_operation RENAME COLUMN query TO queries_json");
    db.pragma(`user_version = ${version}`);
  } finally { db.close(); }
}
