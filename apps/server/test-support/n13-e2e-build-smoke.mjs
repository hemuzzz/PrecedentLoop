import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "precedent-loop-n13-e2e-"));
const repositoryPath = join(fixtureRoot, "asset-repository");
const workspaceConfigPath = join(fixtureRoot, "config", "workspaces.json");
const databasePath = join(fixtureRoot, "data", "precedent-loop.sqlite");
const logPath = join(fixtureRoot, "logs", "precedent-loop.log");
const workspaceRoot = join(fixtureRoot, "workspaces");
const alphaWorkspacePath = join(workspaceRoot, "alpha-project");
const betaWorkspacePath = join(workspaceRoot, "beta-project");
const outsideWorkspacePath = join(fixtureRoot, "outside-workspace");
const port = await allocatePort();
const origin = `http://127.0.0.1:${port}`;
const idGenerator = new SnowflakeIdGenerator();
const ids = {
  alphaDocument: idGenerator.next("ast"),
  alphaMemory: idGenerator.next("ast"),
  alphaSkill: idGenerator.next("ast"),
  betaMemory: idGenerator.next("ast"),
  globalDocument: idGenerator.next("ast"),
  globalMemory: idGenerator.next("ast"),
  globalSkill: idGenerator.next("ast"),
  lifecycle: idGenerator.next("ast"),
  migrationBridge: idGenerator.next("ast"),
  rejectedCandidate: idGenerator.next("ast"),
  unrelatedInbox: idGenerator.next("ast"),
};
const alphaMemoryRelativePath = "assets/workspaces/alpha/memories/ablation.md";
const lifecycleRelativePath = "assets/global/memories/lifecycle.md";
const migrationSourceRelativePath = "inbox/workspaces/alpha/memories/migration-bridge.md";
const migrationTargetRelativePath = "assets/workspaces/alpha/memories/migration-bridge.md";
const rejectedSourceRelativePath = "inbox/workspaces/alpha/documents/rejected.md";
const rejectedTargetRelativePath = "assets/workspaces/alpha/documents/rejected.md";
const unrelatedInboxRelativePath = "inbox/workspaces/unknown/memories/unrelated.md";
const decisionToken = "N13BUILDDIRECTTOKEN";
const documentBodyToken = "N13BUILDDOCUMENTBODY";
const skillBodyToken = "N13BUILDSKILLBODY";
const alphaMemorySource = assetSource({
  body: "sharedsearch alphaonly current alpha memory body",
  id: ids.alphaMemory,
  scope: "WORKSPACE",
  summary: `n13ablation ${decisionToken} strong decision`,
  title: "n13ablation sharedsearch alpha memory",
  type: "MEMORY",
  workspace: "alpha",
});
const lifecycleSource = assetSource({
  body: "lifecycleoriginal current body",
  id: ids.lifecycle,
  scope: "GLOBAL",
  summary: "lifecycleoriginal watcher fixture",
  title: "Lifecycle watcher Asset",
  type: "MEMORY",
});
const migrationSource = assetSource({
  body: "migrationbridge current Markdown body",
  id: ids.migrationBridge,
  scope: "WORKSPACE",
  summary: "synthetic M03 M04 integration bridge",
  title: "Migration bridge candidate",
  type: "MEMORY",
  workspace: "alpha",
});
const rejectedSource = assetSource({
  body: "rejectedhash body",
  id: ids.rejectedCandidate,
  scope: "WORKSPACE",
  summary: "hash rejection candidate",
  title: "Rejected candidate",
  type: "DOCUMENT",
  workspace: "alpha",
});

let child;
let client;
try {
  await Promise.all([
    mkdir(alphaWorkspacePath, { recursive: true }),
    mkdir(betaWorkspacePath, { recursive: true }),
    mkdir(outsideWorkspacePath, { recursive: true }),
    mkdir(join(repositoryPath, "assets"), { recursive: true }),
  ]);
  await writeWorkspaceConfig();
  await Promise.all([
    writeAsset(alphaMemoryRelativePath, alphaMemorySource),
    writeAsset("assets/workspaces/alpha/documents/ablation.md", assetSource({
      body: `${documentBodyToken} requires explicit asset_read`,
      id: ids.alphaDocument,
      scope: "WORKSPACE",
      summary: "n13ablation document read entry",
      title: "n13ablation alpha document",
      type: "DOCUMENT",
      workspace: "alpha",
    })),
    writeAsset("assets/workspaces/alpha/skills/ablation.md", assetSource({
      body: `${skillBodyToken} is not automatically executed`,
      id: ids.alphaSkill,
      scope: "WORKSPACE",
      summary: "n13ablation skill read entry",
      title: "n13ablation alpha skill",
      type: "SKILL",
      workspace: "alpha",
    })),
    writeAsset("assets/workspaces/beta/memories/blocked.md", assetSource({
      body: "n13ablation sharedsearch alphaonly stronger stronger stronger",
      id: ids.betaMemory,
      scope: "WORKSPACE",
      summary: "n13ablation sharedsearch forbidden beta result",
      title: "n13ablation sharedsearch beta strongest",
      type: "MEMORY",
      workspace: "beta",
    })),
    writeAsset("assets/global/memories/shared.md", assetSource({
      body: "sharedsearch globalonly global memory body",
      id: ids.globalMemory,
      scope: "GLOBAL",
      summary: "sharedsearch global memory",
      title: "Shared global memory",
      type: "MEMORY",
    })),
    writeAsset("assets/global/documents/reference.md", assetSource({
      body: "global document body",
      id: ids.globalDocument,
      scope: "GLOBAL",
      summary: "global document reference",
      title: "Global document",
      type: "DOCUMENT",
    })),
    writeAsset("assets/global/skills/reference.md", assetSource({
      body: "global skill body",
      id: ids.globalSkill,
      scope: "GLOBAL",
      summary: "global skill reference",
      title: "Global skill",
      type: "SKILL",
    })),
    writeAsset(lifecycleRelativePath, lifecycleSource),
    writeAsset(migrationSourceRelativePath, migrationSource),
    writeAsset(unrelatedInboxRelativePath, assetSource({
      body: "unrelated Inbox diagnostic",
      id: ids.unrelatedInbox,
      scope: "WORKSPACE",
      summary: "must not block selected candidate confirmation",
      title: "Unknown Workspace Inbox candidate",
      type: "MEMORY",
      workspace: "unknown",
    })),
  ]);
  // Startup never migrates; use the compiled offline installation commands.
  await initializeOffline();

  child = spawnServer();
  const firstListening = await waitForListening(child);
  assert.match(firstListening, new RegExp(`"endpoint":"${origin.replaceAll("/", "\\/")}\/mcp"`));
  assert.equal(child.spawnargs.includes("0.0.0.0"), false);

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const hub = await fetch(origin);
  assert.equal(hub.status, 200);
  const hubHtml = await hub.text();
  assert.match(hubHtml, /Precedent Loop · 让经验成为先例/u);
  const builtAssetPath = hubHtml.match(/<script[^>]+src="([^"]+)"/u)?.[1];
  assert.notEqual(builtAssetPath, undefined);
  assert.equal((await fetch(new URL(builtAssetPath, `${origin}/`))).status, 200);
  for (const path of ["/api/not-found", "/assets/missing.js", "/client-route"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /Precedent Loop · 让经验成为先例/u, path);
  }

  const initialInbox = await getRest("/api/inbox");
  assert.equal(initialInbox.items.some(({ assetId }) => assetId === ids.migrationBridge), true);
  assert.equal(initialInbox.diagnostics.some(({ relativePath }) => relativePath === unrelatedInboxRelativePath), true);

  // WorkspaceCapability comes only from the compiled trusted Hook adapter.
  const alphaHook = await runHook(hookInput(alphaWorkspacePath));
  assert.equal(alphaHook.code, 0);
  assert.equal(alphaHook.stderr, "");
  const alphaCapabilities = parseCapabilities(alphaHook.stdout);
  assert.deepEqual(alphaCapabilities.map(({ workspace }) => workspace), ["alpha", "beta"]);
  const alphaCapability = alphaCapabilities[0].capabilityId;
  assert.deepEqual(parseCapabilities((await runHook(hookInput(join(alphaWorkspacePath, "nested")))).stdout)
    .map(({ workspace }) => workspace), ["alpha", "beta"]);
  const betaCapabilities = parseCapabilities((await runHook(hookInput(join(betaWorkspacePath, "nested")))).stdout);
  assert.deepEqual(betaCapabilities.map(({ workspace }) => workspace), ["beta", "alpha"]);
  const betaCapability = betaCapabilities[0].capabilityId;
  assert.deepEqual(parseCapabilities((await runHook(hookInput(outsideWorkspacePath))).stdout).map(({ workspace }) => workspace), ["alpha", "beta"]);
  for (const eventName of ["Stop", "Interrupt", "SessionEnd"]) {
    const noOp = await runHook({ hook_event_name: eventName, session_id: "build-session" });
    assert.equal(noOp.code, 0);
    assert.equal(noOp.stdout, "");
  }

  client = await connectClient();
  const toolNames = ["knowledge_recall", "asset_read", "asset_mark_used", "candidate_prepare", "candidate_update"];
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), toolNames);

  const alphaShared = await recall([alphaCapability], "sharedsearch");
  assert.deepEqual(new Set(alphaShared.map(({ assetId }) => assetId)), new Set([ids.alphaMemory, ids.globalMemory]));
  assert.deepEqual((await recall([], "sharedsearch")).map(({ assetId }) => assetId), [ids.globalMemory]);
  assert.deepEqual((await recall([betaCapability], "n13ablation")).map(({ assetId }) => assetId), [ids.betaMemory]);
  assert.deepEqual(await recall([alphaCapability], "noresulttoken"), []);
  assert.equal(errorCode(await callTool("asset_read", { capabilityIds: [alphaCapability], assetId: ids.betaMemory })),
    "ASSET_NOT_ACCESSIBLE");

  const ablation = success(await callTool("knowledge_recall", { capabilityIds: [alphaCapability], queries: ["n13ablation"] }));
  assert.deepEqual(new Set(ablation.items.map(({ assetId }) => assetId)), new Set([
    ids.alphaMemory,
    ids.alphaDocument,
    ids.alphaSkill,
  ]));
  const deliveredMode = (assetId) => ablation.items.find((item) => item.assetId === assetId)?.deliveredMode;
  assert.equal(deliveredMode(ids.alphaMemory), "DIRECT");
  assert.equal(deliveredMode(ids.alphaDocument), "ON_DEMAND");
  assert.equal(deliveredMode(ids.alphaSkill), "ON_DEMAND");
  const recallText = JSON.stringify(ablation);
  assert.equal(recallText.includes(decisionToken), true);
  assert.equal(recallText.includes(documentBodyToken), false);
  assert.equal(recallText.includes(skillBodyToken), false);
  assert.equal(Array.from(recallText).length <= 5000, true);

  const alphaItem = ablation.items.find(({ assetId }) => assetId === ids.alphaMemory);
  const alphaRead = success(await callTool("asset_read", { capabilityIds: [alphaCapability], recallItemId: alphaItem.recallItemId }));
  assert.match(alphaRead.markdown, /current alpha memory body/u);
  const usedArguments = { capabilityIds: [alphaCapability], readRef: alphaRead.readRef };
  assert.equal(success(await callTool("asset_mark_used", usedArguments)).created, true);
  assert.equal(success(await callTool("asset_mark_used", usedArguments)).created, false);

  const restPaths = [
    "/api/overview",
    "/api/assets",
    `/api/assets/${ids.alphaMemory}`,
    "/api/inbox",
    "/api/workspaces",
    "/api/recalls",
    `/api/recalls/${ablation.recallId}`,
    "/api/usage",
    "/api/system/status",
  ];
  for (const path of restPaths) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).ok, true, path);
  }
  const history = await getRest(`/api/recalls/${ablation.recallId}`);
  assert.deepEqual(history.operation.queries, ["n13ablation"]);
  const alphaHistory = history.items.find(({ assetId }) => assetId === ids.alphaMemory);
  assert.equal(alphaHistory.readCount, 1);
  assert.equal(alphaHistory.totalUsedCount, 1);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of restPaths) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
    }
  }
  const foreignOrigin = await fetch(`${origin}/api/assets`, {
    headers: { origin: "http://example.invalid" },
  });
  assert.equal(foreignOrigin.status, 403);
  const status = await getRest("/api/system/status");
  assert.equal(status.index.indexState, "READY");
  assert.equal(status.index.watcherState, "RUNNING");
  assert.equal(status.mcpEndpoint.ready, true);

  assert.deepEqual(await recall([alphaCapability], "migrationbridge"), []);
  const migrationHash = createHash("sha256").update(Buffer.from(migrationSource, "utf8")).digest("hex");
  const confirmation = await runConfirmation(migrationSourceRelativePath, migrationHash);
  assert.equal(confirmation.code, 0, confirmation.stderr);
  assert.equal(confirmation.stderr, "");
  const confirmationBody = JSON.parse(confirmation.stdout);
  assert.equal(confirmationBody.assetId, ids.migrationBridge);
  assert.equal(confirmationBody.sourceRelativePath, migrationSourceRelativePath);
  assert.equal(confirmationBody.targetRelativePath, migrationTargetRelativePath);
  await assert.rejects(access(join(repositoryPath, migrationSourceRelativePath)));
  assert.equal(await readFile(join(repositoryPath, migrationTargetRelativePath), "utf8"), migrationSource);
  await waitFor(async () =>
    (await recall([alphaCapability], "migrationbridge"))[0]?.assetId === ids.migrationBridge
  );
  assert.match(
    success(await callTool("asset_read", {
      capabilityIds: [alphaCapability],
      assetId: ids.migrationBridge,
      expectedContentHash: migrationHash,
    })).markdown,
    /migrationbridge current Markdown body/u,
  );
  assert.equal((await getRest("/api/inbox")).items.some(({ assetId }) => assetId === ids.migrationBridge), false);
  assert.equal((await getRest("/api/assets")).items.some(({ assetId }) => assetId === ids.migrationBridge), true);
  // A path-only retry after the source moved replays the committed receipt.
  const repeatedConfirmation = await runConfirmation(migrationSourceRelativePath, migrationHash);
  assert.equal(repeatedConfirmation.code, 0, repeatedConfirmation.stderr);
  assert.deepEqual(JSON.parse(repeatedConfirmation.stdout), confirmationBody);
  assert.equal(await readFile(join(repositoryPath, migrationTargetRelativePath), "utf8"), migrationSource);

  await writeAsset(rejectedSourceRelativePath, rejectedSource);
  const rejected = await runConfirmation(rejectedSourceRelativePath, "0".repeat(64));
  assert.equal(rejected.code, 2);
  assert.equal(JSON.parse(rejected.stderr).error.code, "CONTENT_HASH_MISMATCH");
  assert.equal(await readFile(join(repositoryPath, rejectedSourceRelativePath), "utf8"), rejectedSource);
  await assert.rejects(access(join(repositoryPath, rejectedTargetRelativePath)));

  const lifecycleModified = lifecycleSource.replaceAll("lifecycleoriginal", "lifecyclemodified");
  await writeAsset(lifecycleRelativePath, lifecycleModified);
  await waitFor(async () => (await recall([], "lifecyclemodified"))[0]?.assetId === ids.lifecycle);
  await writeAsset(lifecycleRelativePath, "# invalid without Frontmatter\n");
  await waitFor(async () => (await recall([], "lifecyclemodified")).length === 0);
  const lifecycleRepaired = lifecycleSource.replaceAll("lifecycleoriginal", "lifecyclerepaired");
  await writeAsset(lifecycleRelativePath, lifecycleRepaired);
  await waitFor(async () => (await recall([], "lifecyclerepaired"))[0]?.assetId === ids.lifecycle);

  const catalogCountBeforeInvalidConfig = (await getRest("/api/system/status")).index.catalogCount;
  await writeFixture(workspaceConfigPath, "{invalid");
  await waitFor(async () => (await getRest("/api/system/status")).service.readiness === "DEGRADED");
  assert.equal((await getRest("/api/system/status")).index.catalogCount, catalogCountBeforeInvalidConfig);
  assert.equal((await fetch(`${origin}/api/assets`)).status, 503);
  assert.equal(errorCode(await callTool("knowledge_recall", { capabilityIds: [alphaCapability], queries: ["sharedsearch"] })),
    "WORKSPACE_CONFIG_UNAVAILABLE");
  await writeWorkspaceConfig();
  await waitFor(async () => (await getRest("/api/system/status")).service.readiness === "READY");
  assert.equal((await recall([alphaCapability], "sharedsearch")).some(({ assetId }) => assetId === ids.alphaMemory), true);

  // A changed trusted mapping invalidates its capabilities; restoring it re-validates them.
  await writeWorkspaceConfig(join(workspaceRoot, "beta-moved"));
  await waitFor(async () => errorCode(await callTool("knowledge_recall", {
    capabilityIds: [betaCapability],
    queries: ["n13ablation"],
  })) === "CAPABILITY_INVALID");
  await writeWorkspaceConfig();
  await waitFor(async () => (await recall([betaCapability], "n13ablation"))[0]?.assetId === ids.betaMemory);

  await rm(join(repositoryPath, lifecycleRelativePath));
  await waitFor(async () => (await recall([], "lifecyclerepaired")).length === 0);
  await writeAsset(lifecycleRelativePath, lifecycleRepaired);
  await waitFor(async () => (await recall([], "lifecyclerepaired"))[0]?.assetId === ids.lifecycle);

  await rm(join(repositoryPath, alphaMemoryRelativePath));
  await waitFor(async () =>
    (await recall([alphaCapability], "sharedsearch")).every(({ assetId }) => assetId !== ids.alphaMemory)
  );
  // Read/Used facts outlive the file; the projection only loses the current title.
  const missingUsage = await getRest(`/api/usage?assetId=${ids.alphaMemory}`);
  assert.equal(missingUsage.total, 2);
  assert.equal(missingUsage.items.every(({ assetTitle }) => assetTitle === null), true);
  await writeAsset(alphaMemoryRelativePath, alphaMemorySource);
  await waitFor(async () =>
    (await recall([alphaCapability], "sharedsearch")).some(({ assetId }) => assetId === ids.alphaMemory)
  );

  await client.close();
  client = undefined;
  await stopChild(child);
  child = undefined;
  await assertServerOffline();

  child = spawnServer();
  await waitForListening(child);
  client = await connectClient();
  assert.equal((await recall([alphaCapability], "sharedsearch")).some(({ assetId }) => assetId === ids.alphaMemory), true);
  assert.deepEqual((await getRest(`/api/recalls/${ablation.recallId}`)).operation.queries, ["n13ablation"]);
  await client.close();
  client = undefined;
  await stopChild(child);
  child = undefined;
  await assertServerOffline();

  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    await rm(path, { force: true });
  }
  child = spawnServer();
  await assert.rejects(waitForListening(child), /DATABASE_SCHEMA_INVALID/u);
  child = undefined;
  await initializeOffline();
  child = spawnServer();
  await waitForListening(child);
  client = await connectClient();
  assert.equal(errorCode(await callTool("knowledge_recall", { capabilityIds: [alphaCapability], queries: ["sharedsearch"] })),
    "CAPABILITY_INVALID");
  assert.equal((await getRest("/api/usage")).total, 0);
  assert.deepEqual((await getRest("/api/recalls")).items, []);
  const rebuiltCapability = parseCapabilities((await runHook(hookInput(alphaWorkspacePath))).stdout)[0].capabilityId;
  assert.equal((await recall([rebuiltCapability], "sharedsearch")).some(({ assetId }) => assetId === ids.alphaMemory), true);
  const rebuiltStatus = await getRest("/api/system/status");
  assert.equal(rebuiltStatus.index.indexState, "READY");
  assert.equal(rebuiltStatus.index.catalogCount >= 8, true);

  process.stdout.write(`${JSON.stringify({
    event: "N13_E2E_BUILD_SMOKE",
    status: "ok",
    bindHost: "127.0.0.1",
    tools: toolNames,
    restRoutes: restPaths,
    recallId: ablation.recallId,
    confirmedAssetId: ids.migrationBridge,
    restart: "preserved-runtime-data",
    sqliteRebuild: "explicit-initialization-catalog-restored-runtime-data-cleared",
  })}\n`);
} finally {
  await client?.close().catch(() => undefined);
  await stopChild(child).catch(() => undefined);
  await rm(fixtureRoot, { force: true, recursive: true });
}

function spawnServer() {
  return spawn(process.execPath, [join(serverRoot, "dist", "main.js")], {
    cwd: serverRoot,
    env: runtimeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function initializeOffline() {
  await mkdir(dirname(databasePath), { recursive: true });
  const initialized = await runNode(join(serverRoot, "dist", "maintenance-cli.js"), ["init-database", "--offline"]);
  assert.equal(initialized.code, 0, initialized.stderr);
}

async function connectClient() {
  const connected = new Client({ name: "n13-e2e-build-smoke", version: "0.0.0" });
  await connected.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  return connected;
}

async function callTool(name, args) {
  assert.notEqual(client, undefined);
  return await client.callTool({ name, arguments: args });
}

async function recall(capabilityIds, query) {
  return success(await callTool("knowledge_recall", { capabilityIds, queries: [query] })).items;
}

function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(result.structuredContent, undefined);
  return JSON.parse(result.content[0].text);
}

function errorCode(result) {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text).error.code;
}

async function getRest(path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200, path);
  const body = await response.json();
  assert.equal(body.ok, true, path);
  return body.data;
}

async function runHook(input) {
  return await runNode(join(serverRoot, "dist", "hook", "user-prompt-submit.js"), [], JSON.stringify(input));
}

async function runConfirmation(relativePath, expectedContentHash) {
  return await runNode(join(serverRoot, "dist", "asset", "confirm-cli.js"), [
    "--relative-path",
    relativePath,
    "--expected-content-hash",
    expectedContentHash,
  ]);
}

async function runNode(script, args, stdin = "") {
  const spawned = spawn(process.execPath, [script, ...args], {
    cwd: serverRoot,
    env: runtimeEnvironment(),
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
  return { code, stderr, stdout };
}

function parseCapabilities(stdout) {
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  return JSON.parse(context.split("Precedent Loop WorkspaceCapability\n")[1].split("\n")[0]);
}

function hookInput(cwd) {
  return { cwd, hook_event_name: "UserPromptSubmit", prompt: "n13ablation" };
}

function runtimeEnvironment() {
  return {
    ...process.env,
    PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
    PRECEDENT_LOOP_DATABASE_PATH: databasePath,
    PRECEDENT_LOOP_LOG_PATH: logPath,
    PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
    PORT: String(port),
  };
}

async function writeWorkspaceConfig(betaPath = betaWorkspacePath) {
  await writeFixture(workspaceConfigPath, JSON.stringify({
    schemaVersion: 1,
    workspaces: [
      { name: "alpha", paths: [workspaceRoot] },
      { name: "beta", paths: [betaPath] },
    ],
  }));
}

function assetSource({ body, id, scope, summary, title, type, workspace }) {
  const fields = [`id: ${id}`, `type: ${type}`, `scope: ${scope}`];
  if (workspace !== undefined) {
    fields.push(`workspace: ${workspace}`);
  }
  fields.push(`title: ${title}`, `summary: ${summary}`);
  return ["---", ...fields, "---", body, ""].join("\n");
}

async function writeAsset(relativePath, source) {
  await writeFixture(join(repositoryPath, relativePath), source);
}

async function writeFixture(path, source) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
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
  const selectedPort = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
  return selectedPort;
}

async function waitForListening(process) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Server start timeout: ${stderr}`)), 10_000);
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"event":"listening"')) {
        clearTimeout(timeout);
        resolve(stdout);
      }
    });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
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

async function assertServerOffline() {
  await waitFor(async () => {
    try {
      await fetch(`${origin}/health`);
      return false;
    } catch {
      return true;
    }
  });
}

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for N13 condition${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}
