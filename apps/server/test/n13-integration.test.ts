import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { knowledgeRuntime, initializeDatabase, persistentRows } from "../test-support/knowledge-fixture.js";

import {
  AssetCatalog,
  AssetIndexManager,
  scanAssetRepository,
  AssetSearchService,
  InboxApplicationService,
  computeContentHash,
  confirmInboxAsset,
  type AssetScope,
  type AssetType,
} from "../src/asset/index.js";

const idGenerator = new SnowflakeIdGenerator();

test("N13 proves the synthetic M03/M04 Inbox contract, Watcher recovery, and SQLite rebuild boundary", async () => {
  const fixture = await createFixture("migration-bridge");
  const assetId = idGenerator.next("ast");
  const sourceRelativePath = "inbox/workspaces/alpha/memories/migration-bridge.md";
  const targetRelativePath = "assets/workspaces/alpha/memories/migration-bridge.md";
  const initialSource = assetSource({
    body: "migrationbridge original current Markdown",
    id: assetId,
    scope: "WORKSPACE",
    summary: "synthetic M03 M04 bridge without legacy identifiers",
    title: "Synthetic migration bridge",
    type: "MEMORY",
    workspace: "alpha",
  });
  await writeAsset(fixture.repositoryPath, sourceRelativePath, initialSource);
  await writeAsset(
    fixture.repositoryPath,
    "inbox/workspaces/unknown/memories/unrelated.md",
    assetSource({
      body: "unrelated diagnostic",
      id: idGenerator.next("ast"),
      scope: "WORKSPACE",
      title: "Unknown Workspace candidate",
      type: "MEMORY",
      workspace: "unknown",
    }),
  );

  await mkdir(dirname(fixture.databasePath), { recursive: true });
  initializeDatabase(fixture.databasePath);
  let manager = await AssetIndexManager.create({ ...fixture, debounceMs: 40 });
  let service: AssetSearchService | undefined;
  try {
    await manager.start();
    service = new AssetSearchService({
      ...fixture,
      refreshIndex: async () => await manager.synchronize(),
    });
    const inbox = new InboxApplicationService(fixture, service);
    const before = await inbox.scan();
    assert.deepEqual(before.items.map(({ assetId: id }) => id), [assetId]);
    assert.equal(before.diagnostics.some(({ code }) => code === "UNKNOWN_WORKSPACE"), true);
    assert.deepEqual(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }), []);

    const bytes = Buffer.from(initialSource, "utf8");
    const expectedContentHash = createHash("sha256").update(bytes).digest("hex");
    const confirmed = await confirmInboxAsset({
      relativePath: sourceRelativePath,
      expectedContentHash,
    }, fixture);
    assert.equal(confirmed.assetId, assetId);
    assert.equal(confirmed.targetRelativePath, targetRelativePath);
    assert.deepEqual(await readFile(join(fixture.repositoryPath, targetRelativePath)), bytes);
    await assert.rejects(readFile(join(fixture.repositoryPath, sourceRelativePath)), { code: "ENOENT" });
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }))?.[0]?.assetId === assetId
    );
    assert.equal((await inbox.scan()).items.some(({ assetId: id }) => id === assetId), false);
    assert.match(
      (await service.read({ assetId, context: { authorizedWorkspaces: ["alpha"] } })).markdown,
      /migrationbridge original/u,
    );
    assert.deepEqual(await service.search({ context: { authorizedWorkspaces: ["beta"] }, query: "migrationbridge" }), []);

    const modified = initialSource.replace("original", "modified");
    await writeFile(join(fixture.repositoryPath, targetRelativePath), modified, "utf8");
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "modified" }))?.[0]?.assetId === assetId
    );
    const modifiedRead = await service.read({ assetId, context: { authorizedWorkspaces: ["alpha"] } });
    assert.equal(modifiedRead.contentHash, computeContentHash(Buffer.from(modified, "utf8")));

    await writeFile(join(fixture.repositoryPath, targetRelativePath), "# invalid without Frontmatter\n", "utf8");
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "modified" }))?.length === 0
    );
    assert.equal(manager.status().diagnostics.some(({ code }) => code === "MISSING_FRONTMATTER"), true);

    const repaired = initialSource.replace("original", "repaired");
    await writeFile(join(fixture.repositoryPath, targetRelativePath), repaired, "utf8");
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "repaired" }))?.[0]?.assetId === assetId
    );

    await writeFile(fixture.workspaceConfigPath, "{invalid", "utf8");
    await waitFor(() => manager.status().indexState === "DEGRADED");
    assert.equal(manager.status().catalogCount, 1);
    await writeWorkspaceConfig(fixture);
    await waitFor(() => manager.status().indexState === "READY");

    await rm(join(fixture.repositoryPath, targetRelativePath));
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "repaired" }))?.length === 0
    );
    await writeAsset(fixture.repositoryPath, targetRelativePath, repaired);
    await waitFor(async () =>
      (await service?.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "repaired" }))?.[0]?.assetId === assetId
    );

    const runtime = knowledgeRuntime(fixture, () => manager.status());
    let baseline;
    try {
      const alpha = (await runtime.capabilities.issueFromTrustedHost(fixture.alphaWorkspacePath))[0]!.capabilityId;
      const recall = await runtime.service.recall({ capabilityIds: [alpha], queries: ["migrationbridge"] });
      const read = await runtime.service.read({ capabilityIds: [alpha], recallItemId: recall.items[0]!.recallItemId });
      await runtime.service.used({ capabilityIds: [alpha], readRef: read.readRef });
      baseline = persistentRows(runtime.repository.db);
      assert.ok(baseline.asset_content_version!.length > 0);
    } finally { runtime.close(); }
    service.close(); service = undefined; await manager.close();
    // Rebuild only Catalog/FTS. Deleting SQLite would destroy durable facts and versions.
    const catalog = new AssetCatalog(fixture.databasePath, { maintenance: true });
    try { catalog.rebuild((await scanAssetRepository(fixture)).assets, new Date().toISOString()); }
    finally { catalog.close(); }

    manager = await AssetIndexManager.create({ ...fixture, debounceMs: 40 });
    await manager.start();
    service = new AssetSearchService({
      ...fixture,
      refreshIndex: async () => await manager.synchronize(),
    });
    assert.equal(
      (await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }))[0]?.assetId,
      assetId,
    );
    const rebuilt = knowledgeRuntime(fixture, () => manager.status());
    try { assert.deepEqual(persistentRows(rebuilt.repository.db), baseline); }
    finally { rebuilt.close(); }
  } finally {
    service?.close();
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

interface Fixture {
  alphaWorkspacePath: string;
  betaWorkspacePath: string;
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

async function createFixture(name: string): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), `precedent-loop-n13-${name}-`));
  const fixture = {
    alphaWorkspacePath: join(rootPath, "workspaces", "alpha"),
    betaWorkspacePath: join(rootPath, "workspaces", "beta"),
    databasePath: join(rootPath, "data", "precedent-loop.sqlite"),
    repositoryPath: join(rootPath, "asset-repository"),
    rootPath,
    workspaceConfigPath: join(rootPath, "config", "workspaces.json"),
  };
  await Promise.all([
    mkdir(join(fixture.repositoryPath, "assets"), { recursive: true }),
    mkdir(fixture.alphaWorkspacePath, { recursive: true }),
    mkdir(fixture.betaWorkspacePath, { recursive: true }),
  ]);
  await writeWorkspaceConfig(fixture);
  return fixture;
}

async function writeWorkspaceConfig(fixture: Fixture): Promise<void> {
  await writeFixture(fixture.workspaceConfigPath, JSON.stringify({
    schemaVersion: 1,
    workspaces: [
      { name: "alpha", paths: [fixture.alphaWorkspacePath] },
      { name: "beta", paths: [fixture.betaWorkspacePath] },
    ],
  }));
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
  await writeFixture(join(repositoryPath, relativePath), source);
}

async function writeFixture(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for N13 condition${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}
