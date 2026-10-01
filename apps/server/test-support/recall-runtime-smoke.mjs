import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Point only at an isolated build, keeping the installed service and dist untouched.
const buildRoot = process.env.PRECEDENT_LOOP_SMOKE_BUILD_ROOT;
if (!buildRoot || !isAbsolute(buildRoot)) throw new Error("An absolute isolated build root is required");
const dist = join(buildRoot, "apps/server/dist");
const { startPrecedentLoopServer } = await import(pathToFileURL(join(dist, "runtime.js")).href);
const { initializeDatabase } = await import(pathToFileURL(join(dist, "storage/schema.js")).href);
const { handleCodexHook } = await import(pathToFileURL(join(dist, "hook/user-prompt-submit.js")).href);
const directory = await mkdtemp(join(tmpdir(), "codex-recall-runtime-"));
const repositoryPath = join(directory, "repository");
const databasePath = join(directory, "knowledge.sqlite");
const workspaceConfigPath = join(directory, "workspaces.json");
const assetId = "ast2034512345678901248";
let runtime;
const client = new Client({ name: "recall-runtime-smoke", version: "1" });
try {
  await mkdir(join(repositoryPath, "assets/workspaces/alpha/memories"), { recursive: true });
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1,
    workspaces: [{ name: "alpha", paths: [directory], aliases: ["测试项目"], description: "隔离验证" }] }));
  await writeFile(join(repositoryPath, `assets/workspaces/alpha/memories/${assetId}.md`),
    `---\nid: ${assetId}\ntype: MEMORY\nscope: WORKSPACE\nworkspace: alpha\ntitle: 业务字典\nsummary: 字典配置位于 DictConfig。\n---\n\n# 业务字典\n\n隔离构建验收正文。Native Memories 与 KNOWLEDGE.md。\n`);
  await writeFile(join(repositoryPath, "assets/workspaces/alpha/memories/ast2034512345678901249.md"),
    "---\nid: ast2034512345678901249\ntype: MEMORY\nscope: WORKSPACE\nworkspace: alpha\ntitle: Native tooling and unrelated Memories\nsummary: KNOWLEDGEXmd\n---\n干扰样本。\n");
  initializeDatabase(databasePath);
  const context = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: directory },
    { databasePath, workspaceConfigPath });
  const additionalContext = JSON.parse(context).hookSpecificOutput.additionalContext;
  const capability = JSON.parse(additionalContext.split("Precedent Loop WorkspaceCapability\n")[1].split("\n")[0])[0].capabilityId;
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const availablePort = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  runtime = await startPrecedentLoopServer({ assetRepositoryPath: repositoryPath, databasePath,
    workspaceConfigPath, logPath: join(directory, "runtime.log"), port: availablePort });
  const port = runtime.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    return (await response.json()).data;
  };
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await get("/api/system/status")).service.readiness, "READY");
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["asset_mark_used", "asset_read", "knowledge_recall"]);
  const removedInput = await client.callTool({ name: "knowledge_recall", arguments:
    { capabilityIds: [capability], queries: ["业务字典"], scenarios: [] } });
  assert.equal(removedInput.isError, true);
  const parse = result => { assert.equal(result.isError, undefined); return JSON.parse(result.content[0].text); };
  const recalled = parse(await client.callTool({ name: "knowledge_recall", arguments:
    { capabilityIds: [capability], queries: ["Native Memories", "字典", "KNOWLEDGE.md"] } }));
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].assetId, assetId);
  assert.equal(recalled.items[0].deliveredMode, "DIRECT");
  assert.ok(Array.from(JSON.stringify(recalled)).length <= 5000);
  const read = parse(await client.callTool({ name: "asset_read", arguments:
    { capabilityIds: [capability], recallItemId: recalled.items[0].recallItemId } }));
  assert.ok(read.markdown.includes("隔离构建验收正文"));
  const usedArgs = { capabilityIds: [capability], readRef: read.readRef };
  assert.equal(parse(await client.callTool({ name: "asset_mark_used", arguments: usedArgs })).created, true);
  assert.equal(parse(await client.callTool({ name: "asset_mark_used", arguments: usedArgs })).created, false);
  const history = await get(`/api/recalls/${recalled.recallId}`);
  assert.deepEqual(history.operation.queries, ["Native Memories", "字典", "KNOWLEDGE.md"]);
  assert.equal(history.items[0].readCount, 1); assert.equal(history.items[0].totalUsedCount, 1);
  const workspaces = await get("/api/workspaces");
  assert.equal(workspaces.items[0].assetCount, 2);
  assert.equal(workspaces.items[0].authorizedRecallCount, 1);
  const { asset: detail } = await get(`/api/assets/${assetId}`);
  assert.equal(detail.recentRecalls.length, 1);
  assert.equal(detail.usageSummary.totalUsedCount, 1);
  assert.equal((await get("/api/usage")).total, 2);
  assert.equal((await fetch(base + "/api/removed-feature")).status, 404);
  assert.equal((await fetch(base + "/api/scenarios")).status, 404);
  assert.equal((await fetch(base + "/api/recalls", { method: "POST" })).status, 405);
  assert.equal((await fetch(base + "/api/recalls", { headers: { origin: "https://invalid.example" } })).status, 403);
  console.log(JSON.stringify({ status: "PASS", url: base, assetId, recallId: recalled.recallId,
    checks: ["Hub static serving", "HTTP MCP literal phrase/filename/short expression", "Recall/Read/Used", "REST projections", "method/origin boundary"],
    isolated: true, realDesktopAcceptance: false }));
  if (process.env.PRECEDENT_LOOP_SMOKE_KEEP_OPEN === "1") {
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally {
  await client.close();
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
