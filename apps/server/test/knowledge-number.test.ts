import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import { AssetCatalog } from "../src/asset/catalog.js";
import { AssetSearchService } from "../src/asset/search.js";
import { scanAssetRepository } from "../src/asset/scanner.js";
import { readKnowledgeNumbers } from "../src/asset/knowledge-number.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { runAssetConfirmationCli } from "../src/asset/confirm-cli.js";
import { candidateFixture, content } from "../test-support/candidate-fixture.js";

async function fixture() {
  const f = await candidateFixture();
  const directory = join(f.options.repositoryPath, "assets/global/memories");
  await mkdir(directory, { recursive: true });
  const db = new Database(f.options.databasePath);
  const catalog = new AssetCatalog(f.options.databasePath);
  const put = async (id: string, body = "正文") => {
    const path = join(directory, `${id}.md`);
    await writeFile(path, `---\nid: ${id}\ntype: MEMORY\nscope: GLOBAL\ntitle: 编号测试\nsummary: 编号摘要\n---\n${body}\n`);
    return path;
  };
  const sync = async () => {
    const snapshot = await scanAssetRepository(f.options);
    assert.equal(snapshot.isComplete, true);
    catalog.applySnapshot(snapshot.assets, snapshot.diagnostics, new Date().toISOString());
    return snapshot;
  };
  return { ...f, db, catalog, put, sync, cleanup: async () => { catalog.close(); db.close(); await f.cleanup(); } };
}

test("first synchronization with an empty number table sorts Snowflake timestamps then ID strings, stays continuous and preserves source bytes", async () => {
  const f = await fixture();
  try {
    // ast100 sorts before ast99 as a string although its numeric value is larger.
    const later = `ast${2n << 150n}`;
    const ids = [later, "ast99", "ast100", `ast${1n << 150n}`];
    const paths = await Promise.all(ids.map(id => f.put(id)));
    const before = await Promise.all(paths.map(path => readFile(path)));
    assert.deepEqual([...readKnowledgeNumbers(f.db)], []);
    await f.sync();
    const expected = [["ast100", 1], ["ast99", 2], [ids[3], 3], [later, 4]];
    assert.deepEqual([...readKnowledgeNumbers(f.db)], expected);
    await f.sync();
    assert.deepEqual([...readKnowledgeNumbers(f.db)], expected);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
    assert.equal(f.db.pragma("user_version", { simple: true }), 1);
    const repository = new KnowledgeRepository(f.options.databasePath); repository.close();
  } finally { await f.cleanup(); }
});

test("version 6 switch SQL preserves an existing Catalog and the first sync numbers all 77 unchanged assets", async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 77 }, (_, index) => `ast${BigInt(77 - index) << 150n}`);
    await Promise.all(ids.map(id => f.put(id)));
    await f.sync();
    const before = f.db.prepare("SELECT * FROM asset_catalog ORDER BY asset_id").all();
    f.db.exec("DROP TABLE asset_knowledge_number; PRAGMA user_version=6");
    // The one-off SQL for the user's stopped local database; never a runtime upgrade path.
    f.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE asset_knowledge_number (
        knowledge_number INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL UNIQUE
      );
      PRAGMA user_version=1;
      COMMIT;`);
    const search = new AssetSearchService({ ...f.options, refreshIndex: async () => {} });
    try {
      assert.deepEqual(f.db.prepare("SELECT * FROM asset_catalog ORDER BY asset_id").all(), before);
      assert.equal((await search.readLibrary(ids[0]!)).knowledgeNumber, null);
      await f.sync();
      assert.deepEqual([...readKnowledgeNumbers(f.db)], [...ids].reverse().map((id, i) => [id, i + 1]));
      for (const query of [{}, { query: "编号测试" }]) {
        const result = await search.listLibrary({ ...query, limit: 100 });
        assert.equal(result.total, 77);
        assert.deepEqual(result.items.map(item => item.knowledgeNumber).sort((a, b) => a! - b!), Array.from({ length: 77 }, (_, i) => i + 1));
      }
      assert.equal((await search.readLibrary(ids[0]!)).knowledgeNumber, 77);
      await f.sync();
      await f.put(`ast${78n << 150n}`); await f.sync();
      assert.equal(readKnowledgeNumbers(f.db).get(`ast${78n << 150n}`), 78);
    } finally { search.close(); }
  } finally { await f.cleanup(); }
});

test("asset:confirm receives a number through the next unified index synchronization", async () => {
  const f = await fixture();
  try {
    await f.service.prepare("confirm-number", [content()]);
    const item = (await f.service.list()).items[0]!;
    await f.sync();
    assert.equal(readKnowledgeNumbers(f.db).get(item.assetId), undefined);
    const output = new PassThrough(); output.resume();
    assert.equal(await runAssetConfirmationCli(["--relative-path", item.relativePath, "--expected-content-hash", item.contentHash], output, output, {
      PRECEDENT_LOOP_DATABASE_PATH: f.options.databasePath,
      PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: f.options.repositoryPath,
      PRECEDENT_LOOP_WORKSPACES_PATH: f.options.workspaceConfigPath,
    }), 0);
    await f.sync();
    assert.equal(readKnowledgeNumbers(f.db).get(item.assetId), 1);
  } finally { await f.cleanup(); }
});

test("sync assigns next numbers, preserves revisions/deletions/ineligibility, rebuild and repeated synchronization", async () => {
  const f = await fixture();
  try {
    await f.put("ast1"); await f.sync();
    await f.put("ast2"); await f.sync();
    await f.put("ast1", "修订正文"); await f.sync();
    await rm(join(f.options.repositoryPath, "assets/global/memories/ast1.md")); await f.sync();
    await f.put("ast3"); await f.sync();
    const invalid = join(f.options.repositoryPath, "assets/global/memories/ast2.md");
    await writeFile(invalid, "不再合格"); await f.sync();
    await f.put("ast4"); await f.sync();
    const expected = [["ast1", 1], ["ast2", 2], ["ast3", 3], ["ast4", 4]];
    assert.deepEqual([...readKnowledgeNumbers(f.db)], expected);
    await f.put("ast1", "重新发现相同身份"); await f.put("ast2");
    const snapshot = await f.sync();
    f.catalog.rebuild(snapshot.assets, new Date().toISOString());
    await f.sync(); await f.sync();
    assert.deepEqual([...readKnowledgeNumbers(f.db)], expected);
    await f.put("ast5");
    const next = await scanAssetRepository(f.options);
    f.catalog.rebuild(next.assets, new Date().toISOString());
    assert.equal(readKnowledgeNumbers(f.db).get("ast5"), 5);
    // A later Catalog failure rolls number allocation back with the same transaction.
    f.db.exec("CREATE TRIGGER fail_number BEFORE INSERT ON asset_knowledge_number WHEN NEW.asset_id='ast6' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await f.put("ast6");
    await assert.rejects(f.sync(), /test failure/);
    assert.equal(f.db.prepare("SELECT 1 FROM asset_catalog WHERE asset_id='ast6'").get(), undefined);
    f.db.exec("DROP TRIGGER fail_number");
    await f.sync(); assert.equal(readKnowledgeNumbers(f.db).get("ast6"), 6);
  } finally { await f.cleanup(); }
});

test("independent processes serialize Catalog number allocation without duplicate numbers or replay gaps", async () => {
  const f = await fixture();
  try {
    await f.put("ast1"); await f.put("ast2");
    const snapshot = await scanAssetRepository(f.options);
    const code = `import { AssetCatalog } from ${JSON.stringify(new URL("../src/asset/catalog.ts", import.meta.url).href)};
      const catalog = new AssetCatalog(process.argv[1]);
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => { for (let i = 0; i < 8; i++) catalog.applySnapshot(JSON.parse(process.argv[2]), [], new Date().toISOString()); catalog.close(); process.exit(0); });`;
    const workers = Array.from({ length: 3 }, () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, f.options.databasePath, JSON.stringify(snapshot.assets)], { stdio: ["pipe", "pipe", "pipe"] });
      let errors = ""; child.stderr.on("data", data => { errors += String(data); });
      const ready = new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", exit => { if (exit !== 0) reject(new Error(errors)); }); });
      const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", exit => exit === 0 ? resolve() : reject(new Error(errors))); });
      return { child, ready, done };
    });
    try {
      await Promise.all(workers.map(worker => worker.ready));
      for (const worker of workers) worker.child.stdin.end("go");
      await Promise.all(workers.map(worker => worker.done));
    } finally { for (const worker of workers) worker.child.kill(); }
    assert.deepEqual([...readKnowledgeNumbers(f.db)], [["ast1", 1], ["ast2", 2]]);
    await f.put("ast3"); await f.sync();
    assert.equal(readKnowledgeNumbers(f.db).get("ast3"), 3);
  } finally { await f.cleanup(); }
});
