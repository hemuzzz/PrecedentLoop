import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import Database from "better-sqlite3";

import {
  AssetIndexManager,
  scanAssetRepository,
  type AssetScanOptions,
  type AssetScanResult,
  type AssetScope,
  type AssetType,
} from "../src/asset/index.js";

const idGenerator = new SnowflakeIdGenerator();
const require = createRequire(import.meta.url);

test("uses the gated better-sqlite3 build with FTS5, trigram, and contentless-delete", () => {
  const packageVersion = (require("better-sqlite3/package.json") as { version: string }).version;
  const database = new Database(":memory:");

  try {
    const sqliteVersion = database.prepare<[], { value: string }>("SELECT sqlite_version() AS value").get()?.value;
    const sqliteSourceId = database.prepare<[], { value: string }>("SELECT sqlite_source_id() AS value").get()?.value;
    const fts5CompileOption = database
      .prepare<[string], { value: number }>("SELECT sqlite_compileoption_used(?) AS value")
      .get("ENABLE_FTS5")?.value;

    assert.equal(packageVersion, "13.0.3");
    assert.equal(sqliteVersion, "3.53.4");
    assert.match(sqliteSourceId ?? "", /^2026-07-24 /);
    assert.equal(fts5CompileOption, 1);

    database.exec(`
      CREATE VIRTUAL TABLE asset_fts USING fts5(
        title,
        summary,
        body,
        content = '',
        contentless_delete = 1,
        tokenize = 'trigram'
      )
    `);
    database
      .prepare<[number, string, string, string]>(
        "INSERT INTO asset_fts (rowid, title, summary, body) VALUES (?, ?, ?, ?)",
      )
      .run(1, "充值回调", "transaction", "正文包含充值回调");

    assert.equal(matchCount(database, "充值回调"), 1);
    assert.equal(matchCount(database, "充"), 0);
    assert.equal(matchCount(database, "充值"), 0);
    database.prepare<[number]>("DELETE FROM asset_fts WHERE rowid = ?").run(1);
    assert.equal(matchCount(database, "充值回调"), 0);
  } finally {
    database.close();
  }
});

test("applies added, changed, moved, replaced, removed, and unchanged Assets incrementally", async () => {
  const fixture = await createFixture();
  const globalId = idGenerator.next("ast");
  const workspaceId = idGenerator.next("ast");
  let now = new Date("2026-09-04T01:00:00.000Z");
  const manager = await AssetIndexManager.create({ ...fixture, now: () => now });
  const globalPath = "assets/global/memories/global.md";
  const movedPath = "assets/global/memories/global-moved.md";
  const workspacePath = "assets/workspaces/alpha/documents/workspace.md";

  try {
    await writeAsset(
      fixture.repositoryPath,
      globalPath,
      assetSource({ body: "正文包含充值回调", id: globalId, scope: "GLOBAL", title: "充值回调规则", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      workspacePath,
      assetSource({
        body: "workspace transaction body",
        id: workspaceId,
        scope: "WORKSPACE",
        title: "Workspace transaction",
        type: "DOCUMENT",
        workspace: "alpha",
      }),
    );

    assert.deepEqual(await manager.synchronize(), {
      added: 2,
      changed: 0,
      invalidated: 0,
      removed: 0,
      unchanged: 0,
    });
    assert.deepEqual(manager.status(), {
      catalogCount: 2,
      diagnostics: [],
      ftsCount: 2,
      indexState: "READY",
      lastSuccessfulScanAt: "2026-09-04T01:00:00.000Z",
      rebuildRequired: false,
      watcherState: "NOT_STARTED",
    });

    const database = new Database(fixture.databasePath);
    try {
      assertFixedSchema(database);
      assert.equal(matchCount(database, "充值回调"), 1);
      assert.equal(matchCount(database, "充值"), 0);
      const initialIndexedAt = catalogRow(database, globalId).indexedAt;

      now = new Date("2026-09-04T01:01:00.000Z");
      assert.deepEqual(await manager.synchronize(), {
        added: 0,
        changed: 0,
        invalidated: 0,
        removed: 0,
        unchanged: 2,
      });
      assert.equal(catalogRow(database, globalId).indexedAt, initialIndexedAt);

      await writeAsset(
        fixture.repositoryPath,
        globalPath,
        assetSource({ body: "正文改为资金结算", id: globalId, scope: "GLOBAL", title: "资金结算规则", type: "MEMORY" }),
      );
      now = new Date("2026-09-04T01:02:00.000Z");
      assert.deepEqual(await manager.synchronize(), {
        added: 0,
        changed: 1,
        invalidated: 0,
        removed: 0,
        unchanged: 1,
      });
      assert.equal(matchCount(database, "充值回调"), 0);
      assert.equal(matchCount(database, "资金结算"), 1);
      assert.equal(catalogRow(database, globalId).indexedAt, "2026-09-04T01:02:00.000Z");

      await rename(join(fixture.repositoryPath, globalPath), join(fixture.repositoryPath, movedPath));
      now = new Date("2026-09-04T01:03:00.000Z");
      assert.equal((await manager.synchronize())?.changed, 1);
      assert.equal(catalogRow(database, globalId).filePath, movedPath);
      assert.equal(matchCount(database, "资金结算"), 1);

      const replacementId = idGenerator.next("ast");
      await writeAsset(
        fixture.repositoryPath,
        movedPath,
        assetSource({ body: "正文改为发票申请", id: replacementId, scope: "GLOBAL", title: "发票申请规则", type: "MEMORY" }),
      );
      now = new Date("2026-09-04T01:04:00.000Z");
      // Reusing a path with a new ID removes one identity and adds another.
      assert.deepEqual(await manager.synchronize(), {
        added: 1,
        changed: 0,
        invalidated: 0,
        removed: 1,
        unchanged: 1,
      });
      assert.equal(catalogRow(database, replacementId).filePath, movedPath);
      assert.equal(catalogCount(database, globalId), 0);
      assert.equal(matchCount(database, "资金结算"), 0);
      assert.equal(matchCount(database, "发票申请"), 1);

      await rm(join(fixture.repositoryPath, movedPath));
      now = new Date("2026-09-04T01:05:00.000Z");
      assert.equal((await manager.synchronize())?.removed, 1);
      assert.equal(matchCount(database, "发票申请"), 0);
      assert.deepEqual(manager.status().catalogCount, 1);
    } finally {
      database.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("invalidates every duplicate, restores repaired Assets, and requalifies all Workspace Assets", async () => {
  const fixture = await createFixture();
  const duplicateId = idGenerator.next("ast");
  const duplicateOnePath = "assets/global/memories/duplicate-one.md";
  const duplicateTwoPath = "assets/global/documents/duplicate-two.md";
  const workspacePaths = [
    "assets/workspaces/alpha/memories/alpha-one.md",
    "assets/workspaces/alpha/skills/alpha-two.md",
  ];
  const manager = await AssetIndexManager.create(fixture);

  try {
    await writeAsset(
      fixture.repositoryPath,
      duplicateOnePath,
      assetSource({ body: "duplicate original", id: duplicateId, scope: "GLOBAL", type: "MEMORY" }),
    );
    assert.equal((await manager.synchronize())?.added, 1);

    await writeAsset(
      fixture.repositoryPath,
      duplicateTwoPath,
      assetSource({ body: "duplicate conflict", id: duplicateId, scope: "GLOBAL", type: "DOCUMENT" }),
    );
    const duplicateResult = await manager.synchronize();
    assert.equal(duplicateResult?.invalidated, 1);
    assert.equal(manager.status().catalogCount, 0);
    assert.equal(
      manager.status().diagnostics.filter(({ code }) => code === "DUPLICATE_ASSET_ID").length,
      2,
    );
    assert.equal(manager.status().indexState, "READY");

    await writeAsset(
      fixture.repositoryPath,
      duplicateTwoPath,
      assetSource({ body: "repaired conflict", id: idGenerator.next("ast"), scope: "GLOBAL", type: "DOCUMENT" }),
    );
    const repairedResult = await manager.synchronize();
    assert.equal(repairedResult?.added, 2);
    assert.equal(manager.status().catalogCount, 2);

    await writeAsset(fixture.repositoryPath, duplicateOnePath, "# invalid without frontmatter\n");
    const invalidResult = await manager.synchronize();
    assert.equal(invalidResult?.invalidated, 1);
    assert.equal(manager.status().catalogCount, 1);
    assert.equal(manager.status().diagnostics.some(({ code }) => code === "MISSING_FRONTMATTER"), true);

    for (const [index, path] of workspacePaths.entries()) {
      await writeAsset(
        fixture.repositoryPath,
        path,
        assetSource({
          body: `workspace body ${index}`,
          id: idGenerator.next("ast"),
          scope: "WORKSPACE",
          type: index === 0 ? "MEMORY" : "SKILL",
          workspace: "alpha",
        }),
      );
    }
    assert.equal((await manager.synchronize())?.added, 2);
    assert.equal(manager.status().catalogCount, 3);

    await writeWorkspaceConfig(fixture.workspaceConfigPath, []);
    const workspaceInvalidation = await manager.synchronize();
    assert.equal(workspaceInvalidation?.invalidated, 2);
    assert.equal(manager.status().catalogCount, 1);
    assert.equal(
      manager.status().diagnostics.filter(({ code }) => code === "UNKNOWN_WORKSPACE").length,
      2,
    );

    await writeWorkspaceConfig(fixture.workspaceConfigPath, ["alpha"]);
    assert.equal((await manager.synchronize())?.added, 2);
    assert.equal(manager.status().catalogCount, 3);
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("keeps the last consistent index for incomplete snapshots and Scanner exceptions", async () => {
  const fixture = await createFixture();
  let throwFromScanner = false;
  const scanner = async (options: AssetScanOptions): Promise<AssetScanResult> => {
    if (throwFromScanner) {
      throw new Error("injected scanner failure");
    }
    return scanAssetRepository(options);
  };
  const manager = await AssetIndexManager.create({ ...fixture, scanner });

  try {
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/stable.md",
      assetSource({ body: "stable searchable body", id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );
    await manager.synchronize();
    const successfulAt = manager.status().lastSuccessfulScanAt;

    await rm(fixture.workspaceConfigPath);
    assert.equal(await manager.synchronize(), null);
    assert.equal(manager.status().indexState, "DEGRADED");
    assert.equal(manager.status().catalogCount, 1);
    assert.equal(manager.status().lastSuccessfulScanAt, successfulAt);
    assert.equal(
      manager.status().diagnostics.some(({ code }) => code === "INCOMPLETE_SCAN_SNAPSHOT"),
      true,
    );

    await writeWorkspaceConfig(fixture.workspaceConfigPath, ["alpha"]);
    await manager.synchronize();
    assert.equal(manager.status().indexState, "READY");

    throwFromScanner = true;
    assert.equal(await manager.synchronize(), null);
    assert.equal(manager.status().indexState, "DEGRADED");
    assert.equal(manager.status().catalogCount, 1);
    assert.equal(manager.status().diagnostics.some(({ code }) => code === "SCANNER_EXCEPTION"), true);

    throwFromScanner = false;
    const hiddenAssetsPath = join(fixture.rootPath, "assets-temporarily-unavailable");
    await rename(join(fixture.repositoryPath, "assets"), hiddenAssetsPath);
    assert.equal(await manager.synchronize(), null);
    assert.equal(manager.status().catalogCount, 1);
    await rename(hiddenAssetsPath, join(fixture.repositoryPath, "assets"));
    await manager.synchronize();
    assert.equal(manager.status().indexState, "READY");
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("rolls back Catalog and FTS together when an incremental insert fails", async () => {
  const fixture = await createFixture();
  const assetId = idGenerator.next("ast");
  const assetPath = "assets/global/memories/rollback.md";
  const manager = await AssetIndexManager.create(fixture);

  try {
    await writeAsset(
      fixture.repositoryPath,
      assetPath,
      assetSource({ body: "old rollback content", id: assetId, scope: "GLOBAL", title: "Old rollback title", type: "MEMORY" }),
    );
    await manager.synchronize();

    const database = new Database(fixture.databasePath);
    try {
      database.exec(`
        CREATE TRIGGER reject_catalog_insert
        BEFORE INSERT ON asset_catalog
        BEGIN
          SELECT RAISE(ABORT, 'injected catalog failure');
        END
      `);
      const oldHash = catalogRow(database, assetId).contentHash;

      await writeAsset(
        fixture.repositoryPath,
        assetPath,
        assetSource({ body: "new rollback content", id: assetId, scope: "GLOBAL", title: "New rollback title", type: "MEMORY" }),
      );
      assert.equal(await manager.synchronize(), null);
      assert.equal(manager.status().indexState, "DEGRADED");
      assert.equal(catalogRow(database, assetId).title, "Old rollback title");
      assert.equal(catalogRow(database, assetId).contentHash, oldHash);
      assert.equal(matchCount(database, "old rollback"), 1);
      assert.equal(matchCount(database, "new rollback"), 0);
      assert.equal(manager.status().diagnostics.some(({ code }) => code === "INDEX_UPDATE_FAILED"), true);

      database.exec("DROP TRIGGER reject_catalog_insert");
      assert.equal((await manager.synchronize())?.changed, 1);
      assert.equal(manager.status().indexState, "READY");
      assert.equal(matchCount(database, "old rollback"), 0);
      assert.equal(matchCount(database, "new rollback"), 1);
    } finally {
      database.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("requires and performs a full rebuild for incompatible or inconsistent SQLite state", async () => {
  const fixture = await createFixture();
  await writeAsset(
    fixture.repositoryPath,
    "assets/global/memories/rebuild.md",
    assetSource({ body: "rebuild content", id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
  );

  await mkdir(dirname(fixture.databasePath), { recursive: true });
  const incompatibleDatabase = new Database(fixture.databasePath);
  incompatibleDatabase.exec("DROP TABLE asset_catalog; CREATE TABLE asset_catalog (asset_id TEXT PRIMARY KEY)");
  incompatibleDatabase.close();

  const manager = await AssetIndexManager.create(fixture);
  try {
    assert.equal(manager.status().indexState, "REBUILD_REQUIRED");
    assert.equal(manager.status().rebuildRequired, true);
    assert.equal(await manager.synchronize(), null);

    assert.equal((await manager.rebuild())?.added, 1);
    assert.equal(manager.status().indexState, "READY");
    assert.equal(manager.status().catalogCount, 1);
    assert.equal(manager.status().ftsCount, 1);

    const database = new Database(fixture.databasePath);
    try {
      assertFixedSchema(database);
      database.exec("DELETE FROM asset_fts");
      assert.equal(manager.status().indexState, "REBUILD_REQUIRED");
      assert.equal(manager.status().rebuildRequired, true);
      assert.equal((await manager.rebuild())?.added, 1);
      assert.equal(manager.status().indexState, "READY");
      assert.equal(manager.status().ftsCount, 1);
    } finally {
      database.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("debounces Markdown events and watches workspaces.json deletion and reappearance", async () => {
  const fixture = await createFixture();
  const watchedGlobalId = idGenerator.next("ast");
  const watchedGlobalPath = "assets/global/memories/watched-global.md";
  let scanCount = 0;
  const scanner = async (options: AssetScanOptions): Promise<AssetScanResult> => {
    scanCount += 1;
    return scanAssetRepository(options);
  };
  const manager = await AssetIndexManager.create({ ...fixture, debounceMs: 80, scanner });

  try {
    await writeAsset(
      fixture.repositoryPath,
      watchedGlobalPath,
      assetSource({ body: "watched global", id: watchedGlobalId, scope: "GLOBAL", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/memories/watched-workspace.md",
      assetSource({
        body: "watched workspace",
        id: idGenerator.next("ast"),
        scope: "WORKSPACE",
        type: "MEMORY",
        workspace: "alpha",
      }),
    );

    const started = await manager.start();
    assert.equal(started.indexState, "READY");
    assert.equal(started.watcherState, "RUNNING");
    assert.equal(scanCount, 2);

    await Promise.all(
      [0, 1, 2].map((index) =>
        writeAsset(
          fixture.repositoryPath,
          `assets/global/documents/batched-${index}.md`,
          assetSource({ body: `batched body ${index}`, id: idGenerator.next("ast"), scope: "GLOBAL", type: "DOCUMENT" }),
        ),
      ),
    );
    await waitFor(() => manager.status().catalogCount === 5);
    await delay(240);
    assert.equal(scanCount, 3);

    await rm(fixture.workspaceConfigPath);
    await waitFor(() => manager.status().indexState === "DEGRADED");
    assert.equal(manager.status().catalogCount, 5);

    await writeWorkspaceConfig(fixture.workspaceConfigPath, []);
    await waitFor(() => manager.status().indexState === "READY" && manager.status().catalogCount === 4);
    assert.equal(manager.status().watcherState, "RUNNING");
    assert.equal(manager.status().diagnostics.some(({ code }) => code === "UNKNOWN_WORKSPACE"), true);

    const database = new Database(fixture.databasePath);
    try {
      let previousScanCount = scanCount;
      await writeAsset(
        fixture.repositoryPath,
        watchedGlobalPath,
        assetSource({ body: "modified watcher body", id: watchedGlobalId, scope: "GLOBAL", type: "MEMORY" }),
      );
      await waitFor(() => scanCount > previousScanCount && matchCount(database, "modified watcher") === 1);

      previousScanCount = scanCount;
      const renamedPath = "assets/global/memories/watched-global-renamed.md";
      await rename(join(fixture.repositoryPath, watchedGlobalPath), join(fixture.repositoryPath, renamedPath));
      await waitFor(
        () => scanCount > previousScanCount && catalogRow(database, watchedGlobalId).filePath === renamedPath,
      );

      previousScanCount = scanCount;
      await rm(join(fixture.repositoryPath, renamedPath));
      await waitFor(
        () => scanCount > previousScanCount && catalogCount(database, watchedGlobalId) === 0,
      );
    } finally {
      database.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

interface Fixture {
  databasePath: string;
  repositoryPath: string;
  rootPath: string;
  workspaceConfigPath: string;
}

interface AssetSourceOptions {
  body: string;
  id: string;
  scope: AssetScope;
  summary?: string;
  title?: string;
  type: AssetType;
  workspace?: string;
}

interface CatalogRecord {
  contentHash: string;
  filePath: string;
  indexedAt: string;
  title: string;
}

async function createFixture(): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n04-"));
  const repositoryPath = join(rootPath, "asset-repository");
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  const databasePath = join(rootPath, "data", "precedent-loop.sqlite");
  await mkdir(join(repositoryPath, "assets"), { recursive: true });
  await writeWorkspaceConfig(workspaceConfigPath, ["alpha"]);
  initializeDatabase(databasePath);
  return { databasePath, repositoryPath, rootPath, workspaceConfigPath };
}

function assetSource(options: AssetSourceOptions): string {
  const fields = [
    `id: ${options.id}`,
    `type: ${options.type}`,
    `scope: ${options.scope}`,
  ];
  if (options.workspace !== undefined) {
    fields.push(`workspace: ${options.workspace}`);
  }
  fields.push(
    `title: ${options.title ?? `${options.type} title`}`,
    `summary: ${options.summary ?? `${options.type} summary`}`,
  );
  return ["---", ...fields, "---", options.body, ""].join("\n");
}

async function writeAsset(repositoryPath: string, relativePath: string, source: string): Promise<void> {
  const absolutePath = join(repositoryPath, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}

async function writeWorkspaceConfig(configPath: string, workspaces: readonly string[]): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: workspaces.map((name) => ({ name, paths: [`/workspace/${name}`] })),
    }),
    "utf8",
  );
}

function assertFixedSchema(database: Database.Database): void {
  const catalogSql = database
    .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get("asset_catalog")?.sql;
  const ftsSql = database
    .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get("asset_fts")?.sql;
  assert.match(catalogSql ?? "", /file_path\s+TEXT NOT NULL UNIQUE/);
  assert.match(ftsSql ?? "", /contentless_delete\s*=\s*1/);
  assert.match(ftsSql ?? "", /tokenize\s*=\s*'trigram'/);
}

function catalogRow(database: Database.Database, assetId: string): CatalogRecord {
  const row = database
    .prepare<[string], CatalogRecord>(`
      SELECT
        content_hash AS contentHash,
        file_path AS filePath,
        indexed_at AS indexedAt,
        title
      FROM asset_catalog
      WHERE asset_id = ?
    `)
    .get(assetId);
  assert.ok(row, `Missing Catalog row for ${assetId}`);
  return row;
}

function catalogCount(database: Database.Database, assetId: string): number {
  return (
    database
      .prepare<[string], { count: number }>("SELECT count(*) AS count FROM asset_catalog WHERE asset_id = ?")
      .get(assetId)?.count ?? -1
  );
}

function matchCount(database: Database.Database, query: string): number {
  return (
    database
      .prepare<[string], { count: number }>("SELECT count(*) AS count FROM asset_fts WHERE asset_fts MATCH ?")
      .get(query)?.count ?? -1
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
