import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
const root = new URL(process.env.PRECEDENT_LOOP_TEST_DIST === "1" ? "../dist/" : "../src/", import.meta.url);
import { migrateKnowledge } from "../test-support/knowledge-fixture.js";
const { AssetSearchService }: typeof import("../src/asset/index.js") = await import(new URL("asset/index.js", root).href);
console.log(`F05_MODULE_ROOT ${root.href}`);
test("F05 a real SQLite exclusive lock cannot stall the optional Hook for five seconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-f05-"));
  const dbPath = join(directory, "db.sqlite");
  const config = join(directory, "workspaces.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [directory] }] }));
  migrateKnowledge(dbPath, false, true);
  const db = new Database(dbPath);
  try {
    db.exec("BEGIN EXCLUSIVE");
    const started = performance.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const dist = process.env.PRECEDENT_LOOP_TEST_DIST === "1";
      const child = spawn(process.execPath, [...(dist ? [] : ["--import", "tsx"]), fileURLToPath(new URL(`hook/user-prompt-submit.${dist ? "js" : "ts"}`, root))], {
        env: { ...process.env, PRECEDENT_LOOP_DATABASE_PATH: dbPath, PRECEDENT_LOOP_WORKSPACES_PATH: config, PRECEDENT_LOOP_LOG_PATH: join(directory, "hook.log") },
        stdio: ["pipe", "pipe", "pipe"], timeout: 8000,
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
      child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: directory, session_id: "s", turn_id: "t", prompt: "continue" }));
    });
    assert.ok(performance.now() - started < 1500, `Hook lock wait took ${performance.now() - started}ms`);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /CAPABILITY_UNAVAILABLE/u);
    assert.doesNotMatch(result.stdout, /WorkspaceCapability/u);
    assert.equal(result.stderr, "");
    db.exec("ROLLBACK");
    assert.equal((db.prepare("SELECT count(*) AS n FROM workspace_capability").get() as { n: number }).n, 0);
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("F05 the Hook's separate pure Asset reader also uses a short real SQLite lock wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-f05-reader-"));
  const databasePath = join(directory, "db.sqlite");
  const workspaceConfigPath = join(directory, "workspaces.json");
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [directory] }] }));
  migrateKnowledge(databasePath, false, true);
  const db = new Database(databasePath);
  const reader = new AssetSearchService({ databasePath, workspaceConfigPath, repositoryPath: directory, busyTimeoutMs: 100, refreshIndex: async () => undefined });
  try {
    db.exec("BEGIN EXCLUSIVE");
    const started = performance.now();
    await assert.rejects(reader.read({ assetId: "ast301", context: { authorizedWorkspaces: [] } }), { code: "SQLITE_BUSY" });
    assert.ok(performance.now() - started < 1500);
  } finally { reader.close(); db.exec("ROLLBACK"); db.close(); await rm(directory, { recursive: true, force: true }); }
});
