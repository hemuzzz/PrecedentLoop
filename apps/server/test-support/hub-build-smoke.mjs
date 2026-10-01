import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateCandidateStore } from "../dist/asset/candidate-repository.js";
import { migrateKnowledge } from "../dist/knowledge/repository.js";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "precedent-loop-n10-hub-build-"));
const repositoryPath = join(fixtureRoot, "asset-repository");
const workspaceConfigPath = join(fixtureRoot, "config", "workspaces.json");
const databasePath = join(fixtureRoot, "data", "precedent-loop.sqlite");
const assetId = "ast2034512345678901248";
const port = await allocatePort();
let child;

try {
  await writeFixture(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  await writeFixture(join(repositoryPath, "assets/global/memories/smoke.md"), [
    "---",
    `id: ${assetId}`,
    "type: MEMORY",
    "scope: GLOBAL",
    "title: Hub build smoke Asset",
    "summary: verifies the built Hub and REST share one origin",
    "---",
    "hub-build-token",
    "",
  ].join("\n"));
  await mkdir(dirname(databasePath), { recursive: true });
  // Startup never migrates; mirror the explicit offline installation step.
  migrateKnowledge(databasePath, false, true);
  migrateCandidateStore(databasePath);

  child = spawn(process.execPath, [join(serverRoot, "dist", "main.js")], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
      PRECEDENT_LOOP_DATABASE_PATH: databasePath,
      PRECEDENT_LOOP_LOG_PATH: join(fixtureRoot, "logs", "precedent-loop.log"),
      PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForListening(child);
  const origin = `http://127.0.0.1:${port}`;

  const indexResponse = await fetch(origin);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type") ?? "", /text\/html/u);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /Precedent Loop · 让经验成为先例/u);
  const assetSource = indexHtml.match(/<script[^>]+src="([^"]+)"/u)?.[1];
  assert.notEqual(assetSource, undefined);
  const builtAsset = await fetch(new URL(assetSource, `${origin}/`));
  assert.equal(builtAsset.status, 200);
  assert.match(builtAsset.headers.get("content-type") ?? "", /javascript/u);
  assert.ok((await builtAsset.text()).length > 1_000);

  const list = await fetch(`${origin}/api/assets`).then(async (response) => ({
    body: await response.json(),
    status: response.status,
  }));
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.equal(list.body.data.items[0].assetId, assetId);
  const detail = await fetch(`${origin}/api/assets/${assetId}`).then((response) => response.json());
  assert.match(detail.data.asset.rawMarkdown, /hub-build-token/u);

  for (const path of ["/api/not-found", "/assets/missing.js", "/client-route"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /Precedent Loop · 让经验成为先例/u, path);
  }
  const mcpResponse = await fetch(`${origin}/mcp`);
  assert.notEqual(mcpResponse.status, 200);
  assert.doesNotMatch(await mcpResponse.text(), /Precedent Loop · 让经验成为先例/u);

  process.stdout.write(`${JSON.stringify({ event: "N10_HUB_BUILD_SMOKE", status: "ok" })}\n`);
} finally {
  await stopChild(child);
  await rm(fixtureRoot, { force: true, recursive: true });
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
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
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return selectedPort;
}

async function waitForListening(process) {
  await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Server start timeout: ${stderr}`)), 10_000);
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      if (chunk.includes('"event":"listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.once("error", (error) => { clearTimeout(timeout); reject(error); });
    process.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited before listening: ${String(code)} ${stderr}`)); });
  });
}

async function stopChild(process) {
  if (process === undefined || process.exitCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server stop timeout")), 10_000);
    process.once("exit", () => { clearTimeout(timeout); resolve(); });
    process.kill("SIGTERM");
  });
}
