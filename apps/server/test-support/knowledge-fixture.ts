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
import type { AssetIndexStatus, AssetScanOptions } from "../src/asset/index.js";
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
export const { AssetContentVersionRepository }: typeof import("../src/asset/content-version.js") = await import(new URL("asset/content-version.js", moduleRoot).href);
const { AssetDiffService }: typeof import("../src/asset/content-diff.js") = await import(new URL("asset/content-diff.js", moduleRoot).href);
const { createApp }: typeof import("../src/app.js") = await import(new URL("app.js", moduleRoot).href);
const http: typeof import("../src/http/index.js") = await import(new URL("http/index.js", moduleRoot).href);
const { CandidateService }: typeof import("../src/asset/candidate-service.js") = await import(new URL("asset/candidate-service.js", moduleRoot).href);
const { createMcpHttpRequestHandler }: typeof import("../src/mcp/index.js") = await import(new URL("mcp/index.js", moduleRoot).href);

export const persistentTables = ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event", "asset_content_version"] as const;
export function persistentRows(db: Database.Database) {
  return Object.fromEntries(persistentTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

export function knowledgeRuntime(options: AssetScanOptions & { databasePath: string }, indexStatus: () => AssetIndexStatus,
  refreshIndex: () => Promise<unknown> = async () => undefined) {
  const repository = new KnowledgeRepository(options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, options.workspaceConfigPath);
  const search = new assets.AssetSearchService({ ...options, refreshIndex });
  const logs: StructuredErrorLogInput[] = [];
  const service = new KnowledgeService(repository, capabilities, search, () => {
    if (indexStatus().indexState !== "READY") throw new KnowledgeError("ASSET_INDEX_UNAVAILABLE");
  }, { error: input => { logs.push(input); } });
  const projection = new KnowledgeProjection(repository, capabilities, options);
  const versions = new AssetContentVersionRepository(options.databasePath);
  const inboxService = new assets.InboxApplicationService(options, search);
  return { options, indexStatus, repository, capabilities, search, service, projection, versions, inboxService, logs,
    close: () => { search.close(); versions.close(); repository.close(); } };
}

export async function serveKnowledge(runtime: ReturnType<typeof knowledgeRuntime>, port = 0, onInternalError?: (error: unknown) => void) {
  const { options, search, service, projection, repository, versions, inboxService, indexStatus } = runtime;
  const candidateService = new CandidateService(options);
  const handler = createMcpHttpRequestHandler({ knowledgeService: service, candidateService, capabilities: runtime.capabilities, ...(onInternalError ? { onInternalError } : {}) });
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const authority = `127.0.0.1:${address.port}`, origin = `http://${authority}`;
  const app = createApp({ allowedAuthority: authority, inboxService, projection, indexStatus,
    assetService: new http.HubAssetApplicationService(search, projection, repository, new AssetDiffService(search, versions)),
    overviewService: new http.OverviewApplicationService({ ...options, inboxService, projection }),
    systemStatusService: new http.SystemStatusApplicationService({ ...options, inboxService, indexStatus, mcpEndpointReady: () => true }),
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
  const options = { repositoryPath: join(root, "repository"), databasePath: join(root, "data.sqlite"), workspaceConfigPath: join(root, "workspaces.json") };
  const config = { schemaVersion: 1, workspaces: [{ name: "alpha", paths: [join(root, "alpha")] }, { name: "beta", paths: [join(root, "beta")] }] };
  await mkdir(join(options.repositoryPath, "assets"), { recursive: true });
  await writeFile(options.workspaceConfigPath, JSON.stringify(config));
  initializeDatabase(options.databasePath);
  const index = await assets.AssetIndexManager.create(options); await index.synchronize();
  // No automatic refresh: qualification tests deliberately retain a stale Catalog.
  const runtime = knowledgeRuntime(options, () => index.status());
  // Synthetic trusted host, exclusively for this temporary repository.
  const alpha = (await runtime.capabilities.issueFromTrustedHost(join(root, "alpha")))[0]!.capabilityId;
  const beta = (await runtime.capabilities.issueFromTrustedHost(join(root, "beta")))[0]!.capabilityId;
  async function asset(input: { title: string; workspace?: string | null; type?: "MEMORY" | "DOCUMENT" | "SKILL"; summary?: string; body?: string; inbox?: boolean }) {
    const assetId = ids.next("ast"), workspace = input.workspace ?? null, type = input.type ?? "MEMORY";
    const relativePath = `${input.inbox ? "inbox" : "assets"}/${workspace ? `workspaces/${workspace}` : "global"}/${type === "MEMORY" ? "memories" : type === "DOCUMENT" ? "documents" : "skills"}/${assetId}.md`;
    const path = join(options.repositoryPath, relativePath);
    const source = ["---", `id: ${assetId}`, `type: ${type}`, `scope: ${workspace ? "WORKSPACE" : "GLOBAL"}`, ...(workspace ? [`workspace: ${workspace}`] : []),
      `title: ${JSON.stringify(input.title)}`, `summary: ${JSON.stringify(input.summary ?? "summary")}`, "---", input.body ?? "body", ""].join("\n");
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, source);
    return { assetId, path, relativePath, source };
  }
  return { ...runtime, root, config, index, alpha, beta, asset, rows: () => persistentRows(runtime.repository.db),
    close: async () => { runtime.close(); await index.close(); await rm(root, { recursive: true, force: true }); } };
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
