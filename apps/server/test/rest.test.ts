import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import { createApp } from "../src/app.js";
import {
  AssetIndexManager,
  type AssetIndexStatus,
  type AssetType,
} from "../src/asset/index.js";
import {
  OverviewApplicationService,
  HubAssetApplicationService,
  SystemStatusApplicationService,
} from "../src/http/index.js";

import { knowledgeRuntime, initializeDatabase, persistentRows } from "../test-support/knowledge-fixture.js";

const AUTHORITY = "127.0.0.1:3210";

type RestFixture = Awaited<ReturnType<typeof createFixture>>;

test("number synchronization preserves Recall/Read/Used and keeps numbers out of model-visible results", async () => {
  const fixture = await createFixture();
  try {
    const before = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge alpha"] });
    assert.ok(before.items.length > 0);
    const read = await fixture.service.read({ capabilityIds: [fixture.alpha], recallItemId: before.items[0]!.recallItemId });
    const rows = fixture.rows();
    await fixture.indexManager.synchronize();
    assert.deepEqual(fixture.rows(), rows);
    await fixture.service.used({ capabilityIds: [fixture.alpha], recallItemId: before.items[0]!.recallItemId });
    const after = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge alpha"] });
    assert.ok(after.items.length > 0);
    assert.equal(after.items[0]!.assetId, before.items[0]!.assetId);
    for (const result of [before, read, after]) assert.equal(JSON.stringify(result).includes("knowledgeNumber"), false);
    const response = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(response.status, 200);
    assert.equal(typeof (dataObject(response.body).asset as Record<string, unknown>).knowledgeNumber, "number");
  } finally { await fixture.close(); }
});

test("N09 Asset Library enforces full-library Workspace filters, strict parameters, and stable sorting", async () => {
  const fixture = await createFixture();
  try {
    const all = await getJson(fixture, "/api/assets");
    assert.equal(all.status, 200);
    assert.equal(all.body.ok, true);
    assert.deepEqual(
      dataItems(all.body).map((item) => item.assetId),
      [fixture.globalAssetId, fixture.betaAssetId, fixture.alphaAssetId],
    );

    assert.deepEqual(
      dataItems((await getJson(fixture, "/api/assets?workspace=null")).body).map((item) => item.assetId),
      [fixture.globalAssetId],
    );
    assert.deepEqual(
      dataItems((await getJson(fixture, "/api/assets?workspace=alpha")).body).map((item) => item.assetId),
      [fixture.globalAssetId, fixture.alphaAssetId],
    );
    assert.deepEqual(
      dataItems((await getJson(fixture, "/api/assets?workspace=alpha&scope=WORKSPACE")).body).map((item) => item.assetId),
      [fixture.alphaAssetId],
    );
    assert.deepEqual(
      new Set(dataItems((await getJson(fixture, "/api/assets?scope=WORKSPACE")).body).map((item) => item.assetId)),
      new Set([fixture.alphaAssetId, fixture.betaAssetId]),
    );

    const specificSearch = dataItems(
      (await getJson(fixture, "/api/assets?query=shared%20knowledge&workspace=alpha")).body,
    );
    assert.equal(specificSearch[0]?.assetId, fixture.alphaAssetId);
    assert.equal(specificSearch[0]?.searchStrategy, "FTS");
    assert.equal(typeof specificSearch[0]?.score, "number");

    const fullSearch = dataItems((await getJson(fixture, "/api/assets?query=shared%20knowledge")).body);
    assert.equal(fullSearch[0]?.assetId, fixture.globalAssetId);

    for (const path of [
      "/api/assets?workspace=null&scope=WORKSPACE",
      "/api/assets?workspace=alpha&scope=GLOBAL",
    ]) {
      const response = await getJson(fixture, path);
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), "INVALID_FILTER_COMBINATION");
    }
    for (const path of [
      "/api/assets?unknown=x",
      "/api/assets?limit=1&limit=2",
      "/api/assets?query=",
      "/api/assets?limit=0",
      "/api/assets?limit=101",
      "/api/assets?type=memory",
    ]) {
      assert.equal((await getJson(fixture, path)).status, 400, path);
    }
    assert.equal(dataItems((await getJson(fixture, "/api/assets?limit=1")).body).length, 1);

    const bulkPath = join(fixture.repositoryPath, "assets/global/documents");
    await mkdir(bulkPath, { recursive: true });
    for (let index = 0; index < 101; index += 1) {
      await writeAsset(join(bulkPath, `bulk-${index}.md`), {
        id: fixture.idGenerator.next("ast"),
        type: "DOCUMENT",
        scope: "GLOBAL",
        title: `Bulk ${index}`,
        summary: "default and maximum limit",
        body: "bulk",
      });
    }
    await fixture.indexManager.synchronize();
    assert.equal(dataItems((await getJson(fixture, "/api/assets")).body).length, 20);
    assert.equal(dataItems((await getJson(fixture, "/api/assets?limit=100")).body).length, 100);
  } finally {
    await fixture.close();
  }
});

test("N09 Asset Detail returns current Markdown, aggregates Usage, returns recent Recall/Read/Used facts, and fails stale closed", async () => {
  const fixture = await createFixture();
  try {
    for (let index = 0; index < 12; index += 1) {
      const recall = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge alpha"] });
      const recallItemId = recall.items[0]!.recallItemId;
      assert.equal(recall.items[0]!.assetId, fixture.alphaAssetId);
      if (index % 2 === 0) await fixture.service.read({ capabilityIds: [fixture.alpha], recallItemId });
      if (index % 3 === 0) await fixture.service.used({ capabilityIds: [fixture.alpha], recallItemId });
    }
    const before = fixture.rows();

    const response = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(response.status, 200);
    const asset = dataObject(response.body).asset as Record<string, unknown>;
    assert.equal(asset.assetId, fixture.alphaAssetId);
    assert.equal(Object.hasOwn(asset, "currentEligibility"), false);
    assert.match(String(asset.rawMarkdown), /shared knowledge/u);
    assert.match(String(asset.renderedMarkdown), /<p>/u);
    assert.equal(String(asset.relativePath).startsWith("assets/"), true);
    assert.deepEqual(asset.usageSummary, {
      recallCount: 12,
      readCount: 6,
      totalUsedCount: 4,
    });
    const recent = asset.recentRecalls as Array<Record<string, unknown>>;
    assert.equal(recent.length, 12);
    assert.ok(recent.every(item => item.assetId === fixture.alphaAssetId && typeof item.recallItemId === "string"));
    const usage = asset.recentUsage as Array<Record<string, unknown>>;
    assert.equal(usage.length, 10);
    assert.equal(usage.filter(item => item.kind === "READ").length, 6);
    assert.equal(usage.filter(item => item.kind === "USED").length, 4);
    assert.deepEqual(fixture.rows(), before);

    assert.equal((await getJson(fixture, "/api/assets/not-an-id")).status, 400);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.idGenerator.next("ast")}`)).status, 404);

    await writeAsset(fixture.alphaAssetPath, {
      id: fixture.alphaAssetId,
      type: "MEMORY",
      scope: "WORKSPACE",
      workspace: "alpha",
      title: "Alpha changed",
      summary: "Changed projection",
      body: "changed body",
    });
    const stale = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(stale.status, 409);
    assert.equal(errorCode(stale.body), "ASSET_STALE");
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 200);

    const movedPath = join(fixture.repositoryPath, "assets/workspaces/alpha/memories/moved.md");
    await rename(fixture.alphaAssetPath, movedPath);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 409);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 200);

    await writeFile(movedPath, "---\nid: invalid\n---\ninvalid", "utf8");
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 409);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 404);

    await unlink(fixture.betaAssetPath);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.betaAssetId}`)).status, 409);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.betaAssetId}`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test("Asset Detail renders CJK emphasis while preserving ordinary emphasis and disabled HTML/linkify/typographer", async () => {
  const fixture = await createFixture();
  try {
    await writeAsset(fixture.alphaAssetPath, {
      id: fixture.alphaAssetId, type: "MEMORY", scope: "WORKSPACE", workspace: "alpha",
      title: "Markdown rendering", summary: "Rendering regression",
      body: '**触发：**用户明确要求\n\n**ordinary bold**\n\n<script>alert("x")</script>\n\nhttps://example.com\n\n"quotes" -- ...\n\n| 左 | 右 |\n| :--- | ---: |\n| 文本 | 内容 |',
    });
    await fixture.indexManager.synchronize();
    const response = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(response.status, 200);
    const asset = dataObject(response.body).asset as Record<string, unknown>;
    const html = String(asset.renderedMarkdown);
    assert.match(html, /<strong>触发：<\/strong>用户明确要求/u);
    assert.match(html, /<strong>ordinary bold<\/strong>/u);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>|<a /u);
    assert.match(html, /&quot;quotes&quot; -- \.\.\./u);
    assert.match(html, /<th style="text-align:left">左<\/th>/u);
    assert.match(html, /<th style="text-align:right">右<\/th>/u);
    assert.match(String(asset.rawMarkdown), /\*\*触发：\*\*用户明确要求/u);
  } finally {
    await fixture.close();
  }
});

test("N09 Inbox scans live candidates, treats a missing directory as empty, and isolates ID conflicts", async () => {
  const fixture = await createFixture();
  try {
    const empty = await getJson(fixture, "/api/inbox");
    assert.equal(empty.status, 200);
    assert.deepEqual(dataObject(empty.body), { items: [], diagnostics: [] });

    const inboxPath = join(fixture.repositoryPath, "inbox/global/memories");
    await mkdir(inboxPath, { recursive: true });
    const validId = fixture.idGenerator.next("ast");
    const duplicateId = fixture.idGenerator.next("ast");
    await writeAsset(join(inboxPath, "valid.md"), {
      id: validId,
      type: "MEMORY",
      scope: "GLOBAL",
      title: "Inbox valid",
      summary: "Valid candidate",
      body: "candidate",
    });
    await writeAsset(join(inboxPath, "formal-conflict.md"), {
      id: fixture.globalAssetId,
      type: "MEMORY",
      scope: "GLOBAL",
      title: "Conflict",
      summary: "Conflicts with formal",
      body: "conflict",
    });
    for (const name of ["duplicate-a.md", "duplicate-b.md"]) {
      await writeAsset(join(inboxPath, name), {
        id: duplicateId,
        type: "MEMORY",
        scope: "GLOBAL",
        title: name,
        summary: "duplicate",
        body: "duplicate",
      });
    }
    await writeFile(join(inboxPath, "invalid.md"), "---\ntype: MEMORY\n---\ninvalid", "utf8");
    await writeFile(join(inboxPath, "note.txt"), "not markdown", "utf8");
    await mkdir(join(inboxPath, "directory-asset"));
    await symlink(fixture.globalAssetPath, join(inboxPath, "linked.md"));
    const unknownWorkspacePath = join(fixture.repositoryPath, "inbox/workspaces/unknown/memories");
    await mkdir(unknownWorkspacePath, { recursive: true });
    await writeAsset(join(unknownWorkspacePath, "unknown.md"), {
      id: fixture.idGenerator.next("ast"),
      type: "MEMORY",
      scope: "WORKSPACE",
      workspace: "unknown",
      title: "Unknown workspace",
      summary: "unknown",
      body: "unknown",
    });
    await writeAsset(join(inboxPath, "type-conflict.md"), {
      id: fixture.idGenerator.next("ast"),
      type: "DOCUMENT",
      scope: "GLOBAL",
      title: "Type conflict",
      summary: "type conflict",
      body: "conflict",
    });

    const response = await getJson(fixture, "/api/inbox");
    assert.equal(response.status, 200);
    const data = dataObject(response.body);
    const items = data.items as Array<Record<string, unknown>>;
    const diagnostics = data.diagnostics as Array<Record<string, unknown>>;
    assert.deepEqual(items.map(({ assetId }) => assetId), [validId]);
    assert.equal(diagnostics.some(({ code }) => code === "ID_CONFLICT"), true);
    assert.equal(diagnostics.some(({ code }) => code === "DUPLICATE_ASSET_ID"), true);
    assert.equal(diagnostics.some(({ code }) => code === "INVALID_FRONTMATTER"), true);
    assert.equal(diagnostics.some(({ code }) => code === "NON_MARKDOWN_FILE"), true);
    assert.equal(diagnostics.some(({ code }) => code === "DIRECTORY_ASSET"), true);
    assert.equal(diagnostics.some(({ code }) => code === "SYMLINK"), true);
    assert.equal(diagnostics.some(({ code }) => code === "UNKNOWN_WORKSPACE"), true);
    assert.equal(diagnostics.some(({ code }) => code === "PATH_TYPE_MISMATCH"), true);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.globalAssetId}`)).status, 200);

    const unavailableRepositoryPath = `${fixture.repositoryPath}-unavailable`;
    await rename(fixture.repositoryPath, unavailableRepositoryPath);
    assert.equal((await getJson(fixture, "/api/inbox")).status, 503);
    await rename(unavailableRepositoryPath, fixture.repositoryPath);

    await unlink(fixture.workspaceConfigPath);
    const unavailable = await getJson(fixture, "/api/inbox");
    assert.equal(unavailable.status, 503);
    assert.equal(errorCode(unavailable.body), "WORKSPACE_CONFIG_UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("REST lists persistent Recall/Read/Used facts with strict pagination, asset filters and missing current titles", async () => {
  const fixture = await createFixture();
  try {
    const recall = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge"] });
    assert.equal(recall.items.length, 2);
    const alphaItem = recall.items.find(item => item.assetId === fixture.alphaAssetId)!;
    const read = await fixture.service.read({ capabilityIds: [fixture.alpha], recallItemId: alphaItem.recallItemId });
    await fixture.service.used({ capabilityIds: [fixture.alpha], readRef: read.readRef });
    await fixture.service.read({ capabilityIds: [], assetId: fixture.globalAssetId });
    const before = fixture.rows();
    const usage = dataItems((await getJson(fixture, "/api/usage")).body);
    assert.equal(usage.length, 3);
    assert.deepEqual(new Set(usage.map(item => item.kind)), new Set(["READ", "USED"]));
    const filtered = dataItems((await getJson(fixture, `/api/usage?assetId=${fixture.alphaAssetId}`)).body);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(item => item.assetWorkspace === "alpha"));
    const recalls = dataItems((await getJson(fixture, "/api/recalls")).body);
    assert.equal(recalls.length, 1);
    assert.deepEqual(recalls[0]!.authorizedWorkspaces, ["alpha"]);
    assert.deepEqual(recalls[0]!.queries, ["shared knowledge"]);
    const detail = dataObject((await getJson(fixture, `/api/recalls/${recall.recallId}`)).body);
    assert.deepEqual((detail.items as Array<{ assetId: string }>).map(item => item.assetId), recall.items.map(item => item.assetId));
    assert.ok((detail.items as Array<{ assetTitle: string | null }>).every(item => item.assetTitle === "Shared knowledge"));
    const workspaces = dataItems((await getJson(fixture, "/api/workspaces")).body);
    const alpha = workspaces.find(item => item.name === "alpha")!;
    assert.equal(alpha.authorizedRecallCount, 1); assert.equal(alpha.sourceRecallCount, 1);
    assert.equal(alpha.authorizedReadCount, 1); assert.equal(alpha.sourceReadCount, 1);
    assert.equal(alpha.authorizedUsedCount, 1); assert.equal(alpha.sourceUsedCount, 1);
    assert.equal((await getJson(fixture, "/api/recalls/invalid")).status, 400);
    assert.equal((await getJson(fixture, `/api/recalls/${fixture.idGenerator.next("usg")}`)).status, 404);
    for (const path of ["/api/usage?workspace=alpha", "/api/usage?taskId=bad", "/api/usage?assetId=bad",
      "/api/usage?limit=101", "/api/usage?offset=-1", "/api/recalls?query=old", "/api/recalls?limit=1&limit=2",
      "/api/recalls?limit=0", "/api/recalls?offset=", "/api/workspaces?workspace=alpha"]) {
      assert.equal((await getJson(fixture, path)).status, 400, path);
    }
    const page = dataItems((await getJson(fixture, "/api/usage?limit=1&offset=1")).body);
    assert.equal(page[0]!.id, usage[1]!.id);
    await unlink(fixture.alphaAssetPath);
    const missing = dataItems((await getJson(fixture, `/api/usage?assetId=${fixture.alphaAssetId}`)).body);
    assert.equal(missing.length, 2);
    assert.ok(missing.every(item => item.assetTitle === null));
    assert.deepEqual(missing.map(item => item.id), filtered.map(item => item.id));
    const missingRecall = dataObject((await getJson(fixture, `/api/recalls/${recall.recallId}`)).body);
    const missingRecallItems = missingRecall.items as Array<{ assetId: string; assetTitle: string | null }>;
    assert.equal(missingRecallItems.length, recall.items.length);
    assert.equal(missingRecallItems.find(item => item.assetId === fixture.alphaAssetId)!.assetTitle, null);
    assert.equal(missingRecallItems.find(item => item.assetId === fixture.globalAssetId)!.assetTitle, "Shared knowledge");
    assert.deepEqual(fixture.rows(), before);

    for (let i = 0; i < 101; i++) {
      await fixture.service.recall({ capabilityIds: [], queries: ["shared knowledge"] });
      await fixture.service.read({ capabilityIds: [], assetId: fixture.globalAssetId });
    }
    for (const route of ["/api/usage", "/api/recalls"]) {
      assert.equal(dataItems((await getJson(fixture, route)).body).length, 50);
      assert.equal(dataItems((await getJson(fixture, route + "?limit=100")).body).length, 100);
    }
  } finally { await fixture.close(); }
});

test("N09 System Status remains HTTP 200 for READY, DEGRADED, and REBUILD_REQUIRED without leaking paths", async () => {
  const fixture = await createFixture();
  try {
    const ready = await getJson(fixture, "/api/system/status");
    assert.equal(ready.status, 200);
    assert.equal((dataObject(ready.body).service as Record<string, unknown>).readiness, "READY");
    assert.deepEqual(dataObject(ready.body).mcpEndpoint, { path: "/mcp", ready: true });
    assert.equal(
      (dataObject(ready.body).repository as Record<string, unknown>).assetRepositoryPath,
      fixture.repositoryPath,
    );

    const base = fixture.indexManager.status();
    fixture.setIndexStatus({
      ...base,
      indexState: "DEGRADED",
      watcherState: "DEGRADED",
      diagnostics: [{
        code: "WATCHER_ERROR",
        message: `failed near ${fixture.databasePath}`,
        occurredAt: new Date().toISOString(),
        path: fixture.databasePath,
        source: "WATCHER",
      }],
    });
    const degraded = await getJson(fixture, "/api/system/status");
    assert.equal(degraded.status, 200);
    assert.equal((dataObject(degraded.body).service as Record<string, unknown>).readiness, "DEGRADED");
    assert.equal(JSON.stringify(degraded.body).includes(fixture.databasePath), false);
    assert.equal(JSON.stringify(degraded.body).includes(fixture.workspaceConfigPath), false);

    fixture.setIndexStatus({
      ...base,
      indexState: "REBUILD_REQUIRED",
      rebuildRequired: true,
    });
    const rebuild = await getJson(fixture, "/api/system/status");
    assert.equal(rebuild.status, 200);
    assert.equal((dataObject(rebuild.body).service as Record<string, unknown>).readiness, "REBUILD_REQUIRED");
    assert.equal((dataObject(rebuild.body).index as Record<string, unknown>).rebuildRequired, true);
  } finally {
    await fixture.close();
  }
});

test("N09 exposes read-only GET APIs with uniform envelopes and local Host/Origin protection", async () => {
  const fixture = await createFixture();
  try {
    const recall = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge"] });
    const before = fixture.rows();

    for (const path of [
      "/api/assets",
      `/api/assets/${fixture.alphaAssetId}`,
      "/api/inbox",
      "/api/recalls",
      `/api/recalls/${recall.recallId}`,
      "/api/workspaces",
      "/api/usage",
      "/api/system/status",
      "/api/overview",
    ]) {
      const response = await getJson(fixture, path);
      assert.equal(response.status, 200, path);
      assert.equal(response.body.ok, true, path);
      assert.equal(Object.hasOwn(response.body, "data"), true, path);
    }

    const post = await requestJson(fixture, "/api/assets", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.response.headers.get("allow"), "GET");
    assert.equal(errorCode(post.body), "METHOD_NOT_ALLOWED");
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await requestJson(fixture, "/api/usage", { method })).status, 405);
    }
    assert.equal((await requestJson(fixture, "/api/not-found", { method: "POST" })).status, 405);
    assert.equal((await getJson(fixture, "/api/not-found")).status, 404);

    const foreignHost = await requestJson(fixture, "/api/assets", {
      headers: { host: "localhost:3210" },
    });
    assert.equal(foreignHost.status, 403);
    const foreignOrigin = await requestJson(fixture, "/api/assets", {
      headers: { origin: "http://evil.example", host: AUTHORITY },
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.response.headers.has("access-control-allow-origin"), false);

    assert.deepEqual(fixture.rows(), before);
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n09-rest-"));
  const repositoryPath = join(rootPath, "repository");
  const databasePath = join(rootPath, "data", "memory.sqlite");
  const workspaceConfigPath = join(rootPath, "config", "workspaces.json");
  const alphaWorkspacePath = join(rootPath, "workspaces", "alpha");
  const betaWorkspacePath = join(rootPath, "workspaces", "beta");
  await mkdir(join(repositoryPath, "assets/global/memories"), { recursive: true });
  await mkdir(join(repositoryPath, "assets/workspaces/alpha/memories"), { recursive: true });
  await mkdir(join(repositoryPath, "assets/workspaces/beta/documents"), { recursive: true });
  await mkdir(join(rootPath, "config"), { recursive: true });
  await mkdir(alphaWorkspacePath, { recursive: true });
  await mkdir(betaWorkspacePath, { recursive: true });
  await writeFile(workspaceConfigPath, JSON.stringify({
    schemaVersion: 1,
    workspaces: [
      { name: "alpha", paths: [alphaWorkspacePath] },
      { name: "beta", paths: [betaWorkspacePath] },
    ],
  }), "utf8");

  const idGenerator = new SnowflakeIdGenerator();
  const globalAssetId = idGenerator.next("ast");
  const alphaAssetId = idGenerator.next("ast");
  const betaAssetId = idGenerator.next("ast");
  const globalAssetPath = join(repositoryPath, "assets/global/memories/global.md");
  const alphaAssetPath = join(repositoryPath, "assets/workspaces/alpha/memories/alpha.md");
  const betaAssetPath = join(repositoryPath, "assets/workspaces/beta/documents/beta.md");
  await writeAsset(alphaAssetPath, {
    id: alphaAssetId,
    type: "MEMORY",
    scope: "WORKSPACE",
    workspace: "alpha",
    title: "Shared knowledge",
    summary: "shared knowledge alpha",
    body: "shared knowledge body",
  });
  await writeAsset(betaAssetPath, {
    id: betaAssetId,
    type: "DOCUMENT",
    scope: "WORKSPACE",
    workspace: "beta",
    title: "Shared knowledge",
    summary: "shared knowledge beta",
    body: "shared knowledge body",
  });
  await writeAsset(globalAssetPath, {
    id: globalAssetId,
    type: "MEMORY",
    scope: "GLOBAL",
    title: "Shared knowledge",
    summary: "shared knowledge global",
    body: "shared knowledge body",
  });
  await utimes(alphaAssetPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
  await utimes(betaAssetPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
  await utimes(globalAssetPath, new Date("2026-01-03T00:00:00.000Z"), new Date("2026-01-03T00:00:00.000Z"));

  await mkdir(join(rootPath, "data"), { recursive: true });
  initializeDatabase(databasePath);
  const indexManager = await AssetIndexManager.create({
    databasePath,
    repositoryPath,
    workspaceConfigPath,
    debounceMs: 60_000,
  });
  await indexManager.start();
  let indexStatusOverride: AssetIndexStatus | null = null;
  const statusProvider = (): AssetIndexStatus => indexStatusOverride ?? indexManager.status();
  const runtime = knowledgeRuntime({ databasePath, repositoryPath, workspaceConfigPath }, statusProvider, () => indexManager.synchronize());
  const { service, projection, repository, inboxService, search: assetSearchService } = runtime;
  const alpha = (await runtime.capabilities.issueFromTrustedHost(alphaWorkspacePath))[0]!.capabilityId;
  const beta = (await runtime.capabilities.issueFromTrustedHost(betaWorkspacePath))[0]!.capabilityId;
  const assetService = new HubAssetApplicationService(assetSearchService, projection, repository);
  const systemStatusService = new SystemStatusApplicationService({
    repositoryPath,
    workspaceConfigPath,
    indexStatus: statusProvider,
    inboxService,
    mcpEndpointReady: () => true,
    uptimeSeconds: () => 12.5,
  });
  const app = createApp({
    allowedAuthority: AUTHORITY,
    assetService,
    inboxService,
    indexStatus: statusProvider,
    projection,
    systemStatusService,
    overviewService: new OverviewApplicationService({ repositoryPath, workspaceConfigPath, inboxService, projection }),
  });


  return {
    alphaAssetId,
    alphaAssetPath,
    app,
    betaAssetId,
    betaAssetPath,
    databasePath,
    globalAssetId,
    globalAssetPath,
    idGenerator,
    indexManager,
    repositoryPath,
    service, alpha, beta,
    rows: () => persistentRows(repository.db),
    workspaceConfigPath,
    setIndexStatus: (status: AssetIndexStatus | null) => {
      indexStatusOverride = status;
    },
    close: async () => {
      runtime.close();
      await indexManager.close();
      await rm(rootPath, { recursive: true, force: true });
    },
  };
}

async function writeAsset(
  path: string,
  asset: {
    body: string;
    id: string;
    scope: "GLOBAL" | "WORKSPACE";
    summary: string;
    title: string;
    type: AssetType;
    workspace?: string;
  },
): Promise<void> {
  const workspace = asset.workspace === undefined ? "" : `workspace: ${asset.workspace}\n`;
  await writeFile(
    path,
    `---\nid: ${asset.id}\ntype: ${asset.type}\nscope: ${asset.scope}\n${workspace}title: ${asset.title}\nsummary: ${asset.summary}\n---\n${asset.body}\n`,
    "utf8",
  );
}

async function getJson(fixture: RestFixture, path: string): Promise<JsonResponse> {
  return requestJson(fixture, path);
}

interface JsonResponse {
  body: Record<string, unknown>;
  response: Response;
  status: number;
}

async function requestJson(
  fixture: RestFixture,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    headers.set("host", AUTHORITY);
  }
  const response = await fixture.app.request(`http://${AUTHORITY}${path}`, { ...init, headers });
  return {
    body: await response.json() as Record<string, unknown>,
    response,
    status: response.status,
  };
}

function dataObject(body: Record<string, unknown>): Record<string, unknown> {
  assert.equal(body.ok, true);
  assert.equal(typeof body.data, "object");
  assert.notEqual(body.data, null);
  return body.data as Record<string, unknown>;
}

function dataItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = dataObject(body).items;
  assert.equal(Array.isArray(items), true);
  return items as Array<Record<string, unknown>>;
}

function errorCode(body: Record<string, unknown>): unknown {
  assert.equal(body.ok, false);
  return (body.error as Record<string, unknown>).code;
}


test("Overview aggregates facts beyond list limits, counts Used sources distinctly and scans current files without Usage writes", async () => {
  const fixture = await createFixture();
  try {
    for (let i = 0; i < 105; i++) await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge alpha"] });
    const recalled = await fixture.service.recall({ capabilityIds: [fixture.beta], queries: ["shared knowledge"] });
    const beta = recalled.items.find(item => item.assetId === fixture.betaAssetId)!;
    await fixture.service.read({ capabilityIds: [fixture.beta], recallItemId: beta.recallItemId });
    for (const item of recalled.items) {
      await fixture.service.used({ capabilityIds: [fixture.beta], recallItemId: item.recallItemId });
      await fixture.service.used({ capabilityIds: [fixture.beta], recallItemId: item.recallItemId });
    }
    const before = fixture.rows();
    const response = await getJson(fixture, "/api/overview");
    assert.equal(response.status, 200);
    const result = response.body.data as import("../src/http/overview.js").OverviewDto;
    assert.deepEqual(result.facts, { recallOperations: 106, recallItems: 107, reads: 1, used: 2 });
    assert.equal(result.scopes.reduce((sum, s) => sum + Object.values(s.assets).reduce((a, b) => a + b, 0), 0), 3);
    await unlink(fixture.alphaAssetPath);
    const fresh = (await getJson(fixture, "/api/overview")).body.data as import("../src/http/overview.js").OverviewDto;
    assert.deepEqual(fresh.scopes.find(s => s.workspace === "alpha")?.assets, { MEMORY: 0, DOCUMENT: 0, SKILL: 0 });
    assert.deepEqual(fixture.rows(), before);
    assert.equal((await getJson(fixture, "/api/overview?limit=20")).status, 400);
    assert.equal((await requestJson(fixture, "/api/overview", { method: "POST" })).status, 405);
    assert.equal((await requestJson(fixture, "/api/overview", { headers: { origin: "https://example.com" } })).status, 403);
    await writeFile(fixture.workspaceConfigPath, "invalid JSON");
    assert.equal((await getJson(fixture, "/api/overview")).status, 503);
  } finally { await fixture.close(); }
});
