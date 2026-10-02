import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { BASELINE_SCHEMA_SQL, completeDatabaseStructure, initializeDatabase, openDatabase, PERSISTENT_TABLES } from "../src/storage/schema.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import { AssetSearchService } from "../src/asset/search.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";

test("init-database requires offline acknowledgement and creates the complete baseline only in an empty database", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-baseline-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite");
  const output = new PassThrough(); let text = ""; output.on("data", chunk => { text += String(chunk); });
  const env = { PRECEDENT_LOOP_DATABASE_PATH: path };
  assert.equal(await runMaintenanceCli(["init-database"], env, output, output), 1);
  assert.match(text, /--offline/); text = "";
  assert.equal(await runMaintenanceCli(["init-database", "--offline"], env, output, output), 0);
  assert.deepEqual(JSON.parse(text), { ok: true });
  const db = openDatabase(path); t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 0);
  for (const table of PERSISTENT_TABLES) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
  const before = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => initializeDatabase(path), { code: "DATABASE_NOT_EMPTY" });
  text = "";
  assert.equal(await runMaintenanceCli(["init-database", "--offline"], env, output, output), 1);
  assert.equal(JSON.parse(text).error.code, "DATABASE_NOT_EMPTY");
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before);
  const occupied = join(root, "occupied.sqlite"); const other = new Database(occupied); t.after(() => other.close());
  other.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('preserve')");
  assert.throws(() => initializeDatabase(occupied), { code: "DATABASE_NOT_EMPTY" });
  text = "";
  assert.equal(await runMaintenanceCli(["init-database", "--offline"], { PRECEDENT_LOOP_DATABASE_PATH: occupied }, output, output), 1);
  assert.equal(JSON.parse(text).error.code, "DATABASE_NOT_EMPTY");
  assert.deepEqual(other.prepare("SELECT * FROM user_data").all(), [{ value: "preserve" }]);
  assert.equal(other.pragma("user_version", { simple: true }), 0);
});

test("all main database readers ignore and preserve user_version; absent and empty databases require explicit initialization", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-version-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite"); initializeDatabase(path);
  const db = new Database(path); t.after(() => db.close());
  const schema = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => openDatabase(join(root, "missing.sqlite")), /init-database --offline/);
  const empty = join(root, "empty.sqlite"); new Database(empty).close();
  for (const readonly of [true, false]) assert.throws(() => openDatabase(empty, { readonly }), /init-database --offline/);
  for (const version of [0, 1, 2, 99]) {
    db.pragma(`user_version=${version}`);
    for (const open of [() => openDatabase(path), () => new KnowledgeRepository(path),
      () => new AssetSearchService({ databasePath: path, workspaceConfigPath: join(root, "workspaces.json") })]) {
      open().close();
    }
    new CandidateRepository(db);
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schema);
  }
});

test("complete structures take no write transaction even while another connection holds the write lock", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-unlocked-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite"); initializeDatabase(path);
  const writer = new Database(path); t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  try {
    const statements: string[] = [];
    const db = openDatabase(path, { timeout: 0, verbose: sql => statements.push(String(sql)) });
    db.close();
    assert.ok(statements.length > 0);
    assert.ok(statements.every(sql => !/BEGIN|CREATE|ALTER|DROP|INSERT|user_version/iu.test(sql)));
  } finally { writer.exec("ROLLBACK"); }
});

test("Design 16 structures fill missing tables and indexes idempotently; readonly connections never repair", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-additive-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite"), db = new Database(path); t.after(() => db.close());
  db.exec(BASELINE_SCHEMA_SQL.replaceAll(" IF NOT EXISTS", "")); db.pragma("user_version=2");
  db.exec("DROP TABLE asset_candidate; DROP INDEX recall_item_asset");
  const before = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => openDatabase(path, { readonly: true }), { code: "DATABASE_SCHEMA_INVALID" });
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before);
  openDatabase(path).close();
  const repaired = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='recall_item_asset'").get());
  for (const table of PERSISTENT_TABLES) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
  openDatabase(path).close();
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), repaired);
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  db.exec("DROP INDEX recall_item_asset");
  const readonly = openDatabase(path, { readonly: true });
  completeDatabaseStructure(readonly); readonly.close();
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='recall_item_asset'").get(), undefined);
});

test("column additions apply constant defaults and CHECK without changing existing data, and roll back on failure", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  await f.asset({ title: "preserved" });
  const db = f.repository.db, before = db.prepare("SELECT * FROM asset").all();
  const additions = [{ table: "asset", name: "test_column", definition: "TEXT NOT NULL DEFAULT 'kept' CHECK(length(test_column)>0)" }];
  completeDatabaseStructure(db, additions);
  assert.deepEqual(db.prepare("SELECT test_column FROM asset").all(), [{ test_column: "kept" }]);
  assert.deepEqual(db.prepare("SELECT * FROM asset").all().map(row => {
    const { test_column: _column, ...original } = row as Record<string, unknown>; return original;
  }), before);
  assert.throws(() => db.exec("UPDATE asset SET test_column=''"), /CHECK/);
  const trace: string[] = [], check = new Database(f.options.databasePath, { verbose: sql => trace.push(String(sql)) });
  try { completeDatabaseStructure(check, additions); } finally { check.close(); }
  assert.ok(trace.every(sql => !/BEGIN/iu.test(sql)));
  db.exec("DROP INDEX recall_item_asset");
  assert.throws(() => completeDatabaseStructure(db, [{ table: "asset", name: "invalid_column", definition: "TEXT NOT NULL" }]));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='recall_item_asset'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM pragma_table_info('asset') WHERE name='invalid_column'").get(), undefined);
});

test("two processes recheck missing structures under BEGIN IMMEDIATE and can open concurrently", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-concurrent-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite"); initializeDatabase(path);
  const db = new Database(path); t.after(() => db.close());
  db.exec("DROP TABLE asset_candidate; DROP INDEX recall_item_asset; BEGIN IMMEDIATE");
  const source = new URL("../src/storage/schema.ts", import.meta.url).href;
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { openDatabase } from ${JSON.stringify(source)};
    const db = openDatabase(${JSON.stringify(path)}, { verbose: sql => {
      if (sql === 'BEGIN IMMEDIATE') process.send('waiting');
    }});
    db.close(); process.disconnect();
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const exits = children.map(child => once(child, "exit"));
  try { await Promise.all(children.map(child => once(child, "message"))); }
  finally { db.exec("COMMIT"); }
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  openDatabase(path).close();
});

test("missing or mismatched FTS is rebuilt from live assets with identical recall ranking and summaries", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  await f.asset({ title: "rebuild token", summary: "direct summary" });
  await f.asset({ title: "other", body: "rebuild token" });
  const removed = await f.asset({ title: "rebuild token deleted" }); f.remove(removed.assetId);
  const input = { capabilityIds: [], queries: ["rebuild token"] };
  const content = (result: Awaited<ReturnType<typeof f.service.recall>>) => result.items.map(({ recallItemId: _id, ...item }) => item);
  const before = content(await f.service.recall(input));
  const assets = f.repository.db.prepare("SELECT * FROM asset").all(), facts = f.rows();
  for (const mismatch of [true, false]) {
    f.repository.db.exec("DROP TABLE asset_fts");
    if (mismatch) {
      f.repository.db.exec("CREATE VIRTUAL TABLE asset_fts USING fts5(asset_id UNINDEXED,title)");
      const readonly = openDatabase(f.options.databasePath, { readonly: true });
      try {
        completeDatabaseStructure(readonly);
        assert.deepEqual(readonly.prepare("SELECT name FROM pragma_table_info('asset_fts')").all(), [{ name: "asset_id" }, { name: "title" }]);
      } finally { readonly.close(); }
    }
    openDatabase(f.options.databasePath).close();
    assert.deepEqual(f.repository.db.prepare("SELECT * FROM asset").all(), assets);
    if (mismatch) assert.deepEqual(f.rows(), facts);
    assert.deepEqual(content(await f.service.recall(input)), before);
    assert.equal(f.repository.db.prepare("SELECT asset_id FROM asset_fts WHERE asset_id=?").get(removed.assetId), undefined);
  }
});
