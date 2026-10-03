import { initializeDatabase, openDatabase } from "../src/storage/schema.js";
import { AssetRepository } from "../src/asset/asset-repository.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { readIntegrationActivity } from "../src/integration-activity.js";
import { CHECK_UNAVAILABLE } from "../src/hook/capture-assessment.js";

const dist = process.env.PRECEDENT_LOOP_TEST_DIST === "1";
const entry = fileURLToPath(new URL(dist ? "../dist/hook/precedent-hook.js" : "../src/hook/precedent-hook.ts", import.meta.url));
const testIdentity = ["--test-identity", "PrecedentLoop-Test-hook", "local.precedentloop.desktop.test.hook"];
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "precedent-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user data"); const data = join(root, "knowledge data"); const home = join(root, "home");
  for (const path of [userData, join(data, "runtime"), join(data, "config"), join(home, ".codex"), join(userData, "agents/claude")]) await mkdir(path, { recursive: true });
  const config = { configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: data };
  await writeFile(join(userData, "app-config.json"), JSON.stringify(config));
  await writeFile(join(data, "config/workspaces.json"), JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  initializeDatabase(join(data, "runtime/precedent-loop.sqlite"));
  async function invoke(host: string, event: string, input: unknown, customEnv: NodeJS.ProcessEnv = {}) {
    const started = performance.now();
    const child = spawn(process.execPath, [...(dist ? [] : ["--import", "tsx"]), entry, host, event, ...testIdentity], {
      env: { PATH: process.env.PATH, HOME: home, PRECEDENT_LOOP_USER_DATA_DIR: userData, ...customEnv }, stdio: "pipe", timeout: 12000,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    if (input !== null) child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stdout, stderr, ms: performance.now() - started };
  }
  return { root, userData, data, home, config, invoke };
}
const assessment = { sessionId: "synthetic-session", turnId: "synthetic-turn", outcome: "NO_INCREMENT", reason: "isolated fixture" };

test("both launcher hosts accept record inputs above 8192 up to 16384 bytes and preserve Stop on issue database failure", async t => {
  const f = await fixture(t), path = join(f.data, "runtime/precedent-loop.sqlite");
  const db = openDatabase(path); t.after(() => db.close());
  db.transaction(() => new AssetRepository(db).insert({ assetId: "ast1", type: "MEMORY", scope: "GLOBAL", workspace: null, title: "test", summary: "summary", retrievalTerms: [], bodyMarkdown: "body" })).immediate();
  const input = { ...assessment, knowledgeIssues: Array.from({ length: 4 }, () => ({ assetId: "ast1", kind: "OUTDATED", detail: "中".repeat(500), evidence: "文".repeat(500) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 8192 && Buffer.byteLength(JSON.stringify(input)) < 16384);
  for (const host of ["codex", "claude"]) {
    const record = await f.invoke(host, "record", input);
    assert.equal(record.code, 0, record.stderr); assert.deepEqual(JSON.parse(record.stdout), { recorded: true, issues: { recorded: 4, skipped: [] } });
    assert.deepEqual(db.prepare("SELECT DISTINCT source FROM asset_issue WHERE is_deleted=0").all(), [{ source: host.toUpperCase() }]);
    const oversized = await f.invoke(host, "record", `${JSON.stringify(input)}${" ".repeat(16385 - Buffer.byteLength(JSON.stringify(input)))}`);
    assert.equal(oversized.code, 1); assert.equal(oversized.stdout, "");
    assert.deepEqual(JSON.parse((await f.invoke(host, "stop", { hook_event_name: "Stop", session_id: assessment.sessionId,
      [host === "codex" ? "turn_id" : "prompt_id"]: assessment.turnId })).stdout), {});
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await f.invoke("codex", "record", input);
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { recorded: true, issues: { recorded: 0, error: "ISSUES_NOT_RECORDED" } });
    assert.ok(result.ms >= 1000 && result.ms < 3000, `busy wait ${result.ms}`);
  } finally { db.exec("ROLLBACK"); }
});

test("Codex launcher ignores old protocol locations and needs no protocol file", async t => {
  const f = await fixture(t), codexHome = join(f.root, "custom-codex-home");
  await mkdir(codexHome);
  const result = await f.invoke("codex", "user-prompt-submit", {
    session_id: "custom-home-session", turn_id: "custom-home-turn", cwd: f.root, prompt: "isolated", hook_event_name: "UserPromptSubmit",
  }, { CODEX_HOME: codexHome });
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  assert.doesNotMatch(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /KNOWLEDGE|协议位置/);
});

test("launcher handles all four events for both hosts, keeps stdout JSON, and records only activity times", async t => {
  const f = await fixture(t);
  for (const host of ["codex", "claude"]) {
    const event = { session_id: assessment.sessionId, [host === "codex" ? "turn_id" : "prompt_id"]: assessment.turnId, cwd: f.root, prompt: "must-not-persist", transcript_path: "/private/never-read" };
    const prompt = await f.invoke(host, "user-prompt-submit", { ...event, hook_event_name: "UserPromptSubmit" });
    assert.equal(prompt.code, 0); assert.equal(prompt.stderr, "");
    const context = JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`cat <<'EOF' | "$HOME/.precedent/bin/precedent-hook" ${host} record`));
    assert.doesNotMatch(context, /Skills|KNOWLEDGE|协议位置/);
    // Both hosts use precedent tools; reject every other MCP service prefix.
    assert.ok(context.includes(`先调用 mcp__precedent__knowledge_recall`));
    assert.doesNotMatch(context, /mcp__(?!precedent__)/);
    assert.ok(context.includes("传入召回时相同的 capabilityIds"));
    assert.ok(context.includes("只在方案已冻结或结论已成事实时准备候选"));
    assert.ok(context.includes("用户已确认的方案与决策（注明实施和验证状态）"));
    assert.ok(context.includes("一次性评估整段讨论，同一主题只写一条"));
    for (const tool of ["candidate_prepare", "candidate_update"]) {
      assert.ok(context.includes(`mcp__precedent__${tool}`));
    }
    assert.ok(context.includes("NO_INCREMENT（已评估，无增量，或方案尚未冻结）"));
    assert.ok(context.includes("CANDIDATE（已准备或并入候选，references 填 candidateId）"));
    assert.equal(context.includes("不是 Claude 自动记忆"), host === "claude");
    const activity = await f.invoke(host, "post-tool-use", { ...event, hook_event_name: "PostToolUse", tool_name: host === "claude" ? "Write" : "apply_patch" });
    assert.equal(activity.code, 0); assert.equal(activity.stderr, ""); assert.deepEqual(JSON.parse(activity.stdout), {});
    const stop = await f.invoke(host, "stop", { ...event, hook_event_name: "Stop" });
    assert.equal(stop.code, 0); assert.equal(stop.stderr, ""); assert.deepEqual(Object.keys(JSON.parse(stop.stdout)), ["systemMessage"]);
    const record = await f.invoke(host, "record", assessment);
    assert.equal(record.code, 0); assert.equal(record.stderr, ""); assert.deepEqual(JSON.parse(record.stdout), { recorded: true });
    assert.deepEqual(JSON.parse((await f.invoke(host, "stop", { ...event, hook_event_name: "Stop" })).stdout), {});
    if (dist) for (const result of [activity, stop, record]) assert.ok(result.ms < 1000, `capture took ${result.ms}ms`);
  }
  const path = join(f.data, "runtime/integration-activity");
  assert.equal(Object.keys(await readIntegrationActivity(path)).length, 8);
  for (const file of await readdir(path)) {
    const observation = JSON.parse(await readFile(join(path, file), "utf8"));
    assert.deepEqual(Object.keys(observation), ["at"]);
    assert.equal(new Date(observation.at).toISOString(), observation.at);
  }
});

test("missing config, invalid config/data and exceptions are silent, logged, and never migrate or create data", async t => {
  const f = await fixture(t); const configPath = join(f.userData, "app-config.json");
  for (const broken of [null, "{broken", JSON.stringify({ ...f.config, dataDirectory: join(f.root, "absent") }), JSON.stringify({ ...f.config, dataDirectory: configPath })]) {
    if (broken === null) await rm(configPath); else await writeFile(configPath, broken);
    for (const [event, hook_event_name] of [["user-prompt-submit", "UserPromptSubmit"], ["post-tool-use", "PostToolUse"], ["stop", "Stop"]]) {
      const result = await f.invoke("claude", event!, { hook_event_name });
      assert.equal(result.code, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    }
    const failed = await f.invoke("codex", "record", assessment);
    assert.equal(failed.code, 1); assert.equal(failed.stdout, ""); assert.match(failed.stderr, /assessment not recorded/);
  }
  assert.ok((await readFile(join(f.userData, "logs/hook.log"), "utf8")).length > 0);
  assert.equal((await readdir(f.root)).includes("absent"), false);
  await writeFile(configPath, JSON.stringify(f.config));
  for (const input of ["bad JSON", "x".repeat(1_000_001), { hook_event_name: "UserPromptSubmit" }]) {
    const result = await f.invoke("codex", "stop", input);
    assert.equal(result.code, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("record errors, missing Claude prompt_id, filesystem/log failures and unfinished stdin remain nonblocking", async t => {
  const f = await fixture(t);
  const stop = { hook_event_name: "Stop", session_id: "s", turn_id: "must-not-be-used" };
  const missing = await f.invoke("claude", "stop", stop);
  assert.equal(missing.code, 0); assert.deepEqual(Object.keys(JSON.parse(missing.stdout)), ["systemMessage"]);
  assert.match(missing.stdout, /检查不可用/);
  const invalid = await f.invoke("claude", "record", { ...assessment, reason: "" });
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, ""); assert.match(invalid.stderr, /not recorded/); assert.match(invalid.stderr, /sessionId, turnId, outcome \(NO_INCREMENT\|CANDIDATE\|FAILED\|SKIPPED\)/); assert.doesNotMatch(invalid.stderr, /synthetic-session|synthetic-turn/);
  await writeFile(join(f.data, "runtime/capture"), "blocked");
  await rm(join(f.userData, "logs"), { recursive: true, force: true }); await writeFile(join(f.userData, "logs"), "blocked");
  const error = await f.invoke("claude", "post-tool-use", { ...stop, prompt_id: "p", hook_event_name: "PostToolUse", tool_name: "Edit" });
  assert.equal(error.code, 0); assert.deepEqual(JSON.parse(error.stdout), { systemMessage: CHECK_UNAVAILABLE }); assert.equal(error.stderr, "");
  const record = await f.invoke("claude", "record", assessment);
  assert.equal(record.code, 1); assert.match(record.stderr, /not recorded/);
  for (const event of ["stop", "record"]) {
    const timeout = await f.invoke("claude", event, null);
    assert.equal(timeout.code, event === "record" ? 1 : 0); assert.equal(timeout.stdout, "");
    assert.ok(timeout.ms < (event === "record" ? 4500 : 2000));
    if (event === "record") assert.ok(timeout.ms >= 3000);
  }
});

for (const host of ["codex", "claude"] as const) {
  for (const failure of ["database-missing", "database-invalid", "workspace-config-invalid"] as const) {
    test(`${host} launcher delivers ${failure} degradation without recording a successful trigger`, async t => {
      const f = await fixture(t), database = join(f.data, "runtime/precedent-loop.sqlite");
      if (failure.startsWith("database")) {
        await rm(database);
        if (failure === "database-invalid") await writeFile(database, "not a SQLite database");
      } else {
        await writeFile(join(f.data, "config/workspaces.json"), JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "invalid", paths: ["relative/path"] }] }));
      }
      const result = await f.invoke(host, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", cwd: f.root,
        session_id: "degraded-session", [host === "codex" ? "turn_id" : "prompt_id"]: "degraded-turn", prompt: "private-prompt-must-not-be-logged" });
      assert.equal(result.code, 0); assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.match(output.hookSpecificOutput.additionalContext, /CAPABILITY_UNAVAILABLE/);
      assert.deepEqual(await readIntegrationActivity(join(f.data, "runtime/integration-activity")), {});
      const log = await readFile(join(f.userData, "logs/hook.log"), "utf8");
      assert.match(log, / [A-Z0-9_]+\n$/); assert.doesNotMatch(log, /private-prompt|degraded-session|degraded-turn/);
      if (failure === "database-missing") assert.equal((await readdir(join(f.data, "runtime"))).includes("precedent-loop.sqlite"), false);
    });
  }

  test(`${host} Stop preserves CHECK_UNAVAILABLE when the cache fails`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.data, "runtime/capture"), "blocked");
    const result = await f.invoke(host, "stop", { hook_event_name: "Stop", session_id: "cache-failure",
      [host === "codex" ? "turn_id" : "prompt_id"]: "turn" });
    assert.equal(result.code, 0); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: CHECK_UNAVAILABLE });
    assert.deepEqual(await readIntegrationActivity(join(f.data, "runtime/integration-activity")), {});
    assert.match(await readFile(join(f.userData, "logs/hook.log"), "utf8"), / [A-Z0-9_]+\n$/);
  });

  test(`${host} activity write failure preserves all handler outputs and record success`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.data, "runtime/integration-activity"), "blocked");
    const identity = { session_id: assessment.sessionId, [host === "codex" ? "turn_id" : "prompt_id"]: assessment.turnId };
    const prompt = await f.invoke(host, "user-prompt-submit", { ...identity, hook_event_name: "UserPromptSubmit", cwd: f.root });
    const activity = await f.invoke(host, "post-tool-use", { ...identity, hook_event_name: "PostToolUse", tool_name: "Bash" });
    const stop = await f.invoke(host, "stop", { ...identity, hook_event_name: "Stop" });
    const record = await f.invoke(host, "record", assessment);
    for (const result of [prompt, activity, stop, record]) { assert.equal(result.code, 0); assert.equal(result.stderr, ""); }
    assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(JSON.parse(activity.stdout), {});
    assert.match(JSON.parse(stop.stdout).systemMessage, /未找到知识评估记录/);
    assert.deepEqual(JSON.parse(record.stdout), { recorded: true });
    assert.deepEqual(JSON.parse((await f.invoke(host, "stop", { ...identity, hook_event_name: "Stop" })).stdout), {});
    const failedRecord = await f.invoke(host, "record", { ...assessment, reason: "" });
    assert.equal(failedRecord.code, 1); assert.equal(failedRecord.stdout, ""); assert.match(failedRecord.stderr, /assessment not recorded/);
  });
}
