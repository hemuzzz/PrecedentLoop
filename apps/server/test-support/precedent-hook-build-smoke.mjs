import { initializeDatabase } from "../dist/storage/schema.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIntegrationActivity } from "../dist/integration-activity.js";

// Isolated compiled entry + the actual rendered shell template, never an installed Hook.
const root = await realpath(await mkdtemp(join(tmpdir(), "precedent-dist-")));
const userData = join(root, "user data"); const data = join(root, "data"); const home = join(root, "home");
const app = join(root, "PrecedentLoop-Test-dist.app"); const runtime = join(app, "Contents/Resources/runtime");
const helperDirectory = join(app, "Contents/Frameworks/PrecedentLoop-Test-dist Helper.app/Contents/MacOS");
try {
  for (const directory of [userData, join(data, "runtime"), join(data, "config"), join(home, ".codex"), join(userData, "agents/claude"), helperDirectory, join(runtime, "apps/server")]) await mkdir(directory, { recursive: true });
  await writeFile(join(userData, "app-config.json"), JSON.stringify({ configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: data }));
  await writeFile(join(data, "config/workspaces.json"), '{"schemaVersion":1,"workspaces":[]}');
  initializeDatabase(join(data, "runtime/precedent-loop.sqlite"));
  await symlink(process.execPath, join(helperDirectory, "PrecedentLoop-Test-dist Helper"));
  await cp(fileURLToPath(new URL("../dist/", import.meta.url)), join(runtime, "apps/server/dist"), { recursive: true });
  await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(runtime, "apps/server/node_modules"));
  const script = join(root, "precedent-hook");
  const template = await readFile(new URL("../dist/resources/integrations/precedent-hook.sh.template", import.meta.url), "utf8");
  await writeFile(script, template.replace("{{APP_PATH}}", app.replaceAll("'", "'\\''"))); await chmod(script, 0o700);
  for (const host of ["codex", "claude"]) {
    const identity = { session_id: "dist-session", [host === "codex" ? "turn_id" : "prompt_id"]: "dist-turn" };
    const cases = [
      ["user-prompt-submit", { ...identity, hook_event_name: "UserPromptSubmit", cwd: root }],
      ["post-tool-use", { ...identity, hook_event_name: "PostToolUse", tool_name: host === "codex" ? "apply_patch" : "Edit" }],
      ["stop", { ...identity, hook_event_name: "Stop" }],
      ["record", { sessionId: "dist-session", turnId: "dist-turn", outcome: "NO_INCREMENT", reason: "临时目录 dist 验证样本" }],
    ];
    for (const [event, input] of cases) {
      const started = performance.now();
      const result = spawnSync("/bin/sh", [script, host, event, "--test-identity", "PrecedentLoop-Test-dist", "local.precedentloop.desktop.test.dist"], {
        input: JSON.stringify(input), encoding: "utf8", timeout: event === "user-prompt-submit" ? 10000 : 1000,
        env: { PATH: process.env.PATH, HOME: home, PRECEDENT_LOOP_USER_DATA_DIR: userData },
      });
      const ms = Math.round(performance.now() - started);
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
      assert.notEqual(result.stdout, "", await readFile(join(userData, "logs/hook.log"), "utf8").catch(() => "Hook did not emit output"));
      const output = JSON.parse(result.stdout);
      if (event === "user-prompt-submit") assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      else if (event === "post-tool-use") assert.deepEqual(output, {});
      else if (event === "stop") assert.deepEqual(Object.keys(output), ["systemMessage"]);
      else assert.deepEqual(output, { recorded: true });
      console.log(JSON.stringify({ host, event, code: result.status, ms, stdout: result.stdout, stderr: result.stderr }));
    }
  }
  const activity = await readIntegrationActivity(join(data, "runtime/integration-activity"));
  assert.equal(Object.keys(activity).length, 8);
  // The runtime directory exists but SQLite must not be created by a Hook.
  await rm(join(data, "runtime/precedent-loop.sqlite"));
  for (const host of ["codex", "claude"]) {
    const result = spawnSync("/bin/sh", [script, host, "user-prompt-submit", "--test-identity", "PrecedentLoop-Test-dist", "local.precedentloop.desktop.test.dist"], {
      input: JSON.stringify({ session_id: "missing-db-session", [host === "codex" ? "turn_id" : "prompt_id"]: "missing-db-turn", hook_event_name: "UserPromptSubmit", cwd: root }),
      encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: home, PRECEDENT_LOOP_USER_DATA_DIR: userData },
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stderr, "");
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /CAPABILITY_UNAVAILABLE/);
    assert.deepEqual(await readIntegrationActivity(join(data, "runtime/integration-activity")), activity);
    await assert.rejects(readFile(join(data, "runtime/precedent-loop.sqlite")), { code: "ENOENT" });
    console.log(JSON.stringify({ scenario: "database-missing", host, event: "user-prompt-submit", code: result.status, stdout: result.stdout, stderr: result.stderr }));
  }
  console.log(JSON.stringify({ status: "PASS", activity }));
} finally { await rm(root, { recursive: true, force: true }); }
