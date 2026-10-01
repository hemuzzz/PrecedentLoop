import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { AiService } from "../src/ai/service.js";
import { AssetContentVersionRepository } from "../src/asset/content-version.js";
import { AssetDiffService } from "../src/asset/content-diff.js";
import { AssetIndexManager, AssetSearchService } from "../src/asset/index.js";
import { KnowledgeRepository, migrateKnowledge, migrateRecallStorage } from "../src/knowledge/repository.js";
import { KnowledgeProjection } from "../src/knowledge/projection.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { HubAssetApplicationService, OverviewApplicationService, SystemStatusApplicationService } from "../src/http/index.js";
import { migrateCandidateStore } from "../src/asset/candidate-repository.js";
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
  const index = await AssetIndexManager.create(f.options); await index.synchronize();
  const search = new AssetSearchService({ ...f.options, refreshIndex: () => index.synchronize() });
  const versions = new AssetContentVersionRepository(f.options.databasePath);
  const repository = new KnowledgeRepository(f.options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, f.options.workspaceConfigPath);
  const projection = new KnowledgeProjection(repository, capabilities, f.options);
  const inboxService = { scan: () => f.service.list() };
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ schemaVersion: 1, candidates: [], sourceResults: [{ sourceKey: "0", explanation: "无增量", pendingRef: null }], warnings: [] }) });
  const systemStatusService = new SystemStatusApplicationService({ ...f.options, indexStatus: () => index.status(), inboxService, mcpEndpointReady: () => false });
  const app = createApp({ allowedAuthority: authority, candidateService: f.service, aiService: ai, inboxService, projection, indexStatus: () => index.status(), refreshIndex: async () => { await index.synchronize(); },
    assetService: new HubAssetApplicationService(search, projection, repository, new AssetDiffService(search, versions)),
    overviewService: new OverviewApplicationService({ ...f.options, inboxService, projection }), systemStatusService });
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://${authority}${path}`, { headers: { host: authority, ...headers } });
  const token = ((await (await get("/api/inbox/session")).json()) as { data: { token: string } }).data.token;
  const post = (path: string, body: object, headers: Record<string, string> = {}) => app.request(`http://${authority}${path}`, { method: "POST", headers: { host: authority, origin: `http://${authority}`, "content-type": "application/json", "x-hub-write-token": token, ...headers }, body: JSON.stringify(body) });
  return { ...f, app, get, post, token, repository, cleanup: async () => { await ai.close(); search.close(); versions.close(); repository.close(); await index.close(); await f.cleanup(); } };
}

test("finite REST writes require same origin, current token, JSON and exact fields; GET never registers", async () => {
  const f = await fixture();
  try {
    const item = (await f.service.prepare("prepare", [content()])).candidates[0]!;
    const input = selection(item, "accept");
    for (const headers of [{ "x-hub-write-token": "" }, { "x-hub-write-token": "é".repeat(64) }, { origin: "http://evil.invalid" }, { origin: "null" }, { host: "evil.invalid" }]) assert.equal((await f.post("/api/inbox/accept", input, headers)).status, 403);
    assert.equal((await f.post("/api/inbox/accept", input, { "content-type": "text/plain" })).status, 400);
    assert.equal((await f.post("/api/inbox/accept", { ...input, path: "/tmp/forged" })).status, 400);
    assert.equal((await f.post("/api/anything", {})).status, 405);
    assert.equal((await f.get("/api/inbox/session", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await f.get("/api/inbox/session")).headers.get("cache-control"), "no-store");
    const db = new Database(f.options.databasePath);
    try { const before = db.prepare("SELECT count(*) AS n FROM inbox_operation").get(); await f.get("/api/inbox"); await f.get("/api/inbox?bucket=DEFERRED"); assert.deepEqual(db.prepare("SELECT count(*) AS n FROM inbox_operation").get(), before); }
    finally { db.close(); }
    assert.equal((await f.post("/api/inbox/accept", input)).status, 200);
    assert.equal((await f.get(`/api/assets/${item.assetId}`)).status, 200);
    assert.equal((await f.post("/api/inbox/accept", input)).status, 200);
    const query = await (await f.get("/api/inbox/operation?requestId=accept")).json() as { data: { operation: { state: string } } };
    assert.equal(query.data.operation.state, "SUCCEEDED");
    const inbox = await (await f.get("/api/inbox")).json() as { data: { items: unknown[] } };
    assert.equal(inbox.data.items.length, 0);
    assert.deepEqual(f.repository.db.prepare("SELECT count(*) AS n FROM used_event").get(), { n: 0 });
  } finally { await f.cleanup(); }
});

test("CLI and REST act on the same IDs, hashes, deferred bucket and durable result", async () => {
  const f = await fixture();
  try {
    const stdout = new PassThrough(), stderr = new PassThrough(); let output = "";
    stdout.on("data", chunk => { output += String(chunk); });
    const env = { PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: f.options.repositoryPath, PRECEDENT_LOOP_DATABASE_PATH: f.options.databasePath, PRECEDENT_LOOP_WORKSPACES_PATH: f.options.workspaceConfigPath };
    const stdin = new PassThrough(); stdin.end(JSON.stringify({ requestId: "cli-prepare", candidates: [content()] }));
    assert.equal(await runCandidateCli(["prepare"], env, stdin, stdout, stderr), 0);
    const parsed = JSON.parse(output) as { data: { candidates: Array<{ candidateId: string; assetId: string; contentHash: string; intent: "NEW" }> } };
    const item = parsed.data.candidates[0]!;
    assert.equal((await f.post("/api/inbox/defer", { ...selection(item, "defer"), deferred: true })).status, 200);
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, item.candidateId);
    assert.equal((await f.post("/api/inbox/reject", selection(item, "reject"))).status, 200);
    assert.equal((await f.get("/api/inbox/operation?requestId=reject")).status, 200);
    assert.equal((await f.post("/api/inbox/accept", selection(item, "different-after-delete"))).status, 404);
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
    assert.deepEqual(f.repository.db.prepare("SELECT count(*) AS n FROM inbox_operation").get(), { n: 0 });
  } finally { await f.cleanup(); }
});

test("AI test is a protected write route with a fixed payload and never records an inbox operation", async () => {
  const f = await fixture();
  try {
    for (const headers of [{ "x-hub-write-token": "" }, { origin: "http://evil.invalid" }, { host: "evil.invalid" }]) assert.equal((await f.post("/api/inbox/test", { provider: "codex" }, headers)).status, 403);
    assert.equal((await f.post("/api/inbox/test", { provider: "codex", prompt: "arbitrary" })).status, 400);
    assert.equal((await f.post("/api/inbox/test", { provider: "codex" }, { "content-type": "text/plain" })).status, 400);
    assert.equal((await f.post("/api/inbox/test", { provider: "other" })).status, 400);
    const before = f.repository.db.prepare("SELECT * FROM inbox_operation").all();
    const response = await f.post("/api/inbox/test", { provider: "codex" }); assert.equal(response.status, 200);
    const result = await response.json() as { data: { success: boolean; error: { code: string } } };
    assert.equal(result.data.success, false); assert.equal(result.data.error.code, "AI_TEST_FAILED");
    assert.deepEqual(f.repository.db.prepare("SELECT * FROM inbox_operation").all(), before);
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
    const unrelated = await f.post("/api/inbox/register", { content });
    assert.equal(unrelated.status, 400);
    assert.equal((await unrelated.json() as { error: { code: string } }).error.code, "INPUT_TOO_LARGE");
  } finally { await f.cleanup(); }
});

test("explicit candidate migration and later index maintenance preserve persistent facts and candidate state", async () => {
  const f = await fixture();
  try {
    const item = (await f.service.prepare("prepare", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    f.repository.db.prepare("INSERT INTO workspace_capability VALUES (?,?,?,?)").run("hash", "alpha", "now", "mapping");
    const before = f.repository.db.prepare("SELECT * FROM workspace_capability").all();
    migrateCandidateStore(f.options.databasePath);
    assert.equal(migrateKnowledge(f.options.databasePath), 6); migrateRecallStorage(f.options.databasePath);
    assert.deepEqual(f.repository.db.prepare("SELECT * FROM workspace_capability").all(), before);
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, item.candidateId);
    assert.ok(await f.service.operation("prepare"));
  } finally { await f.cleanup(); }
});

test("version 5 upgrade preserves all persistent rows and migration failure rolls back the complete schema change", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-migration-")); const path = join(root, "data.sqlite");
  migrateKnowledge(path, false, true);
  const db = new Database(path);
  try {
    db.exec(`INSERT INTO workspace_capability VALUES ('cap','alpha','now','mapping');
      INSERT INTO recall_operation VALUES ('recall','[]','["exact phrase"]','now','[]','{}');
      INSERT INTO recall_item VALUES ('item','recall','asset','hash','GLOBAL',NULL,'FULL','[]',0);
      INSERT INTO read_operation VALUES ('read','[]','asset','hash','GLOBAL',NULL,'item','now');
      INSERT INTO used_event VALUES ('used','[]','item',NULL,'asset','now');
      INSERT INTO asset_content_version VALUES ('asset','CURRENT',X'4142','hash','now');`);
    const tables = ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event", "asset_content_version"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec("CREATE TABLE inbox_operation (conflict TEXT)");
    assert.throws(() => migrateCandidateStore(path));
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='inbox_candidate'").get(), undefined);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
    db.exec("DROP TABLE inbox_operation"); migrateCandidateStore(path);
    assert.equal(db.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.equal(migrateRecallStorage(path), 6);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
