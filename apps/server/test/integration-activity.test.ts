import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { integrationActivityDirectory, mcpClientName, readIntegrationActivity, recordHookActivity, recordMcpActivity } from "../src/integration-activity.js";
import { startPrecedentLoopServer } from "../src/runtime.js";
import { candidateFixture } from "../test-support/candidate-fixture.js";

test("activity keys are sanitized, atomic and read-only; malformed and symlinked records are ignored", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-activity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "integration-activity");
  assert.deepEqual(await readIntegrationActivity(path), {});
  assert.deepEqual(await readdir(root), []);
  assert.equal(integrationActivityDirectory(join(root, "db.sqlite")), path);
  for (const name of [null, "", "../outside", "name with space", "a/b", "a\nb", "名", "a".repeat(65)]) assert.equal(mcpClientName(name), "unknown");
  for (const name of ["Claude-Code_1.2", "a".repeat(64)]) assert.equal(mcpClientName(name), name);
  await Promise.all(Array.from({ length: 15 }, () => recordHookActivity(path, "claude", "stop")));
  await recordMcpActivity(path, "../outside"); await recordMcpActivity(path, "Claude-Code_1.2");
  const valid = await readIntegrationActivity(path);
  assert.deepEqual(Object.keys(valid).sort(), ["hook-claude-stop", "mcp-Claude-Code_1.2", "mcp-unknown"]);
  assert.deepEqual(JSON.parse(await readFile(join(path, "mcp-unknown.json"), "utf8")), { at: valid["mcp-unknown"], name: "unknown" });
  const names = await readdir(path); assert.equal(names.some(name => name.endsWith(".tmp")), false);
  await writeFile(join(path, "mcp-broken.json"), "{");
  await writeFile(join(path, "mcp-date.json"), '{"at":"not a time"}');
  await writeFile(join(path, "mcp-huge.json"), "x".repeat(513));
  await symlink(join(path, "hook-claude-stop.json"), join(path, "mcp-link.json"));
  assert.deepEqual(await readIntegrationActivity(path), valid);
  await assert.doesNotReject(recordMcpActivity(join(path, "mcp-unknown.json"), "fail"));
});

test("real backend records validated MCP initialize only, sanitizes names, and survives observation failures", async () => {
  const f = await candidateFixture();
  const path = integrationActivityDirectory(f.options.databasePath);
  let server: Awaited<ReturnType<typeof startPrecedentLoopServer>> | undefined;
  async function start() {
    server = await startPrecedentLoopServer({ ...f.options, port: 0, logPath: join(f.root, "server.log") });
    const address = server.server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}/mcp`;
  }
  async function request(url: string, name: string, method = "initialize", origin?: string) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1.0", private: "never-record" } } }) });
  }
  try {
    const url = await start();
    assert.equal((await request(url, "blocked", "initialize", "https://untrusted.invalid")).status, 403);
    const other = await request(url, "not-initialize", "ping"); await other.text();
    for (const name of ["claude-code", "Codex_Desktop.1", "../../private"]) {
      const response = await request(url, name); assert.equal(response.status, 200);
      assert.match(await response.text(), /"serverInfo"/);
    }
    // Runtime close waits for in-flight observation writes; no polling/timing assumptions.
    await server!.close(); server = undefined;
    const observations = await readIntegrationActivity(path);
    assert.deepEqual(Object.keys(observations).sort(), ["mcp-Codex_Desktop.1", "mcp-claude-code", "mcp-unknown"]);
    for (const file of await readdir(path)) {
      const bytes = await readFile(join(path, file), "utf8"); assert.doesNotMatch(bytes, /private|version|capabilities|session/);
      assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), ["at", "name"]);
    }
    await rm(path, { recursive: true }); await writeFile(path, "cannot write observations");
    const unavailable = await start(); const response = await request(unavailable, "still-works");
    assert.equal(response.status, 200); assert.match(await response.text(), /"serverInfo"/);
    await server!.close(); server = undefined;
    assert.equal(await readFile(path, "utf8"), "cannot write observations");
  } finally { await server?.close(); await f.cleanup(); }
});
