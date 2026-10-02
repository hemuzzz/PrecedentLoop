const assert = require("node:assert/strict");
const { unlinkSync, readFileSync } = require("node:fs");

async function main() {
  const databasePath = process.argv[2];
  assert.ok(databasePath, "database path is required");

  const BetterSqlite3 = require("better-sqlite3");
  const imported = await import("better-sqlite3");
  assert.equal(imported.default, BetterSqlite3);

  const packageVersion = require("better-sqlite3/package.json").version;
  const memoryDatabase = new BetterSqlite3(":memory:");
  memoryDatabase.close();

  const fileDatabase = new BetterSqlite3(databasePath);
  fileDatabase.exec("CREATE TABLE open_close_probe (value INTEGER NOT NULL)");
  fileDatabase.close();

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const database = new BetterSqlite3(databasePath);
    assert.equal(database.prepare("SELECT count(*) AS count FROM open_close_probe").get().count, 0);
    database.close();
  }

  const database = new BetterSqlite3(databasePath);
  const sqliteVersion = database.prepare("SELECT sqlite_version() AS value").get().value;
  const sqliteSourceId = database.prepare("SELECT sqlite_source_id() AS value").get().value;
  const fts5CompileOption = database
    .prepare("SELECT sqlite_compileoption_used(?) AS value")
    .get("ENABLE_FTS5").value;

  database.exec(readFileSync(require("node:path").join(__dirname, "../src/storage/schema.sql"), "utf8"));
  const insertAsset = database.prepare("INSERT INTO asset(asset_id,asset_type,asset_scope,title,summary,body_markdown) VALUES (?,'MEMORY','GLOBAL',?,?,?)");
  const insertFts = database.prepare("INSERT INTO asset_fts(asset_id,title,summary,body_markdown) VALUES (?,?,?,?)");
  const matchCount = database.prepare("SELECT count(*) AS count FROM asset_fts WHERE asset_fts MATCH ?");
  const assetId = "ast1000000000000000001";
  insertAsset.run(assetId, "充值回调规则", "callback transaction", "正文包含充值回调和callback transaction");
  insertFts.run(assetId, "充值回调规则", "callback transaction", "正文包含充值回调和callback transaction");

  assert.equal(matchCount.get("充值回调").count, 1);
  assert.equal(matchCount.get("callback").count, 1);
  assert.equal(matchCount.get("充").count, 0);
  assert.equal(matchCount.get("充值").count, 0);

  database.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(assetId);
  assert.equal(matchCount.get("充值回调").count, 0);

  insertFts.run(assetId, "资金结算规则", "settlement transaction", "新正文包含资金结算和settlement transaction");
  assert.equal(matchCount.get("充值回调").count, 0);
  assert.equal(matchCount.get("资金结算").count, 1);

  const replaceTransaction = database.transaction(() => {
    database.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(assetId);
    database.prepare("UPDATE asset SET title='发票申请规则' WHERE asset_id=?").run(assetId);
    insertFts.run(assetId, "发票申请规则", "invoice transaction", "新正文包含发票申请和invoice transaction");
    throw new Error("intentional rollback");
  });

  assert.throws(replaceTransaction, /intentional rollback/);
  assert.equal(database.prepare("SELECT title FROM asset WHERE asset_id = ?").get(assetId).title, "充值回调规则");
  assert.equal(matchCount.get("资金结算").count, 1);
  assert.equal(matchCount.get("发票申请").count, 0);

  database.close();
  unlinkSync(databasePath);

  process.stdout.write(
    `${JSON.stringify({
      architecture: process.arch,
      betterSqlite3Version: packageVersion,
      ordinaryFtsAvailable: true,
      deletePassed: true,
      fts5Available: true,
      fts5CompileOption,
      importPassed: true,
      insertPassed: true,
      matchPassed: true,
      nodeVersion: process.version,
      oneCharacterMatchCount: 0,
      openCloseStable: true,
      platform: process.platform,
      reinsertPassed: true,
      requirePassed: true,
      rollbackPassed: true,
      sqliteSourceId,
      sqliteVersion,
      threeOrMoreCharacterMatchCount: 1,
      trigramAvailable: true,
      twoCharacterMatchCount: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
