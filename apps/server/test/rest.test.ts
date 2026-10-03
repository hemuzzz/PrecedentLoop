import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import { createApp } from "../src/app.js";
import {
  type AssetType,
} from "../src/asset/index.js";
import {
  OverviewApplicationService,
  HubAssetApplicationService,
  SystemStatusApplicationService,
} from "../src/http/index.js";

import { knowledgeFixture } from "../test-support/knowledge-fixture.js";

const AUTHORITY = "127.0.0.1:3210";

type RestFixture = Awaited<ReturnType<typeof createFixture>>;

test("repository reads preserve Recall/Read/Used and keeps numbers out of model-visible results", async () => {
  const fixture = await createFixture();
  try {
    const before = await fixture.service.recall({ capabilityIds: [fixture.alpha], queries: ["shared knowledge alpha"] });
    assert.ok(before.items.length > 0);
    const read = await fixture.service.read({ capabilityIds: [fixture.alpha], recallItemId: before.items[0]!.recallItemId });
    const rows = fixture.rows();
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

    for (let index = 0; index < 101; index += 1) {
      await fixture.asset({
        type: "DOCUMENT",
        title: `Bulk ${index}`,
        summary: "default and maximum limit",
        body: "bulk",
      });
    }
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
    assert.match(String(asset.bodyMarkdown), /shared knowledge/u);
    assert.equal("renderedMarkdown" in asset, false);
    assert.equal("relativePath" in asset, false);
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

    fixture.revise(fixture.alphaAssetId, { title: "Alpha changed", summary: "Changed projection", bodyMarkdown: "changed body" });
    const current = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(current.status, 200);
    assert.equal((dataObject(current.body).asset as Record<string, unknown>).bodyMarkdown, "changed body");
    assert.equal((dataObject(current.body).asset as Record<string, unknown>).version, 1);
    fixture.remove(fixture.alphaAssetId); fixture.remove(fixture.betaAssetId);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`)).status, 404);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.betaAssetId}`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test("Asset Detail returns exact Markdown for Hub rendering without rendering or executing it", async () => {
  const fixture = await createFixture();
  try {
    const body = '**触发：**用户明确要求\n\n**ordinary bold**\n\n<script>alert("x")</script>\n\nhttps://example.com\n\n"quotes" -- ...\n\n| 左 | 右 |\n| :--- | ---: |\n| 文本 | 内容 |';
    fixture.revise(fixture.alphaAssetId, { bodyMarkdown: body });
    const response = await getJson(fixture, `/api/assets/${fixture.alphaAssetId}`);
    assert.equal(response.status, 200);
    const asset = dataObject(response.body).asset as Record<string, unknown>;
    assert.equal(asset.bodyMarkdown, body); assert.equal("renderedMarkdown" in asset, false);
  } finally { await fixture.close(); }
});

test("Inbox lists current pending rows, hides processed candidates, and rejects unavailable configuration", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(dataItems((await getJson(fixture, "/api/inbox")).body), []);
    const prepared = await fixture.candidateService.prepare("pending", [{ title: "Inbox valid", summary: "Valid candidate", retrievalTerms: ["候选写入", "版本校验", "隔离验证"], bodyMarkdown: "candidate", type: "MEMORY", target: { scope: "GLOBAL" } }]);
    assert.ok(!("status" in prepared)); const candidate = prepared.candidates[0]!;
    assert.deepEqual(dataItems((await getJson(fixture, "/api/inbox")).body).map(item => item.assetId), [candidate.assetId]);
    await fixture.candidateService.reject({ requestId: "reject", candidateId: candidate.candidateId, assetId: candidate.assetId, candidateVersion: 0 });
    assert.deepEqual(dataItems((await getJson(fixture, "/api/inbox")).body), []);
    assert.equal((await getJson(fixture, `/api/assets/${fixture.globalAssetId}`)).status, 200);
    await unlink(fixture.workspaceConfigPath);
    const unavailable = await getJson(fixture, "/api/inbox");
    assert.equal(unavailable.status, 503);
    assert.equal(errorCode(unavailable.body), "WORKSPACE_CONFIG_UNAVAILABLE");
  } finally { await fixture.close(); }
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
    const detail = dataObject((await getJson(fixture, `/api/recalls/${recalls[0]!.recallId}`)).body);
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
    fixture.remove(fixture.alphaAssetId);
    const missing = dataItems((await getJson(fixture, `/api/usage?assetId=${fixture.alphaAssetId}`)).body);
    assert.equal(missing.length, 2);
    assert.ok(missing.every(item => item.assetTitle === null));
    assert.deepEqual(missing.map(item => item.id), filtered.map(item => item.id));
    const missingRecall = dataObject((await getJson(fixture, `/api/recalls/${recalls[0]!.recallId}`)).body);
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

test("System Status reports actual schema version and degrades without leaking paths", async () => {
  const fixture = await createFixture();
  try {
    const ready = await getJson(fixture, "/api/system/status");
    assert.equal(ready.status, 200);
    assert.equal((dataObject(ready.body).service as Record<string, unknown>).readiness, "READY");
    assert.deepEqual(dataObject(ready.body).mcpEndpoint, { path: "/mcp", ready: true });
    assert.deepEqual(dataObject(ready.body).storage, { formalAssetCount: 3, inboxAssetCount: 0 });
    await writeFile(fixture.workspaceConfigPath, "invalid");
    const degraded = await getJson(fixture, "/api/system/status");
    assert.equal(degraded.status, 200);
    assert.equal((dataObject(degraded.body).service as Record<string, unknown>).readiness, "DEGRADED");
    assert.equal(JSON.stringify(degraded.body).includes(fixture.databasePath), false);
    assert.equal(JSON.stringify(degraded.body).includes(fixture.workspaceConfigPath), false);
  } finally { await fixture.close(); }
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
      `/api/recalls/${fixture.repository.item(recall.items[0]!.recallItemId!)!.recallId}`,
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
  const f = await knowledgeFixture(), idGenerator = new SnowflakeIdGenerator();
  const alphaAsset = await f.asset({ title: "Shared knowledge", summary: "shared knowledge alpha", body: "shared knowledge body", workspace: "alpha" });
  const betaAsset = await f.asset({ title: "Shared knowledge", summary: "shared knowledge beta", body: "shared knowledge body", workspace: "beta", type: "DOCUMENT" });
  const globalAsset = await f.asset({ title: "Shared knowledge", summary: "shared knowledge global", body: "shared knowledge body" });
  for (const [index, item] of [alphaAsset, betaAsset, globalAsset].entries())
    f.repository.db.prepare("UPDATE asset SET updated_at=? WHERE asset_id=?").run(`2026-01-0${index + 1}T00:00:00.000Z`, item.assetId);
  const { candidateService, projection, inboxService } = f;
  const app = createApp({ allowedAuthority: AUTHORITY, candidateService, inboxService, projection,
    assetService: new HubAssetApplicationService(f.search, projection, f.repository),
    systemStatusService: new SystemStatusApplicationService({ ...f.options, candidateService, mcpEndpointReady: () => true, uptimeSeconds: () => 12.5 }),
    overviewService: new OverviewApplicationService({ ...f.options, candidateService, projection }),
  });
  return { ...f, ...f.options, app, idGenerator, alphaAssetId: alphaAsset.assetId, betaAssetId: betaAsset.assetId, globalAssetId: globalAsset.assetId };
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


test("Overview aggregates facts beyond list limits, counts Used sources distinctly and queries current records without Usage writes", async () => {
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
    fixture.remove(fixture.alphaAssetId);
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
