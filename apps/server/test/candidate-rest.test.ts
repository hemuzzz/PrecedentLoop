import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { AiService } from "../src/ai/service.js";
import { AssetDiffService } from "../src/asset/content-diff.js";
import { AssetSearchService } from "../src/asset/index.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeProjection } from "../src/knowledge/projection.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { HubAssetApplicationService, OverviewApplicationService, SystemStatusApplicationService } from "../src/http/index.js";
import { runCandidateCli } from "../src/asset/candidate-cli.js";
import { candidateFixture, content, selection } from "../test-support/candidate-fixture.js";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const authority = "127.0.0.1:3199";
async function fixture() {
  const f = await candidateFixture();
  const search = new AssetSearchService(f.options);
  const repository = new KnowledgeRepository(f.options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, f.options.workspaceConfigPath);
  const projection = new KnowledgeProjection(repository, capabilities, f.options);
  const inboxService = { scan: () => f.service.list() };
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ schemaVersion: 1, candidates: [], sourceResults: [{ sourceKey: "0", explanation: "无增量", pendingRef: null }], warnings: [] }) });
  const systemStatusService = new SystemStatusApplicationService({ ...f.options, candidateService: f.service, mcpEndpointReady: () => false });
  const app = createApp({ allowedAuthority: authority, candidateService: f.service, aiService: ai, inboxService, projection,
    assetService: new HubAssetApplicationService(search, projection, repository, new AssetDiffService(search)),
    overviewService: new OverviewApplicationService({ ...f.options, candidateService: f.service, projection }), systemStatusService });
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://${authority}${path}`, { headers: { host: authority, ...headers } });
  const token = ((await (await get("/api/inbox/session")).json()) as { data: { token: string } }).data.token;
  const post = (path: string, body: object, headers: Record<string, string> = {}) => app.request(`http://${authority}${path}`, { method: "POST", headers: { host: authority, origin: `http://${authority}`, "content-type": "application/json", "x-hub-write-token": token, ...headers }, body: JSON.stringify(body) });
  return { ...f, app, get, post, token, repository, cleanup: async () => { await ai.close(); search.close(); repository.close(); await f.cleanup(); } };
}

test("finite REST writes require same origin, current token, JSON and exact fields; GET never registers", async () => {
  const f = await fixture();
  try {
    const item = (await f.prepare("prepare", [content()])).candidates[0]!;
    const input = selection(item, "accept");
    for (const headers of [{ "x-hub-write-token": "" }, { "x-hub-write-token": "é".repeat(64) }, { origin: "http://evil.invalid" }, { origin: "null" }, { host: "evil.invalid" }]) assert.equal((await f.post("/api/inbox/accept", input, headers)).status, 403);
    assert.equal((await f.post("/api/inbox/accept", input, { "content-type": "text/plain" })).status, 400);
    assert.equal((await f.post("/api/inbox/accept", { ...input, path: "/tmp/forged" })).status, 400);
    assert.equal((await f.post("/api/anything", {})).status, 405);
    assert.equal((await f.get("/api/inbox/session", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await f.get("/api/inbox/session")).headers.get("cache-control"), "no-store");
    const db = new Database(f.options.databasePath);
    try { const before = db.prepare("SELECT count(*) AS n FROM write_operation").get(); await f.get("/api/inbox"); await f.get("/api/inbox?bucket=DEFERRED"); assert.deepEqual(db.prepare("SELECT count(*) AS n FROM write_operation").get(), before); }
    finally { db.close(); }
    assert.equal((await f.post("/api/inbox/accept", input)).status, 200);
    const detail = await f.get(`/api/assets/${item.assetId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json() as { data: { asset: { retrievalTerms: string[] } } }).data.asset.retrievalTerms, content().retrievalTerms);
    assert.equal((await f.post("/api/inbox/accept", input)).status, 200);
    const query = await (await f.get("/api/inbox/operation?requestId=accept")).json() as { data: { operation: { state: string } } };
    assert.equal(query.data.operation.state, "SUCCEEDED");
    const inbox = await (await f.get("/api/inbox")).json() as { data: { items: unknown[] } };
    assert.equal(inbox.data.items.length, 0);
    assert.deepEqual(f.repository.db.prepare("SELECT count(*) AS n FROM used_event").get(), { n: 0 });
  } finally { await f.cleanup(); }
});

test("knowledge deletion requires the write token, blocks open revisions and filters list, detail and overview", async () => {
  const f = await fixture();
  try {
    const item = (await f.prepare("new-delete", [content("删除后不可检索的正文")])).candidates[0]!;
    await f.service.accept(selection(item, "accept-delete"));
    const input = { requestId: "delete", assetId: item.assetId };
    assert.equal((await f.post("/api/assets/delete", input, { "x-hub-write-token": "" })).status, 403);
    const revision = (await f.prepare("revision-delete", [{ ...content(), existingAssetId: item.assetId, baseVersion: 0 }])).candidates[0]!;
    for (const deferred of [false, true]) {
      if (deferred) await f.service.defer({ ...selection(revision, "defer-delete"), deferred: true });
      const blocked = await f.post("/api/assets/delete", input);
      assert.equal(blocked.status, 409);
      assert.deepEqual((await blocked.json() as { error: unknown }).error, {
        code: "ASSET_HAS_OPEN_CANDIDATE", message: "请先处理该知识的待审或暂存候选", retryable: false,
      });
    }
    assert.equal(await f.service.receipt(input.requestId), undefined);
    await f.service.reject(selection(revision, "reject-delete"));
    assert.equal((await f.post("/api/assets/delete", input)).status, 200);
    assert.equal((await f.post("/api/assets/delete", input)).status, 200);
    assert.equal((await f.get(`/api/assets/${item.assetId}`)).status, 404);
    const list = await (await f.get("/api/assets")).json() as { data: { items: unknown[] } };
    assert.deepEqual(list.data.items, []);
    const graph = await (await f.get("/api/overview")).json() as { data: { scopes: Array<{ items: unknown[] }> } };
    assert.deepEqual(graph.data.scopes.flatMap(scope => scope.items), []);
    assert.deepEqual(f.repository.db.prepare("SELECT is_deleted,version FROM asset WHERE asset_id=?").get(item.assetId), { is_deleted: 1, version: 0 });
  } finally { await f.cleanup(); }
});

test("REST acceptance, revision, search and graph share query-layer formal numbers", async () => {
  const f = await fixture();
  try {
    const pending = (await f.prepare("number-prepare", [content()])).candidates[0]!;
    const inbox = await (await f.get("/api/inbox")).json() as { data: { items: Array<{ candidateId: string; knowledgeNumber: number | null; retrievalTerms: string[] }> } };
    assert.equal(inbox.data.items[0]?.candidateId, pending.candidateId);
    assert.equal(inbox.data.items[0]?.knowledgeNumber, null);
    assert.deepEqual(inbox.data.items[0]?.retrievalTerms, content().retrievalTerms);
    const graphPending = await (await f.get("/api/overview")).json() as { data: { scopes: Array<{ items: Array<{ candidateId: string | null; knowledgeNumber: number | null }> }> } };
    assert.equal(graphPending.data.scopes.flatMap(scope => scope.items)[0]?.candidateId, pending.candidateId);
    assert.equal((await f.post("/api/inbox/accept", selection(pending, "number-accept"))).status, 200);
    const before = await (await f.get(`/api/assets/${pending.assetId}`)).json() as { data: { asset: { knowledgeNumber: number | null; version: number } } };
    assert.equal(before.data.asset.knowledgeNumber, 1);
    const status = await (await f.get("/api/system/status")).json() as { data: { diagnostics: Array<{ code: string }>; mcpEndpoint: { ready: boolean } } };
    assert.ok(!status.data.diagnostics.some(item => item.code.includes("MIGRATION")));
    assert.equal(f.repository.db.pragma("user_version", { simple: true }), 0);
    for (const path of ["/api/assets", `/api/assets?query=${encodeURIComponent("候选知识")}`]) {
      const response = await (await f.get(path)).json() as { data: { items: Array<{ knowledgeNumber: number | null }> } };
      assert.equal(response.data.items[0]?.knowledgeNumber, 1);
    }
    const detail = await (await f.get(`/api/assets/${pending.assetId}`)).json() as { data: { asset: { knowledgeNumber: number; version: number } } };
    assert.equal(detail.data.asset.knowledgeNumber, 1);
    assert.equal(detail.data.asset.version, before.data.asset.version);
    const revision = (await f.prepare("number-revise", [{ ...content("修订正文"), existingAssetId: pending.assetId, baseVersion: detail.data.asset.version }])).candidates[0]!;
    const revisedInbox = await (await f.get("/api/inbox")).json() as { data: { items: Array<{ candidateId: string; knowledgeNumber: number }> } };
    assert.equal(revisedInbox.data.items[0]?.candidateId, revision.candidateId);
    assert.equal(revisedInbox.data.items[0]?.knowledgeNumber, 1);
    const graph = await (await f.get("/api/overview")).json() as { data: { scopes: Array<{ items: Array<{ pending: boolean; knowledgeNumber: number | null; candidateId?: string }> }> } };
    const nodes = graph.data.scopes.flatMap(scope => scope.items);
    assert.equal(nodes.find(item => !item.pending)?.knowledgeNumber, 1);
    assert.equal(nodes.find(item => item.pending)?.candidateId, revision.candidateId);
    assert.equal((await f.post("/api/inbox/accept", { ...selection(revision, "number-revision-accept"), baseVersion: detail.data.asset.version })).status, 200);
    const revised = await (await f.get(`/api/assets/${pending.assetId}`)).json() as { data: { asset: { knowledgeNumber: number } } };
    assert.equal(revised.data.asset.knowledgeNumber, 1);
    const next = (await f.prepare("number-next", [content("下一条")])).candidates[0]!;
    assert.equal((await f.post("/api/inbox/accept", selection(next, "number-next-accept"))).status, 200);
    const nextDetail = await (await f.get(`/api/assets/${next.assetId}`)).json() as { data: { asset: { knowledgeNumber: number } } };
    assert.equal(nextDetail.data.asset.knowledgeNumber, 2);
    const migratedStatus = await (await f.get("/api/system/status")).json() as { data: { diagnostics: Array<{ code: string }> } };
    assert.ok(!migratedStatus.data.diagnostics.some(item => item.code === "KNOWLEDGE_NUMBER_MIGRATION_REQUIRED"));
  } finally { await f.cleanup(); }
});

test("CLI and REST act on the same IDs, hashes, deferred bucket and durable result", async () => {
  const f = await fixture();
  try {
    const stdout = new PassThrough(), stderr = new PassThrough(); let output = "";
    stdout.on("data", chunk => { output += String(chunk); });
    const env = { PRECEDENT_LOOP_DATABASE_PATH: f.options.databasePath, PRECEDENT_LOOP_WORKSPACES_PATH: f.options.workspaceConfigPath };
    const stdin = new PassThrough(); stdin.end(JSON.stringify({ requestId: "cli-prepare", candidates: [content()] }));
    assert.equal(await runCandidateCli(["prepare"], env, stdin, stdout, stderr), 0);
    const parsed = JSON.parse(output) as { data: { candidates: Array<{ candidateId: string; number: number; assetId: string; version: number; intent: "NEW" }> } };
    const item = parsed.data.candidates[0]!;
    assert.equal((await f.post("/api/inbox/defer", { ...selection(item, "defer"), deferred: true })).status, 200);
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, item.candidateId);
    assert.equal((await f.post("/api/inbox/reject", selection(item, "reject"))).status, 200);
    assert.equal((await f.get("/api/inbox/operation?requestId=reject")).status, 200);
    assert.equal((await f.post("/api/inbox/accept", selection(item, "different-after-delete"))).status, 409);
  } finally { await f.cleanup(); }
});

test("workspace discovery is a protected finite POST and exposes names without project paths", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("/api/inbox/workspaces", {}, { "x-hub-write-token": "" })).status, 403);
    assert.equal((await f.post("/api/inbox/workspaces", {}, { origin: "http://evil.invalid" })).status, 403);
    assert.equal((await f.post("/api/inbox/workspaces", { statePath: "/forged" })).status, 400);
    assert.equal((await f.post("/api/inbox/workspaces", {}, { "content-type": "text/plain" })).status, 400);
    const response = await f.post("/api/inbox/workspaces", {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { workspaces: ["alpha"] } });
    assert.deepEqual(f.repository.db.prepare("SELECT count(*) AS n FROM write_operation").get(), { n: 0 });
  } finally { await f.cleanup(); }
});

test("AI test is a protected write route with a fixed payload and never records an inbox operation", async () => {
  const f = await fixture();
  try {
    for (const headers of [{ "x-hub-write-token": "" }, { origin: "http://evil.invalid" }, { host: "evil.invalid" }]) assert.equal((await f.post("/api/inbox/test", { provider: "codex" }, headers)).status, 403);
    assert.equal((await f.post("/api/inbox/test", { provider: "codex", prompt: "arbitrary" })).status, 400);
    assert.equal((await f.post("/api/inbox/test", { provider: "codex" }, { "content-type": "text/plain" })).status, 400);
    assert.equal((await f.post("/api/inbox/test", { provider: "other" })).status, 400);
    const before = f.repository.db.prepare("SELECT * FROM write_operation").all();
    const response = await f.post("/api/inbox/test", { provider: "codex" }); assert.equal(response.status, 200);
    const result = await response.json() as { data: { success: boolean; error: { code: string } } };
    assert.equal(result.data.success, false); assert.equal(result.data.error.code, "AI_TEST_FAILED");
    assert.deepEqual(f.repository.db.prepare("SELECT * FROM write_operation").all(), before);
    assert.equal((await f.get("/api/inbox/ai-settings")).status, 200);
    const providers = await (await f.get("/api/inbox/providers")).json() as { data: { providers: Array<{ isDefault: boolean }> } };
    assert.equal(providers.data.providers[0]!.isDefault, true);
  } finally { await f.cleanup(); }
});


test("import accepts a body above the old HTTP limit without removing limits on unrelated writes", async () => {
  const f = await fixture(); const content = "x".repeat(7_000_001);
  try {
    const response = await f.post("/api/inbox/import", { requestId: "large-http-import", provider: "codex", sources: [{ name: "large.md", content }], targets: [{ scope: "GLOBAL" }] });
    assert.equal(response.status, 200);
    let state: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await (await f.get("/api/inbox/operation?requestId=large-http-import")).json() as { data: { operation: { state: string } } };
      state = result.data.operation.state;
      if (state !== "RUNNING") break;
      await delay(10);
    }
    assert.equal(state, "SUCCEEDED");
    const unrelated = await f.post("/api/inbox/reject", { content });
    assert.equal(unrelated.status, 400);
    assert.equal((await unrelated.json() as { error: { code: string } }).error.code, "INPUT_TOO_LARGE");
  } finally { await f.cleanup(); }
});

test("acceptance preserves persistent facts and other candidate state", async () => {
  const f = await fixture();
  try {
    const item = (await f.prepare("prepare", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    f.repository.db.prepare("INSERT INTO workspace_capability(capability_key_hash,workspace,created_at,updated_at,trusted_workspace_mapping_hash) VALUES (?,?,?,?,?)").run("hash", "alpha", "now", "now", "mapping");
    const before = f.repository.db.prepare("SELECT * FROM workspace_capability").all();
    const accepted = (await f.prepare("other", [content("other knowledge")])).candidates[0]!;
    await f.service.accept(selection(accepted, "accept-other"));
    assert.deepEqual(f.repository.db.prepare("SELECT * FROM workspace_capability").all(), before);
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, item.candidateId);
    assert.ok(await f.service.operation("prepare"));
  } finally { await f.cleanup(); }
});
