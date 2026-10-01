import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { knowledgeRuntime, initializeDatabase, persistentRows } from "../test-support/knowledge-fixture.js";
import { CandidateService } from "../src/asset/candidate-service.js";
const dist = process.env.PRECEDENT_LOOP_TEST_DIST === "1";
const root = new URL(dist ? "../dist/" : "../src/", import.meta.url);
const assets: typeof import("../src/asset/index.js") = await import(new URL("asset/index.js", root).href);
console.log(`F07_U02_MODULE_ROOT ${root.href}`);
for (const damage of ["missing-fts", "wrong-fts", "wrong-catalog"] as const) {
  test(`F07 actual CLI repairs ${damage}, preserves all runtime rows and current Search/Read`, async () => {
    const f = await fixture();
    try {
      if (damage === "wrong-catalog") f.db.exec("DROP TABLE asset_catalog; CREATE TABLE asset_catalog(broken TEXT)");
      else { f.db.exec("DROP TABLE asset_fts"); if (damage === "wrong-fts") f.db.exec("CREATE TABLE asset_fts(broken TEXT)"); }
      const result = await f.cli(["rebuild-index", "--offline"]);
      assert.equal(result.code, 0, result.stderr);
      f.assertRuntime();
      assert.equal(f.db.prepare("SELECT c.asset_id FROM asset_fts JOIN asset_catalog c ON c.rowid=asset_fts.rowid WHERE asset_fts MATCH 'maintenancetoken'").all().length, 1);
      const search = new assets.AssetSearchService({ ...f.options, refreshIndex: async () => undefined });
      try {
        assert.equal((await search.search({ query: "maintenancetoken", context: { authorizedWorkspaces: [] } })).length, 1);
        assert.match((await search.read({ assetId: f.assetId, context: { authorizedWorkspaces: [] } })).markdown, /maintenancetoken/);
      } finally { search.close(); }
      f.assertRuntime();
    } finally { await f.close(); }
  });
}
test("F07 missing offline acknowledgement, incomplete scan, missing/corrupt DB and busy lock fail without reset", async () => {
  const f = await fixture();
  try {
    const before = f.indexRows();
    assert.equal((await f.cli(["rebuild-index"])).code, 1);
    await unlink(f.options.workspaceConfigPath);
    assert.equal((await f.cli(["rebuild-index", "--offline"])).code, 1);
    assert.deepEqual(f.indexRows(), before); f.assertRuntime();
    await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
    const missing = join(f.directory, "missing.sqlite");
    assert.equal((await f.cli(["rebuild-index", "--offline"], missing)).code, 1);
    await assert.rejects(readFile(missing), { code: "ENOENT" });
    const corrupt = join(f.directory, "corrupt.sqlite");
    await writeFile(corrupt, "not a sqlite database");
    assert.equal((await f.cli(["rebuild-index", "--offline"], corrupt)).code, 1);
    assert.equal(await readFile(corrupt, "utf8"), "not a sqlite database");
    f.db.exec("BEGIN EXCLUSIVE");
    assert.equal((await f.cli(["rebuild-index", "--offline"])).code, 1);
    f.db.exec("ROLLBACK");
    assert.deepEqual(f.indexRows(), before); f.assertRuntime();
  } finally { await f.close(); }
});
test("F07 real CLI rolls back its first DDL deletion if the subsequent Catalog deletion fails", async () => {
  const f = await fixture();
  try {
    f.db.exec("DROP TABLE asset_catalog; CREATE VIEW asset_catalog AS SELECT 'broken' AS asset_id");
    const schema = f.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const rows = f.db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH 'maintenancetoken'").all();
    const result = await f.cli(["rebuild-index", "--offline"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /DROP VIEW/u);
    assert.deepEqual(f.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
    assert.deepEqual(f.db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH 'maintenancetoken'").all(), rows);
    f.assertRuntime();
  } finally { await f.close(); }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-maintenance-"));
  const options = { repositoryPath: join(directory, "repo"), workspaceConfigPath: join(directory, "workspaces.json"), databasePath: join(directory, "db.sqlite") };
  await mkdir(join(options.repositoryPath, "assets/global/memories"), { recursive: true });
  await writeFile(options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  const assetId = new SnowflakeIdGenerator().next("ast");
  const source = `---\nid: ${assetId}\ntype: MEMORY\nscope: GLOBAL\ntitle: maintenancetoken\nsummary: maintenancetoken\n---\nmaintenancetoken\n`;
  await writeFile(join(options.repositoryPath, "assets/global/memories/a.md"), source);
  initializeDatabase(options.databasePath);
  const index = await assets.AssetIndexManager.create(options); await index.synchronize();
  const runtime = knowledgeRuntime(options, () => index.status());
  await writeFile(options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [directory] }] }));
  await runtime.capabilities.issueFromTrustedHost(directory);
  const recall = await runtime.service.recall({ capabilityIds: [], queries: ["maintenancetoken"] });
  const read = await runtime.service.read({ capabilityIds: [], recallItemId: recall.items[0]!.recallItemId });
  await runtime.service.used({ capabilityIds: [], readRef: read.readRef });
  runtime.versions.rotate(assetId, null, Buffer.from("previous"));
  runtime.versions.rotate(assetId, assets.computeContentHash(Buffer.from("previous")), Buffer.from(source));
  const candidates = new CandidateService(options);
  await candidates.initialize();
  await candidates.prepare("maintenance-candidate", [{ title: "pending", summary: "pending", type: "MEMORY", bodyMarkdown: "preserve candidate", target: { scope: "GLOBAL" } }]);
  runtime.close();
  await index.close();
  const db = new Database(options.databasePath);
  db.exec("CREATE TABLE other_runtime(id TEXT PRIMARY KEY, value TEXT); INSERT INTO other_runtime VALUES ('preserve', 'all data')");
  const runtimeRows = () => ({ ...persistentRows(db),
    candidates: db.prepare("SELECT * FROM inbox_candidate ORDER BY rowid").all(),
    operations: db.prepare("SELECT * FROM inbox_operation ORDER BY rowid").all(),
    extra: db.prepare("SELECT * FROM other_runtime").all() });
  const baseline = runtimeRows();
  const cli = (args: string[], databasePath = options.databasePath) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(dist ? [] : ["--import", "tsx"]), fileURLToPath(new URL(`maintenance-cli.${dist ? "js" : "ts"}`, root)), ...args], {
      env: { ...process.env, PRECEDENT_LOOP_DATABASE_PATH: databasePath, PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: options.repositoryPath, PRECEDENT_LOOP_WORKSPACES_PATH: options.workspaceConfigPath }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { directory, options, db, assetId, cli, assertRuntime: () => assert.deepEqual(runtimeRows(), baseline),
    indexRows: () => ({ catalog: db.prepare("SELECT rowid,* FROM asset_catalog").all(), fts: db.prepare("SELECT rowid,* FROM asset_fts").all() }),
    close: async () => { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); await rm(directory, { recursive: true, force: true }); } };
}
