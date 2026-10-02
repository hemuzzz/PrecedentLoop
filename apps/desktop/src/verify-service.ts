import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Backend } from "./backend.js";
import { appConfigSchema, nodeEnvironment, executeFile, readBuildInfo, runtimeConfig, verifyBundledNode, type RuntimeConfig } from "./config.js";
import { initializeDataDirectory, inspectDataDirectory } from "./data-directory.js";

export async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("临时端口不可用");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function prepareFixture(resources: string, directory: string): Promise<{ config: RuntimeConfig; capability: string; assetId: string }> {
  const runtime = join(resources, "runtime");
  await initializeDataDirectory(directory, runtime);
  assert.deepEqual(await inspectDataDirectory(directory), { kind: "PRODUCT", storageVersion: 2 });
  const nodePath = await verifyBundledNode(runtime);
  const config = runtimeConfig(appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: true,
    dataDirectory: directory, port: await allocatePort() }));
  const assetId = "ast2034512345678901248";
  await writeFile(config.workspaceConfigPath, JSON.stringify({ schemaVersion: 1,
    workspaces: [{ name: "alpha", paths: [directory] }] }));
  // Execute the packaged ordinary-Node code only against this newly-created fixture.
  const { stdout } = await executeFile(nodePath, ["--input-type=module", "-e", `
    import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
    const [dist,db,config,cwd]=process.argv.slice(1);
    const {openDatabase}=await import(pathToFileURL(join(dist,'storage/schema.js')));
    const {AssetRepository}=await import(pathToFileURL(join(dist,'asset/asset-repository.js')));
    const {CandidateRepository}=await import(pathToFileURL(join(dist,'asset/candidate-repository.js')));
    const database=openDatabase(db);
    try { new CandidateRepository(database).write('fixture','accept','fixture',()=>new AssetRepository(database).insert({
      assetId:'${assetId}',type:'MEMORY',scope:'WORKSPACE',workspace:'alpha',title:'桌面验收',summary:'桌面验收唯一词',bodyMarkdown:'# 桌面验收\\n\\n桌面验收唯一词。'
    })); } finally { database.close(); }
    const {handleCodexHook}=await import(pathToFileURL(join(dist,'hook/user-prompt-submit.js')));
    const output=JSON.parse(await handleCodexHook({hook_event_name:'UserPromptSubmit',cwd},{databasePath:db,workspaceConfigPath:config}));
    const capabilityLine=output.hookSpecificOutput.additionalContext.split('Precedent Loop WorkspaceCapability\\n')[1]?.split('\\n')[0];
    if (!capabilityLine) throw new Error('Hook output is missing the WorkspaceCapability section');
    console.log(JSON.stringify(JSON.parse(capabilityLine)[0].capabilityId));
  `, join(resources, "runtime/apps/server/dist"), config.databasePath, config.workspaceConfigPath, directory], {
    cwd: directory, env: nodeEnvironment(), timeout: 15000,
  });
  return { config, capability: z.string().parse(JSON.parse(stdout)), assetId };
}

async function callTool(origin: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${origin}/mcp`, { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json: unknown = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(body.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? "null") : JSON.parse(body);
  const result = z.object({ result: z.object({ isError: z.literal(false).optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1) }) }).parse(json);
  return JSON.parse(result.result.content[0]!.text) as unknown;
}

export async function verifyPackagedService(resources: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-desktop-service-"));
  let backend: Backend | undefined;
  try {
    const { config, capability, assetId } = await prepareFixture(resources, directory);
    const build = await readBuildInfo(join(resources, "runtime"));
    backend = new Backend(join(resources, "runtime"), config, build);
    await backend.start();
    const inbox = await fetch(`${backend.origin}/api/inbox`).then(response => response.json()) as { data: { managed: boolean } };
    assert.equal(inbox.data.managed, true);
    assert.equal((await fetch(backend.origin)).status, 200);
    const recalled = z.object({ items: z.array(z.object({ assetId: z.string(), recallItemId: z.string() })).min(1) }).parse(
      await callTool(backend.origin, "knowledge_recall", { capabilityIds: [capability], queries: ["桌面验收唯一词"] }));
    assert.equal(recalled.items[0]!.assetId, assetId);
    const read = z.object({ readRef: z.string(), markdown: z.string() }).parse(await callTool(backend.origin, "asset_read", {
      capabilityIds: [capability], recallItemId: recalled.items[0]!.recallItemId,
    }));
    assert.match(read.markdown, /桌面验收唯一词/);
    const used = z.object({ created: z.boolean() }).parse(await callTool(backend.origin, "asset_mark_used", {
      capabilityIds: [capability], readRef: read.readRef,
    }));
    assert.equal(used.created, true);
    assert.equal((await fetch(`${backend.origin}/api/assets`, { headers: { origin: "https://invalid.example" } })).status, 403);
    // Keep an actual /mcp HTTP request body open while stopping the packaged runtime.
    const active = request(`${backend.origin}/mcp`, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
    } });
    active.on("error", () => { /* Closing an active request is an expected shutdown result. */ });
    const closed = new Promise<void>(resolve => active.once("close", resolve));
    active.write('{"jsonrpc":"2.0",');
    active.flushHeaders();
    await new Promise<void>(resolve => active.once("socket", socket => {
      if (socket.connecting) socket.once("connect", resolve); else resolve();
    }));
    await backend.stop();
    await closed;
    process.stdout.write(JSON.stringify({ isolatedService: "PASS", buildId: build.buildId, checks: ["initialize-baseline-2", "IPC", "readiness", "Hub", "Recall/Read/Used", "Origin", "shutdown"] }) + "\n");
  } finally {
    await backend?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2];
  if (!appPath || !isAbsolute(appPath) || !appPath.endsWith(".app")) {
    throw new Error("请提供待验收 .app 的绝对路径");
  }
  await verifyPackagedService(join(appPath, "Contents/Resources"));
}
