import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { generateWorkspaceCapability, SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RecallResult } from "../src/knowledge/model.js";
import type { KnowledgeService } from "../src/knowledge/service.js";
import { knowledgeFixture, serveKnowledge, toolData, toolPayload, callTool } from "../test-support/knowledge-fixture.js";
import { SERVER_ASSET_REPOSITORY_PATH_ENV, ServerConfigurationError, serverConfigurationFromEnvironment } from "../src/runtime.js";

type ReadResult = Awaited<ReturnType<KnowledgeService["read"]>>;
type UsedResult = Awaited<ReturnType<KnowledgeService["used"]>>;
const idGenerator = new SnowflakeIdGenerator();

async function fixture() {
  const f = await knowledgeFixture();
  const global = await f.asset({ title: "shared", body: "global-only common guidance" });
  const alphaAsset = await f.asset({ title: "shared", workspace: "alpha", type: "DOCUMENT", body: "alpha-only 中 guidance" });
  const betaAsset = await f.asset({ title: "shared", workspace: "beta", body: "beta-only private guidance" });
  await f.index.synchronize();
  const internalErrors: unknown[] = [];
  const endpoint = await serveKnowledge(f, 0, error => { internalErrors.push(error); });
  const client = await endpoint.connect();
  return { ...f, global, alphaAsset, betaAsset, endpoint, client, internalErrors,
    close: async () => { await endpoint.close(); await f.close(); } };
}
function businessError(result: CallToolResult, code: string, root: string) {
  assert.equal(result.isError, true);
  assert.deepEqual(toolPayload(result), { error: { code } });
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.doesNotMatch(JSON.stringify(result), /stack|SQLITE|Error:| at /u);
}

test("MCP exposes five strict object-root tools and rejects authority overrides before writing facts", async () => {
  const f = await fixture();
  try {
    const definitions = (await f.client.listTools()).tools;
    assert.deepEqual(definitions.map(tool => tool.name), ["knowledge_recall", "asset_read", "asset_mark_used", "candidate_prepare", "candidate_update"]);
    assert.deepEqual(definitions[0]!._meta, { "anthropic/alwaysLoad": true });
    const properties = [
      ["capabilityIds", "queries"], ["assetId", "capabilityIds", "expectedContentHash", "recallItemId"],
      ["capabilityIds", "readRef", "recallItemId"],
      ["bodyMarkdown", "capabilityIds", "conclusion", "conditions", "coverage", "evidence", "prerequisites", "purpose", "reasons", "recheckPoints", "related", "requestId", "reviewedCandidateIds", "revision", "steps", "stopConditions", "summary", "title", "trigger", "type", "unverified", "verification", "verified"],
      ["bodyMarkdown", "candidateHash", "candidateId", "capabilityIds", "requestId", "summary", "title"],
    ];
    definitions.forEach((tool, i) => {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), properties[i]);
      assert.ok(tool.inputSchema.required!.includes("capabilityIds"));
    });
    const read = await f.service.read({ capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId });
    const before = f.rows();
    for (const [name, args] of [
      ["knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }],
      ["asset_read", { capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId }],
      ["asset_mark_used", { capabilityIds: [f.alpha], readRef: read.readRef }],
    ] as const) {
      for (const forbidden of ["workspace", "path", "filePath", "taskId"]) {
        const result = await callTool(f.client, name, { ...args, [forbidden]: "forbidden" });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.equal(result.content.length, 1);
        assert.deepEqual(f.rows(), before);
      }
    }
    for (const args of [
      { capabilityIds: [], assetId: f.global.assetId, recallItemId: idGenerator.next("usg") },
      { capabilityIds: [] },
    ]) {
      assert.equal((await callTool(f.client, "asset_read", args)).isError, true);
      assert.deepEqual(f.rows(), before);
    }
    // The service's strict boundary uses INPUT_INVALID; SDK schema rejections happen before execution.
    await assert.rejects(f.service.recall({ capabilityIds: [], queries: [], taskId: "forbidden" }), { code: "INPUT_INVALID" });
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});

test("MCP capabilities select alpha plus GLOBAL or GLOBAL only; Read returns current bytes and enforces hashes", async () => {
  const f = await fixture();
  try {
    const recall = toolData<RecallResult>(await callTool(f.client, "knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }));
    assert.deepEqual(recall.items.map(item => item.assetId), [f.alphaAsset.assetId, f.global.assetId]);
    const global = toolData<RecallResult>(await callTool(f.client, "knowledge_recall", { capabilityIds: [], queries: ["shared"] }));
    assert.deepEqual(global.items.map(item => item.assetId), [f.global.assetId]);
    const item = recall.items[0]!;
    const first = toolData<ReadResult>(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], recallItemId: item.recallItemId }));
    assert.equal(first.markdown, f.alphaAsset.source);
    assert.equal(first.contentHash, createHash("sha256").update(first.markdown).digest("hex"));
    const changed = f.alphaAsset.source + "current Markdown replacement\n";
    await writeFile(f.alphaAsset.path, changed);
    const current = toolData<ReadResult>(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId }));
    assert.equal(current.markdown, changed);
    assert.equal(current.contentHash, createHash("sha256").update(changed).digest("hex"));
    const before = f.rows();
    for (const target of [{ recallItemId: item.recallItemId }, { assetId: item.assetId, expectedContentHash: item.contentHash }]) {
      businessError(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], ...target }), "CONTENT_CHANGED", f.root);
      assert.deepEqual(f.rows(), before);
    }
    businessError(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], assetId: f.betaAsset.assetId }), "ASSET_NOT_ACCESSIBLE", f.root);
    businessError(await callTool(f.client, "asset_read", { capabilityIds: [], assetId: f.alphaAsset.assetId }), "ASSET_NOT_ACCESSIBLE", f.root);
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});

test("MCP business and internal errors are redacted and internal failures invoke the callback", async () => {
  const f = await fixture();
  try {
    const before = f.rows();
    businessError(await callTool(f.client, "knowledge_recall", { capabilityIds: [generateWorkspaceCapability()], queries: ["shared"] }), "CAPABILITY_INVALID", f.root);
    businessError(await callTool(f.client, "asset_read", { capabilityIds: [], assetId: idGenerator.next("ast") }), "ASSET_NOT_ACCESSIBLE", f.root);
    await unlink(f.alphaAsset.path);
    businessError(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId }), "ASSET_NOT_ACCESSIBLE", f.root);
    assert.deepEqual(f.rows(), before);
    f.repository.close();
    businessError(await callTool(f.client, "knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }), "INTERNAL_ERROR", f.root);
    assert.equal(f.internalErrors.length, 1);
  } finally { await f.close(); }
});

test("MCP distinguishes invalid Workspace configuration from unavailable Catalog/FTS", async () => {
  const f = await fixture();
  try {
    f.repository.db.exec("CREATE TRIGGER fail_index BEFORE INSERT ON asset_catalog BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await writeFile(f.alphaAsset.path, f.alphaAsset.source + "changed");
    assert.equal(await f.index.synchronize(), null);
    const before = f.rows();
    businessError(await callTool(f.client, "knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }), "ASSET_INDEX_UNAVAILABLE", f.root);
    await writeFile(f.options.workspaceConfigPath, "{invalid");
    businessError(await callTool(f.client, "knowledge_recall", { capabilityIds: [], queries: ["shared"] }), "WORKSPACE_CONFIG_UNAVAILABLE", f.root);
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});

test("HTTP clients reconnect after a service restart and fail while it is offline", async () => {
  const f = await knowledgeFixture();
  let endpoint = await serveKnowledge(f);
  try {
    const asset = await f.asset({ title: "restart" }); await f.index.synchronize();
    const client = await endpoint.connect(), port = endpoint.port;
    assert.equal(toolData<ReadResult>(await callTool(client, "asset_read", { capabilityIds: [], assetId: asset.assetId })).assetId, asset.assetId);
    await endpoint.close();
    await assert.rejects(fetch(endpoint.origin + "/mcp", { signal: AbortSignal.timeout(1000) }));
    endpoint = await serveKnowledge(f, port);
    const reconnected = await endpoint.connect();
    assert.equal(toolData<ReadResult>(await callTool(reconnected, "asset_read", { capabilityIds: [], assetId: asset.assetId })).assetId, asset.assetId);
    assert.equal(f.projection.totals().reads, 2);
  } finally { await endpoint.close(); await f.close(); }
});

test("eight simultaneous MCP clients never share capabilities or delivered fact scopes", async () => {
  const f = await fixture();
  try {
    const clients = await Promise.all(Array.from({ length: 8 }, () => f.endpoint.connect()));
    const results = await Promise.all(clients.map(async (client, i) => {
      const capabilityIds = [i % 2 ? f.beta : f.alpha];
      const assetId = i % 2 ? f.betaAsset.assetId : f.alphaAsset.assetId;
      const recall = toolData<RecallResult>(await callTool(client, "knowledge_recall", { capabilityIds, queries: ["shared"] }));
      assert.deepEqual(new Set(recall.items.map(item => item.assetId)), new Set([assetId, f.global.assetId]));
      for (const item of recall.items) {
        const read = toolData<ReadResult>(await callTool(client, "asset_read", { capabilityIds, recallItemId: item.recallItemId }));
        assert.deepEqual(read.authorizedWorkspaces, [i % 2 ? "beta" : "alpha"]);
        assert.deepEqual(f.repository.readFact(read.readRef!)!.authorizedWorkspaces, read.authorizedWorkspaces);
      }
      assert.deepEqual(f.projection.recall(recall.recallId!)!.operation.authorizedWorkspaces, recall.authorizedWorkspaces);
      return recall;
    }));
    assert.equal(new Set(results.map(result => result.recallId)).size, 8);
    assert.deepEqual(f.projection.totals(), { recallOperations: 8, recallItems: 16, reads: 16, used: 0 });
  } finally { await f.close(); }
});

test("only delivered items and successful Reads write facts; Used is source-idempotent and rejects cross-scope sources", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) await f.asset({ title: "shared " + i, workspace: "alpha" });
    await f.index.synchronize();
    const recall = toolData<RecallResult>(await callTool(f.client, "knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }));
    assert.equal(recall.items.length, 8);
    assert.deepEqual(f.projection.items("i.recall_id=?", recall.recallId!).map(item => item.assetId), recall.items.map(item => item.assetId));
    const item = recall.items.find(item => item.assetWorkspace === "alpha")!;
    const read = toolData<ReadResult>(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], recallItemId: item.recallItemId }));
    const first = toolData<UsedResult>(await callTool(f.client, "asset_mark_used", { capabilityIds: [f.alpha], recallItemId: item.recallItemId }));
    assert.equal(first.created, true);
    const before = f.rows();
    const again = toolData<UsedResult>(await callTool(f.client, "asset_mark_used", { capabilityIds: [f.alpha], readRef: read.readRef }));
    assert.equal(again.created, false); assert.equal(again.usedId, first.usedId);
    for (const target of [{ recallItemId: item.recallItemId }, { readRef: read.readRef }]) {
      businessError(await callTool(f.client, "asset_mark_used", { capabilityIds: [f.beta], ...target }), "ASSET_NOT_ACCESSIBLE", f.root);
    }
    businessError(await callTool(f.client, "asset_read", { capabilityIds: [f.beta], recallItemId: item.recallItemId }), "ASSET_NOT_ACCESSIBLE", f.root);
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.projection.totals(), { recallOperations: 1, recallItems: 8, reads: 1, used: 1 });
  } finally { await f.close(); }
});

test("SQL write failure degrades Recall/Read delivery without stable references and rejects Used without partial facts", async () => {
  const f = await fixture();
  try {
    const read = await f.service.read({ capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId });
    const before = f.rows();
    for (const table of ["recall_item", "read_operation", "used_event"]) f.repository.db.exec(
      `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    const recall = toolData<RecallResult>(await callTool(f.client, "knowledge_recall", { capabilityIds: [f.alpha], queries: ["shared"] }));
    assert.equal(recall.usageRecorded, false); assert.equal(recall.recallId, null);
    assert.deepEqual(recall.items.map(item => item.assetId), [f.alphaAsset.assetId, f.global.assetId]);
    assert.ok(recall.items.every(item => item.recallItemId === null));
    assert.ok(recall.diagnostics.includes("USAGE_WRITE_FAILED"));
    const delivered = toolData<ReadResult>(await callTool(f.client, "asset_read", { capabilityIds: [f.alpha], assetId: f.alphaAsset.assetId }));
    assert.equal(delivered.markdown, f.alphaAsset.source); assert.equal(delivered.readRef, null);
    assert.equal(delivered.usageRecorded, false); assert.deepEqual(delivered.diagnostics, ["USAGE_WRITE_FAILED"]);
    businessError(await callTool(f.client, "asset_mark_used", { capabilityIds: [f.alpha], readRef: read.readRef }), "USAGE_WRITE_FAILED", f.root);
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.logs.map(({ event, operation, assetId, assetIds, errorCode }) => ({ event, operation, assetId, assetIds, errorCode })), [
      { event: "USAGE_RECALL_WRITE_FAILED", operation: "knowledge_recall", assetId: undefined, assetIds: [f.alphaAsset.assetId, f.global.assetId], errorCode: "USAGE_WRITE_FAILED" },
      { event: "USAGE_READ_WRITE_FAILED", operation: "asset_read", assetId: f.alphaAsset.assetId, assetIds: undefined, errorCode: "USAGE_WRITE_FAILED" },
      { event: "USAGE_USED_WRITE_FAILED", operation: "asset_mark_used", assetId: f.alphaAsset.assetId, assetIds: undefined, errorCode: "USAGE_WRITE_FAILED" },
    ]);
    assert.ok(f.logs.every(entry => entry.error instanceof Error && entry.error.cause instanceof Error && /fixture/u.test(entry.error.cause.message)));
    for (const table of ["recall_item", "read_operation", "used_event"]) f.repository.db.exec(`DROP TRIGGER fail_${table}`);
    assert.equal((await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef })).created, true);
    assert.equal((await f.service.recall({ capabilityIds: [f.alpha], queries: ["shared"] })).usageRecorded, true);
  } finally { await f.close(); }
});

test("HTTP rejects foreign Host/Origin and keeps malformed transport messages distinct from business errors", async () => {
  const f = await fixture();
  try {
    const before = f.rows(), host = `127.0.0.1:${f.endpoint.port}`;
    for (const headers of [{ host: "evil.invalid" }, { host, origin: "https://evil.invalid" }, { host, origin: "null" }]) {
      const response = await rawRequest(f.endpoint.port, "{", headers);
      assert.equal(response.statusCode, 403); assert.match(response.body, /forbidden_host_or_origin/);
    }
    const malformed = await rawRequest(f.endpoint.port, "{", { host, accept: "application/json, text/event-stream" });
    assert.equal(malformed.statusCode, 400); assert.match(malformed.body, /-32700|Parse error/i);
    assert.equal(malformed.body.includes(f.root), false);
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});

test("N07 server configuration requires explicit absolute local data paths", () => {
  assert.throws(() => serverConfigurationFromEnvironment({}), ServerConfigurationError);
  assert.throws(
    () => serverConfigurationFromEnvironment({
      [SERVER_ASSET_REPOSITORY_PATH_ENV]: "relative-assets",
      PRECEDENT_LOOP_DATABASE_PATH: "/tmp/catalog.sqlite",
      PRECEDENT_LOOP_WORKSPACES_PATH: "/tmp/workspaces.json",
    }),
    ServerConfigurationError,
  );
  assert.throws(
    () => serverConfigurationFromEnvironment({
      [SERVER_ASSET_REPOSITORY_PATH_ENV]: "/tmp/assets",
      PRECEDENT_LOOP_DATABASE_PATH: "/tmp/catalog.sqlite",
      PRECEDENT_LOOP_LOG_PATH: "/tmp/precedent-loop.log",
      PRECEDENT_LOOP_WORKSPACES_PATH: "/tmp/workspaces.json",
      PORT: "70000",
    }),
    ServerConfigurationError,
  );
  assert.deepEqual(
    serverConfigurationFromEnvironment({
      [SERVER_ASSET_REPOSITORY_PATH_ENV]: "/tmp/assets",
      PRECEDENT_LOOP_DATABASE_PATH: "/tmp/catalog.sqlite",
      PRECEDENT_LOOP_LOG_PATH: "/tmp/precedent-loop.log",
      PRECEDENT_LOOP_WORKSPACES_PATH: "/tmp/workspaces.json",
      PORT: "43100",
    }),
    {
      assetRepositoryPath: "/tmp/assets",
      databasePath: "/tmp/catalog.sqlite",
      workspaceConfigPath: "/tmp/workspaces.json",
      logPath: "/tmp/precedent-loop.log",
      port: 43100,
    },
  );
});

async function rawRequest(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ body: string; statusCode: number }> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => resolve({ body: responseBody, statusCode: response.statusCode ?? 0 }));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
