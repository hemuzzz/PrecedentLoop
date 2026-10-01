import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "precedent-loop-mcp-build-"));
const repositoryPath = join(fixtureRoot, "asset-repository");
const workspaceConfigPath = join(fixtureRoot, "config", "workspaces.json");
const databasePath = join(fixtureRoot, "data", "precedent-loop.sqlite");
const workspacePath = join(fixtureRoot, "workspace-alpha");
const assetId = "ast2034512345678901248";
const globalAssetId = "ast2034512345678901249";
const port = await allocatePort();
const environment = {
  ...process.env,
  PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
  PRECEDENT_LOOP_DATABASE_PATH: databasePath,
  PRECEDENT_LOOP_LOG_PATH: join(fixtureRoot, "logs", "precedent-loop.log"),
  PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
  PORT: String(port),
};
let child;
let client;

try {
  await mkdir(workspacePath, { recursive: true });
  await writeFixture(
    workspaceConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [{ name: "alpha", paths: [workspacePath] }],
    }),
  );
  await writeFixture(
    join(repositoryPath, "assets/workspaces/alpha/documents/smoke.md"),
    [
      "---",
      `id: ${assetId}`,
      "type: DOCUMENT",
      "scope: WORKSPACE",
      "workspace: alpha",
      "title: Build smoke Asset",
      "summary: verifies compiled HTTP MCP",
      "---",
      "compiled-main-search-token current-markdown-token",
      "",
    ].join("\n"),
  );
  await writeFixture(
    join(repositoryPath, "assets/global/memories/smoke.md"),
    [
      "---",
      `id: ${globalAssetId}`,
      "type: MEMORY",
      "scope: GLOBAL",
      "title: Global build smoke Asset",
      "summary: GLOBAL remains visible without capabilities",
      "---",
      "compiled-main-search-token global body",
      "",
    ].join("\n"),
  );
  await mkdir(dirname(databasePath), { recursive: true });
  // Startup never migrates; use the compiled offline installation commands.
  await runNodeOk(join("dist", "maintenance-cli.js"), ["migrate-knowledge", "--offline", "--initialize"]);
  await runNodeOk(join("dist", "maintenance-cli.js"), ["migrate-candidates", "--offline"]);
  // WorkspaceCapability is issued only by the trusted host adapter.
  const capabilityId = parseCapabilities((await runNodeOk(
    join("dist", "hook", "user-prompt-submit.js"),
    [],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: workspacePath }),
  )).stdout).find(({ workspace }) => workspace === "alpha")?.capabilityId;
  assert.notEqual(capabilityId, undefined);

  child = spawn(process.execPath, [join(serverRoot, "dist", "main.js")], {
    cwd: serverRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForListening(child);

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  client = new Client({ name: "mcp-build-smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const tools = await client.listTools();
  const toolNames = ["knowledge_recall", "asset_read", "asset_mark_used", "candidate_prepare", "candidate_update"];
  assert.deepEqual(tools.tools.map(({ name }) => name), toolNames);
  assert.deepEqual(tools.tools.find(tool => tool.name === "knowledge_recall")._meta, { "anthropic/alwaysLoad": true });
  const candidateInput = { capabilityIds: [capabilityId], type: "MEMORY", title: "构建候选", summary: "临时仓库中的结构化候选验证", conclusion: "结构化候选在隔离目录内通过正式构建的 MCP 入口写入，生成后仍须人工确认。", conditions: "仅此临时构建样本", verified: "调用并核对身份与返回字段", requestId: "build-structured-candidate" };
  const prepared = success(await client.callTool({ name: "candidate_prepare", arguments: candidateInput }));
  assert.match(prepared.path, /inbox\/workspaces\/alpha\/memories\//u);
  assert.match(prepared.display, /请在 Hub 候选管理中审核/u);
  assert.deepEqual(success(await client.callTool({ name: "candidate_prepare", arguments: candidateInput })), prepared);
  const review = success(await client.callTool({ name: "candidate_prepare", arguments: { ...candidateInput, requestId: "build-review" } }));
  assert.equal(review.status, "REVIEW_REQUIRED");
  assert.deepEqual(review.pendingCandidates.map(item => item.candidateId), [prepared.candidateId]);
  assert.equal(review.omittedBodies, 0);
  const updateInput = { capabilityIds: [capabilityId], candidateId: prepared.candidateId, candidateHash: prepared.contentHash,
    title: candidateInput.title, summary: candidateInput.summary, bodyMarkdown: review.pendingCandidates[0].bodyMarkdown + "\n\n补充：构建产物通过 HTTP MCP 修改后，仍需人工审核才能正式入库。", requestId: "build-update" };
  const updated = success(await client.callTool({ name: "candidate_update", arguments: updateInput }));
  assert.equal(updated.candidateId, prepared.candidateId);
  assert.equal(updated.assetId, prepared.assetId);
  assert.equal(updated.changed, true);
  assert.notEqual(updated.contentHash, prepared.contentHash);
  assert.match(updated.display, /已回到待审/u);
  assert.deepEqual(success(await client.callTool({ name: "candidate_update", arguments: updateInput })), updated);
  const independent = success(await client.callTool({ name: "candidate_prepare", arguments: { ...candidateInput, requestId: "build-review", reviewedCandidateIds: [prepared.candidateId] } }));
  assert.match(independent.display, /请在 Hub 候选管理中审核/u);
  assert.notEqual(independent.candidateId, prepared.candidateId);

  const recalled = success(await client.callTool({
    name: "knowledge_recall",
    arguments: { capabilityIds: [capabilityId], queries: ["compiled-main-search-token"] },
  }));
  assert.equal(recalled.usageRecorded, true);
  assert.deepEqual(recalled.authorizedWorkspaces, ["alpha"]);
  assert.deepEqual(new Set(recalled.items.map((item) => item.assetId)), new Set([assetId, globalAssetId]));
  const globalOnly = success(await client.callTool({
    name: "knowledge_recall",
    arguments: { capabilityIds: [], queries: ["compiled-main-search-token"] },
  }));
  assert.deepEqual(globalOnly.items.map((item) => item.assetId), [globalAssetId]);

  const recallItem = recalled.items.find((item) => item.assetId === assetId);
  const read = success(await client.callTool({
    name: "asset_read",
    arguments: { capabilityIds: [capabilityId], recallItemId: recallItem.recallItemId },
  }));
  assert.match(read.markdown, /current-markdown-token/);
  assert.equal(read.contentHash, recallItem.contentHash);

  const usedArguments = { capabilityIds: [capabilityId], readRef: read.readRef };
  const used = success(await client.callTool({ name: "asset_mark_used", arguments: usedArguments }));
  assert.equal(used.assetId, assetId);
  assert.equal(used.created, true);
  assert.equal(success(await client.callTool({ name: "asset_mark_used", arguments: usedArguments })).created, false);

  const outOfScope = await client.callTool({ name: "asset_read", arguments: { capabilityIds: [], assetId } });
  assert.equal(errorCode(outOfScope), "ASSET_NOT_ACCESSIBLE");
  const forged = await client.callTool({
    name: "knowledge_recall",
    arguments: { capabilityIds: [`cap_${"A".repeat(43)}`], queries: ["compiled-main-search-token"] },
  });
  assert.equal(errorCode(forged), "CAPABILITY_INVALID");

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  process.stdout.write(`${JSON.stringify({ event: "MCP_BUILD_SMOKE", status: "ok", tools: toolNames })}\n`);
} finally {
  await client?.close();
  await stopChild(child);
  await rm(fixtureRoot, { force: true, recursive: true });
}

function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(result.structuredContent, undefined);
  return JSON.parse(result.content[0].text);
}

function errorCode(result) {
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text).error.code;
}

function parseCapabilities(stdout) {
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  return JSON.parse(context.split("Precedent Loop WorkspaceCapability\n")[1].split("\n")[0]);
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function runNodeOk(script, args, stdin = "") {
  const spawned = spawn(process.execPath, [script, ...args], {
    cwd: serverRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  spawned.stdout.setEncoding("utf8");
  spawned.stderr.setEncoding("utf8");
  spawned.stdout.on("data", (chunk) => { stdout += chunk; });
  spawned.stderr.on("data", (chunk) => { stderr += chunk; });
  spawned.stdin.end(stdin);
  const code = await new Promise((resolve, reject) => {
    spawned.once("error", reject);
    spawned.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  assert.equal(code, 0, `${script} failed: ${stderr}`);
  assert.equal(stderr, "", script);
  return { stdout, stderr };
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function waitForListening(process) {
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Server start timeout: ${stderr}`)), 10_000);
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"event":"listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    process.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before listening: code=${String(code)} stderr=${stderr}`));
    });
  });
}

async function stopChild(process) {
  if (process === undefined || process.exitCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server stop timeout")), 10_000);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill("SIGTERM");
  });
}
