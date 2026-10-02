import { seedAssets } from "./seed-built-assets.mjs";
import { initializeDatabase, openDatabase } from "../dist/storage/schema.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "precedent-loop-rest-build-"));
const workspaceConfigPath = join(fixtureRoot, "config", "workspaces.json");
const databasePath = join(fixtureRoot, "data", "precedent-loop.sqlite");
const workspacePath = join(fixtureRoot, "workspace-alpha");
const assetId = "ast2034512345678901248";
const port = await allocatePort();
const origin = `http://127.0.0.1:${port}`;
let child;

try {
  await writeFixture(workspaceConfigPath, JSON.stringify({
    schemaVersion: 1,
    workspaces: [{ name: "alpha", paths: [workspacePath] }],
  }));
  await mkdir(dirname(databasePath), { recursive: true });
  // Empty databases still require explicit offline initialization.
  initializeDatabase(databasePath);
  seedAssets(databasePath, [{ assetId, type: "DOCUMENT", scope: "WORKSPACE", workspace: "alpha", title: "REST build smoke Asset", summary: "verifies compiled read-only REST", retrievalTerms: ["rest-term-only", "接口检索", "构建验证"], bodyMarkdown: "compiled-rest-token" }]);
  // The actual server must repair on a writable connection before opening read-only search.
  const incomplete = openDatabase(databasePath);
  try { incomplete.exec("DROP TABLE asset_issue; DROP TABLE retrieval_check; DROP TABLE asset_fts; DROP TABLE asset_candidate; DROP INDEX recall_item_asset"); }
  finally { incomplete.close(); }

  child = spawn(process.execPath, [join(serverRoot, "dist", "main.js")], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PRECEDENT_LOOP_DATABASE_PATH: databasePath,
      PRECEDENT_LOOP_LOG_PATH: join(fixtureRoot, "logs", "precedent-loop.log"),
      PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForListening(child);

  const paths = [
    "/api/overview",
    "/api/assets",
    `/api/assets/${assetId}`,
    "/api/inbox",
    "/api/workspaces",
    "/api/recalls",
    "/api/usage",
    "/api/system/status",
  ];
  for (const path of paths) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.equal(body.ok, true, path);
    assert.equal(Object.hasOwn(body, "data"), true, path);
    if (path === "/api/system/status") assert.equal("schemaVersion" in body.data.storage, false);
  }
  const detail = await fetch(`${origin}/api/assets/${assetId}`).then((response) => response.json());
  assert.match(detail.data.asset.bodyMarkdown, /compiled-rest-token/);
  assert.equal(detail.data.asset.version, 0);
  assert.deepEqual(detail.data.asset.retrievalTerms, ["rest-term-only", "接口检索", "构建验证"]);
  const search = await fetch(`${origin}/api/assets?query=compiled-rest-token`).then(response => response.json());
  assert.deepEqual(search.data.items.map(item => item.assetId), [assetId]);
  const termsSearch = await fetch(`${origin}/api/assets?query=rest-term-only`).then(response => response.json());
  assert.deepEqual(termsSearch.data.items.map(item => item.assetId), [assetId]);
  const workspaces = await fetch(`${origin}/api/workspaces`).then((response) => response.json());
  assert.equal(workspaces.data.items[0].assetCount, 1);

  const diff = await fetch(`${origin}/api/assets/${assetId}/diff`).then(response => response.json());
  assert.deepEqual(diff, { ok: true, data: { diff: { assetId, status: "NO_PREVIOUS_VERSION" } } });

  await expectError(fetch(`${origin}/api/recalls/usg1`), 404, "SOURCE_NOT_FOUND");
  for (const retired of ["/api/task-loadouts", "/api/usages"]) {
    await expectError(fetch(`${origin}${retired}`), 404, "ROUTE_NOT_FOUND");
  }
  await expectError(fetch(`${origin}/api/assets`, { method: "POST" }), 405, "METHOD_NOT_ALLOWED");
  // Candidate writes stay behind the same-origin Hub write session.
  await expectError(fetch(`${origin}/api/inbox/accept`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  }), 403, "WRITE_SESSION_INVALID");
  await expectError(fetch(`${origin}/api/inbox/backfill-terms`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "no-token", provider: "codex" }),
  }), 403, "WRITE_SESSION_INVALID");
  for (const action of ["dismiss-issue", "draft-revision", "retrieval-check"]) await expectError(fetch(`${origin}/api/inbox/${action}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
  }), 403, "WRITE_SESSION_INVALID");
  const { IssueService } = await import("../dist/asset/issue-service.js");
  new IssueService(databasePath).record({ sessionId: "smoke", turnId: "turn", knowledgeIssues: [{ assetId, kind: "INCOMPLETE", detail: "隔离样本问题" }] }, "CODEX");
  const inbox = await fetch(`${origin}/api/inbox`).then(response => response.json());
  assert.equal(inbox.data.issueCards.length, 1); assert.equal(inbox.data.issueCards[0].assetId, assetId);
  assert.equal(inbox.data.pendingRetrievalCheckCount, 1);
  const overview = await fetch(`${origin}/api/overview`).then(response => response.json());
  assert.equal(overview.data.scopes.reduce((n, scope) => n + scope.inboxCount, 0), 1);
  const { data: { token } } = await fetch(`${origin}/api/inbox/session`).then(response => response.json());
  const dismissed = await fetch(`${origin}/api/inbox/dismiss-issue`, { method: "POST", headers: { origin, "content-type": "application/json", "x-hub-write-token": token },
    body: JSON.stringify({ issueId: inbox.data.issueCards[0].issues[0].issueId }) });
  assert.equal(dismissed.status, 200);
  await expectError(
    fetch(`${origin}/api/assets`, { headers: { origin: "http://example.invalid" } }),
    403,
    "FORBIDDEN_HOST_ORIGIN",
  );
  process.stdout.write(`${JSON.stringify({ event: "REST_BUILD_SMOKE", routes: paths, status: "ok" })}\n`);
} finally {
  await stopChild(child);
  await rm(fixtureRoot, { force: true, recursive: true });
}

async function expectError(request, status, code) {
  const response = await request;
  assert.equal(response.status, status, code);
  assert.equal((await response.json()).error.code, code);
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
