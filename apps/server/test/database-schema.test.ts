import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase, openDatabase, PERSISTENT_TABLES } from "../src/storage/schema.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import { AssetSearchService } from "../src/asset/search.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";

test("init-database requires offline acknowledgement and creates the complete baseline only in an empty database", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-baseline-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite");
  const output = new PassThrough(); let text = ""; output.on("data", chunk => { text += String(chunk); });
  const env = { PRECEDENT_LOOP_DATABASE_PATH: path };
  assert.equal(await runMaintenanceCli(["init-database"], env, output, output), 1);
  assert.match(text, /--offline/); text = "";
  assert.equal(await runMaintenanceCli(["init-database", "--offline"], env, output, output), 0);
  assert.deepEqual(JSON.parse(text), { ok: true, schemaVersion: 2 });
  const db = openDatabase(path); t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 2);
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

test("all main database readers reject every non-baseline version without upgrading or writing", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-version-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite"); initializeDatabase(path);
  const db = new Database(path); t.after(() => db.close());
  const schema = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => openDatabase(join(root, "missing.sqlite")), /init-database --offline/);
  for (const version of [0, 1, 3, 4, 5, 6, 7, 99]) {
    db.pragma(`user_version=${version}`);
    assert.throws(() => openDatabase(path), new RegExp(`不支持数据库版本 ${version}，仅接受完整基线版本 2`));
    for (const open of [() => openDatabase(path), () => new KnowledgeRepository(path), () => new CandidateRepository(db),
      () => new AssetSearchService({ databasePath: path, workspaceConfigPath: join(root, "workspaces.json") })]) {
      assert.throws(open, { code: "DATABASE_VERSION_UNSUPPORTED" });
    }
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schema);
  }
  db.pragma("user_version=2"); db.exec("DROP TABLE asset_candidate");
  assert.throws(() => openDatabase(path), { code: "DATABASE_SCHEMA_INVALID" });
});
