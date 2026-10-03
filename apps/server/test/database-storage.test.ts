import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { BASELINE_SCHEMA_SQL } from "../src/storage/schema.js";
import { AssetRepository, type NewAsset } from "../src/asset/asset-repository.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON"); db.exec(BASELINE_SCHEMA_SQL);
  return { db, assets: new AssetRepository(db), candidates: new CandidateRepository(db) };
}
const content: NewAsset = { assetId: "ast1", type: "MEMORY", scope: "GLOBAL", workspace: null,
  title: "测试知识", summary: "搜索事务", retrievalTerms: [], bodyMarkdown: "# 测试知识\n\natomic storage" };

test("v2 constraints, defaults, business keys and approved indexes", t => {
  const { db, assets, candidates } = fixture(); t.after(() => db.close());
  const row = candidates.write("init", "accept", "one", () => assets.insert(content));
  assert.equal(row.version, 0); assert.equal(row.knowledgeNumber, 1); assert.equal(row.previousContent, null);
  assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(db.prepare("SELECT is_deleted FROM asset").get(), { is_deleted: 0 });
  for (const [column, value] of [["asset_type", "BAD"], ["asset_scope", "BAD"], ["title", " "], ["summary", ""],
    ["body_markdown", ""], ["version", -1], ["is_deleted", 2], ["previous_content", "invalid"], ["workspace", "unexpected"]] as const) {
    assert.throws(() => db.prepare(`UPDATE asset SET ${column}=? WHERE asset_id=?`).run(value, content.assetId), /CHECK/);
  }
  assert.throws(() => candidates.write("duplicate", "accept", "two", () => assets.insert(content)), /UNIQUE/);
  assert.equal(candidates.receipt("duplicate"), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' OR type='view'").all().length, 0);
  assert.deepEqual(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row => row.name),
    ["asset_candidate_open", "read_operation_asset", "recall_item_asset", "used_event_asset"]);
});

test("revision rotates previous content atomically, checks version, and updates FTS immediately", t => {
  const { db, assets, candidates } = fixture(); t.after(() => db.close());
  const original = candidates.write("new", "accept", "1", () => assets.insert(content));
  assert.equal(assets.search([], '"atomic"').length, 1);
  const revised = candidates.write("revision", "accept", "2", () => assets.revise("ast1", 0,
    { title: "新标题", summary: "新摘要", retrievalTerms: [], bodyMarkdown: "changed searchable" }));
  assert.equal(revised.version, 1);
  assert.deepEqual(revised.previousContent, { title: content.title, summary: content.summary, retrievalTerms: [], bodyMarkdown: content.bodyMarkdown, updatedAt: original.updatedAt });
  assert.equal(assets.search([], '"atomic"').length, 0); assert.equal(assets.search([], '"searchable"').length, 1);
  assert.throws(() => candidates.write("stale", "accept", "3", () => assets.revise("ast1", 0, content)), { code: "VERSION_CONFLICT" });
  assert.equal(candidates.receipt("stale"), undefined);
  const unchanged = candidates.write("unchanged", "accept", "4", () => assets.revise("ast1", 1, revised));
  assert.deepEqual(unchanged, revised);
});

test("write receipts replay once, reject input conflicts and roll back content and FTS on failure", t => {
  const { db, assets, candidates } = fixture(); t.after(() => db.close());
  const first = candidates.write("same", "accept", "input", () => assets.insert(content));
  assert.deepEqual(candidates.write("same", "accept", "input", () => { throw new Error("must not run"); }), first);
  assert.throws(() => candidates.write("same", "accept", "other", () => ({})), { code: "REQUEST_ID_CONFLICT" });
  assert.throws(() => candidates.write("same", "reject", "input", () => ({})), { code: "REQUEST_ID_CONFLICT" });
  assert.throws(() => candidates.write("failure", "accept", "input", () => {
    assets.revise("ast1", 0, { ...content, bodyMarkdown: "rolled back" }); throw new Error("abort");
  }), /abort/);
  assert.deepEqual(assets.get("ast1"), first); assert.equal(candidates.receipt("failure"), undefined);
  assert.equal(assets.search([], '"atomic"').length, 1);
  for (const status of ["REVIEW_REQUIRED", "REVISION_BLOCKED"]) {
    assert.deepEqual(candidates.write(status, "prepare", "input", () => {
      assets.insert({ ...content, assetId: "ast2" }); return { status };
    }), { status });
    assert.equal(assets.get("ast2"), undefined); assert.equal(candidates.receipt(status), undefined);
  }
});

test("logical deletion filters reads and search, preserves FTS, and never reuses knowledge numbers", t => {
  const { db, assets, candidates } = fixture(); t.after(() => db.close());
  candidates.write("new", "accept", "1", () => assets.insert(content));
  candidates.write("delete", "delete", "2", () => { assets.delete("ast1"); return { deleted: true }; });
  assert.equal(assets.get("ast1"), undefined); assert.deepEqual(assets.list([]), []); assert.deepEqual(assets.search([], '"atomic"'), []);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) n FROM asset_fts").get()!.n, 1);
  const next = candidates.write("next", "accept", "3", () => assets.insert({ ...content, assetId: "ast2" }));
  assert.equal(next.knowledgeNumber, 2);
});

test("candidate uniqueness, version conflicts, unchanged content and retained accepted rows", t => {
  const { db, assets, candidates } = fixture(); t.after(() => db.close());
  candidates.write("new", "accept", "1", () => assets.insert(content));
  const input = { ...content, candidateId: "cnd1", intent: "REVISION" as const, baseVersion: 0 };
  const first = candidates.write("prepare", "prepare", "2", () => candidates.insert(input));
  assert.equal(first.version, 0); assert.equal(first.status, "PENDING");
  assert.throws(() => candidates.write("duplicate", "prepare", "3", () => candidates.insert({ ...input, candidateId: "cnd2" })), /UNIQUE/);
  assert.throws(() => candidates.write("delete", "delete", "4", () => assets.delete("ast1")), { code: "ASSET_HAS_OPEN_CANDIDATE" });
  const next = candidates.write("update", "update", "5", () => candidates.updateContent("cnd1", 0, { ...content, title: "候选更新" }));
  assert.equal(next.version, 1);
  assert.throws(() => candidates.write("stale", "update", "6", () => candidates.updateContent("cnd1", 0, content)), { code: "VERSION_CONFLICT" });
  assert.deepEqual(candidates.write("unchanged", "update", "7", () => candidates.updateContent("cnd1", 1, next)), next);
  candidates.write("accept", "accept", "8", () => candidates.setStatus("cnd1", 1, "ACCEPTED"));
  assert.equal(candidates.get("cnd1")!.status, "ACCEPTED"); assert.deepEqual(candidates.list(), []);
  assert.equal(candidates.byAsset("ast1"), undefined);
  assert.equal(candidates.write("again", "prepare", "9", () => candidates.insert({ ...input, candidateId: "cnd3" })).number, 2);
  assert.throws(() => db.prepare("UPDATE asset_candidate SET status='BAD' WHERE candidate_id='cnd3'").run(), /CHECK/);
});

test("every ordinary table enforces business uniqueness, boolean defaults and JSON constraints", t => {
  const { db, candidates, assets } = fixture(); t.after(() => db.close());
  candidates.write("seed", "accept", "input", () => {
    assets.insert(content); candidates.insert({ ...content, candidateId: "cnd1", intent: "NEW", baseVersion: null }); return {};
  });
  const facts = [
    ["workspace_capability", { capability_key_hash: "cap1", workspace: "alpha", trusted_workspace_mapping_hash: "mapping" }],
    ["recall_operation", { recall_id: "usg1", authorized_workspaces_json: "[]", queries_json: '["query"]', diagnostics_json: "[]", budget_json: "{}" }],
    ["recall_item", { recall_item_id: "usg2", recall_id: "usg1", asset_id: "ast1", asset_scope: "GLOBAL", delivered_mode: "DIRECT", delivery_reasons_json: "[]", ordinal: 0 }],
    ["read_operation", { read_ref: "usg3", authorized_workspaces_json: "[]", asset_id: "ast1", asset_scope: "GLOBAL", recall_item_id: "usg2" }],
    ["used_event", { used_id: "usg4", authorized_workspaces_json: "[]", asset_id: "ast1", recall_item_id: "usg2" }],
  ] as const;
  for (const [table, values] of facts) {
    const keys = Object.keys(values);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values));
  }
  for (const table of ["asset", "asset_candidate", "write_operation", ...facts.map(([table]) => table)]) {
    const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
    assert.equal(columns[0]!.name, "id"); const key = columns[1]!.name;
    const row = db.prepare<[], { id: number; is_deleted: number; created_at: string; updated_at: string }>(`SELECT id,is_deleted,created_at,updated_at FROM ${table}`).get()!;
    assert.equal(row.id, 1); assert.equal(row.is_deleted, 0);
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); assert.equal(row.created_at, row.updated_at);
    assert.throws(() => db.prepare(`UPDATE ${table} SET is_deleted=2 WHERE ${key} IS NOT NULL`).run(), /CHECK/);
    const names = columns.map(column => column.name).filter(name => name !== "id");
    assert.throws(() => db.prepare(`INSERT INTO ${table} (${names.join(',')}) SELECT ${names.join(',')} FROM ${table}`).run(), /UNIQUE/);
    for (const name of names.filter(name => name.endsWith('_json') || name === 'previous_content')) {
      assert.throws(() => db.prepare(`UPDATE ${table} SET ${name}='invalid' WHERE ${key} IS NOT NULL`).run(), /CHECK/);
    }
  }
  for (const table of ["recall_item", "read_operation"]) assert.deepEqual(db.prepare(`SELECT asset_version FROM ${table}`).get(), { asset_version: 0 });
  for (const [table, field, value] of [["asset_candidate", "intent", "BAD"], ["asset_candidate", "base_version", 1],
    ["write_operation", "operation", "confirm"], ["recall_item", "delivered_mode", "BAD"], ["read_operation", "asset_scope", "BAD"]] as const)
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${field}=? WHERE id=1`).run(value), /CHECK/);
});

test("deleted knowledge and facts are filtered at read, Used and projection boundaries", async () => {
  const f = await knowledgeFixture();
  try {
    const asset = await f.asset({ title: "soft delete searchable" });
    const recalled = await f.service.recall({ capabilityIds: [], queries: ["searchable"] });
    const recallItemId = recalled.items[0]!.recallItemId!;
    const recallId = f.repository.item(recallItemId)!.recallId;
    const read = await f.service.read({ capabilityIds: [], recallItemId });
    await f.service.used({ capabilityIds: [], readRef: read.readRef });
    f.remove(asset.assetId);
    assert.deepEqual((await f.service.recall({ capabilityIds: [], queries: ["searchable"] })).items, []);
    await assert.rejects(f.service.read({ capabilityIds: [], assetId: asset.assetId }), { code: "ASSET_NOT_FOUND" });
    await assert.rejects(f.service.used({ capabilityIds: [], readRef: read.readRef }), { code: "ASSET_NOT_FOUND" });
    assert.equal((await f.projection.usage()).items[0]!.assetTitle, null);
    assert.throws(() => f.repository.recordUsed({ usedId: "usg999", assetId: asset.assetId, recallItemId, directReadRef: null, authorizedWorkspaces: [], occurredAt: new Date().toISOString() }), { code: "ASSET_NOT_ACCESSIBLE" });
    const db = f.repository.db;
    for (const [table, key, id] of [["used_event", "asset_id", asset.assetId], ["read_operation", "read_ref", read.readRef], ["recall_item", "recall_item_id", recallItemId], ["recall_operation", "recall_id", recallId]] as const)
      db.prepare(`UPDATE ${table} SET is_deleted=1,updated_at=? WHERE ${key}=?`).run(new Date().toISOString(), id);
    assert.equal(f.repository.item(recallItemId), undefined); assert.equal(f.repository.readFact(read.readRef!), undefined);
    assert.deepEqual((await f.projection.usage()).items, []); assert.equal(await f.projection.recall(recallId), null);
    assert.deepEqual(f.repository.summarizeByAsset(asset.assetId), { recallCount: 0, readCount: 0, totalUsedCount: 0 });
    assert.deepEqual(f.projection.items("i.asset_id=?", asset.assetId), []);
    await assert.rejects(f.service.read({ capabilityIds: [], recallItemId }), { code: "SOURCE_NOT_FOUND" });
  } finally { await f.close(); }
});
