import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import type { CandidateOptions } from "../src/asset/candidate-service.js";
import type { StructuredErrorLogInput } from "../src/logging.js";

// Reuse the same assertions when explicitly running against fresh build output.
export const moduleRoot = new URL(process.env.PRECEDENT_LOOP_TEST_DIST === "1" ? "../dist/" : "../src/", import.meta.url);
export const assets: typeof import("../src/asset/index.js") = await import(new URL("asset/index.js", moduleRoot).href);
export const { KnowledgeRepository }: typeof import("../src/knowledge/repository.js") = await import(new URL("knowledge/repository.js", moduleRoot).href);
export const { KnowledgeProjection }: typeof import("../src/knowledge/projection.js") = await import(new URL("knowledge/projection.js", moduleRoot).href);
export const { KnowledgeService }: typeof import("../src/knowledge/service.js") = await import(new URL("knowledge/service.js", moduleRoot).href);
export const { KnowledgeError }: typeof import("../src/knowledge/model.js") = await import(new URL("knowledge/model.js", moduleRoot).href);
export const { WorkspaceCapabilityService }: typeof import("../src/workspace/capability.js") = await import(new URL("workspace/capability.js", moduleRoot).href);
export const { initializeDatabase }: typeof import("../src/storage/schema.js") = await import(new URL("storage/schema.js", moduleRoot).href);
export const { AssetRepository }: typeof import("../src/asset/asset-repository.js") = await import(new URL("asset/asset-repository.js", moduleRoot).href);
export const { CandidateRepository }: typeof import("../src/asset/candidate-repository.js") = await import(new URL("asset/candidate-repository.js", moduleRoot).href);
const { AssetDiffService }: typeof import("../src/asset/content-diff.js") = await import(new URL("asset/content-diff.js", moduleRoot).href);
const { createApp }: typeof import("../src/app.js") = await import(new URL("app.js", moduleRoot).href);
const http: typeof import("../src/http/index.js") = await import(new URL("http/index.js", moduleRoot).href);
const { CandidateService }: typeof import("../src/asset/candidate-service.js") = await import(new URL("asset/candidate-service.js", moduleRoot).href);
const { createMcpHttpRequestHandler }: typeof import("../src/mcp/index.js") = await import(new URL("mcp/index.js", moduleRoot).href);

export const persistentTables = ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event"] as const;
export function persistentRows(db: Database.Database) {
  return Object.fromEntries(persistentTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

export function knowledgeRuntime(options: CandidateOptions) {
  const repository = new KnowledgeRepository(options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, options.workspaceConfigPath);
  const search = new assets.AssetSearchService(options);
  const logs: StructuredErrorLogInput[] = [];
  const service = new KnowledgeService(repository, capabilities, search, { error: input => { logs.push(input); } });
  const projection = new KnowledgeProjection(repository, capabilities, options);
  const candidateService = new CandidateService(options);
  const inboxService = { scan: () => candidateService.list() };
  return { options, repository, capabilities, search, service, projection, candidateService, inboxService, logs,
    close: () => { search.close(); repository.close(); } };

}

export async function serveKnowledge(runtime: ReturnType<typeof knowledgeRuntime>, port = 0, onInternalError?: (error: unknown) => void) {
  const { options, search, service, projection, repository, inboxService } = runtime;
  const candidateService = new CandidateService(options);
  const handler = createMcpHttpRequestHandler({ knowledgeService: service, candidateService, capabilities: runtime.capabilities, ...(onInternalError ? { onInternalError } : {}) });
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const authority = `127.0.0.1:${address.port}`, origin = `http://${authority}`;
  const app = createApp({ allowedAuthority: authority, inboxService, projection, candidateService,
    assetService: new http.HubAssetApplicationService(search, projection, repository, new AssetDiffService(search)),
    overviewService: new http.OverviewApplicationService({ ...options, candidateService, projection }),
    systemStatusService: new http.SystemStatusApplicationService({ ...options, candidateService, mcpEndpointReady: () => true }),
    ...(onInternalError ? { onInternalError } : {}),
  });
  const rest = getRequestListener(app.fetch);
  server.on("request", (request, response) => void (request.url === "/mcp" ? handler(request, response) : rest(request, response)));
  const clients: Client[] = [];
  async function connect() {
    const client = new Client({ name: "knowledge-test", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)) as unknown as Transport);
    return client;
  }
  return { origin, port: address.port, server, app, connect,
    close: async () => {
      await Promise.all(clients.map(client => client.close()));
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    } };
}

const ids = new SnowflakeIdGenerator();
export async function knowledgeFixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-test-"));
  const options = { databasePath: join(root, "data.sqlite"), workspaceConfigPath: join(root, "workspaces.json") };
  const config = { schemaVersion: 1, workspaces: [{ name: "alpha", paths: [join(root, "alpha")] }, { name: "beta", paths: [join(root, "beta")] }] };
  await writeFile(options.workspaceConfigPath, JSON.stringify(config));
  initializeDatabase(options.databasePath);
  const runtime = knowledgeRuntime(options);
  const alpha = (await runtime.capabilities.issueFromTrustedHost(join(root, "alpha")))[0]!.capabilityId;
  const beta = (await runtime.capabilities.issueFromTrustedHost(join(root, "beta")))[0]!.capabilityId;
  const records = new AssetRepository(runtime.repository.db), writes = new CandidateRepository(runtime.repository.db);
  async function asset(input: { title: string; workspace?: string | null; type?: "MEMORY" | "DOCUMENT" | "SKILL"; summary?: string; retrievalTerms?: string[]; body?: string; inbox?: boolean }) {
    const assetId = ids.next("ast"), workspace = input.workspace ?? null;
    const content = { assetId, workspace, scope: workspace ? "WORKSPACE" as const : "GLOBAL" as const,
      title: input.title, type: input.type ?? "MEMORY" as const, summary: input.summary ?? "summary", retrievalTerms: input.retrievalTerms ?? [], bodyMarkdown: input.body ?? "body" };
    writes.write(ids.next("tsk"), "accept", assetId, () => input.inbox
      ? writes.insert({ ...content, candidateId: ids.next("cnd"), intent: "NEW", baseVersion: null }) : records.insert(content));
    return { assetId, source: content.bodyMarkdown };
  }
  function revise(assetId: string, content: Partial<{ title: string; summary: string; retrievalTerms: string[]; bodyMarkdown: string }>) {
    const current = records.get(assetId)!;
    return writes.write(ids.next("tsk"), "accept", assetId, () => records.revise(assetId, current.version, { ...current, ...content }));
  }
  function remove(assetId: string) { writes.write(ids.next("tsk"), "delete", assetId, () => { records.delete(assetId); return { deleted: true }; }); }
  return { ...runtime, root, config, alpha, beta, asset, records, revise, remove, rows: () => persistentRows(runtime.repository.db),
    close: async () => { runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return await client.callTool({ name, arguments: args }) as CallToolResult;
}
export function toolData<T>(result: CallToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return toolPayload<T>(result);
}
export function toolPayload<T>(result: CallToolResult): T {
  assert.equal(result.structuredContent, undefined); assert.equal(result.content.length, 1);
  const block = result.content[0]!; assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("Expected a text block");
  return JSON.parse(block.text) as T;
}
