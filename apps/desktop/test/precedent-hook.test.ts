import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema, dataPaths, resolveUserData } from "../src/config.js";
import { fixtureExecutor } from "./executor-fixture.js";
import { hookAppConfigSchema, hookConfiguration, hookUserData } from "../../server/src/hook/launcher-config.js";

const identity = { name: "PrecedentLoop-Test-launcher", bundleId: "local.precedentloop.desktop.test.launcher" };
const args = ["--test-identity", identity.name, identity.bundleId];
test("standalone Hook config and test identity rules match desktop", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-desktop-parity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const draft = { configVersion: 1, setupVersion: 0, setupCompleted: false, dataDirectory: join(root, "data") };
  const settings = { ...draft, agents: { codex: false, claude: true }, manualPaths: { codex: join(root, "codex") }, detectedPaths: { claude: join(root, "claude") },
    integrationChoices: { codex: { mcp: "enabled", skills: "skipped", projectContext: "undecided" } },
    ai: { defaultProvider: "claude", providers: { codex: { model: " custom ", profile: "private", timeoutMs: 180000 }, claude: { model: "other" } } } };
  const core = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(hookAppConfigSchema.shape, key)));
  // Core startup fields: the Hook accepts and derives exactly what the desktop does.
  for (const value of [draft, settings, { ...draft, port: 3000 }, { ...draft, configVersion: 2 }, { ...draft, setupVersion: -1 },
    { ...draft, setupCompleted: "true" }, { ...draft, dataDirectory: "relative" }, { ...draft, port: 65536 },
    { ...draft, startupTimeoutMs: 0 }, { ...draft, shutdownTimeoutMs: -1 }]) {
    const desktop = appConfigSchema.safeParse(value); const hook = hookAppConfigSchema.safeParse(value);
    assert.equal(hook.success, desktop.success);
    if (hook.success && desktop.success) assert.deepEqual(hook.data, core(desktop.data));
  }
  // Desktop-only fields never disable the Hook, including ones the desktop rejects.
  for (const value of [{ ...settings, ai: {} }, { ...settings, agents: { other: true } },
    { ...settings, manualPaths: { codex: "relative" } }, { ...settings, detectedPaths: { claude: "/bin/claude\0" } },
    { ...settings, ai: { providers: { claude: { profile: "invalid" } } } }, { ...settings, ai: { providers: { codex: { timeoutMs: 999 } } } },
    { ...settings, integrationChoices: { codex: { unknown: "enabled" } } }, { ...draft, futureSetting: { enabled: true } }, { ...draft, nodePath: "/external/node" }]) {
    const hook = hookAppConfigSchema.safeParse(value);
    assert.ok(hook.success);
    assert.deepEqual(hook.data, hookAppConfigSchema.parse(draft));
  }
  await writeFile(join(root, "app-config.json"), JSON.stringify(draft));
  const hook = await hookConfiguration(root); const paths = dataPaths(draft.dataDirectory);
  assert.equal(hook.databasePath, paths.databasePath); assert.equal(hook.workspaceConfigPath, paths.workspaceConfigPath);
  assert.equal(hook.captureCachePath, join(draft.dataDirectory, "runtime/capture"));
  await writeFile(join(root, "app-config.json"), JSON.stringify(settings));
  assert.equal((await hookConfiguration(root)).databasePath, paths.databasePath);
  const env = { PRECEDENT_LOOP_USER_DATA_DIR: root }; const appData = join(root, "Library/Application Support");
  assert.equal(hookUserData(args, env, root), resolveUserData(identity, appData, env));
  assert.equal(hookUserData(args, {}, root), resolveUserData(identity, appData, {}));
  assert.equal(hookUserData([], env, root), join(appData, "PrecedentLoop"));
  assert.throws(() => hookUserData(args, { PRECEDENT_LOOP_USER_DATA_DIR: "relative" }, root));
  assert.throws(() => hookUserData(["--test-identity", identity.name, "local.precedentloop.desktop"], env, root));
});

test("shell template logs missing App, contains App paths safely, forwards arguments, and normalizes failures", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-shell-")); t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user data"); const app = join(root, "App's space.app");
  const template = await readFile(new URL("../resources/precedent-hook.sh.template", import.meta.url), "utf8");
  assert.deepEqual(template.match(/\{\{[A-Z_]+\}\}/g), ["{{APP_PATH}}"]);
  const script = join(root, "precedent-hook");
  await writeFile(script, template.replace("{{APP_PATH}}", app.replaceAll("'", "'\\''"))); await chmod(script, 0o700);
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), PRECEDENT_LOOP_USER_DATA_DIR: userData };
  const invoke = (event: string, extraEnv = {}) => spawnSync("/bin/sh", [script, "claude", event, ...args], { env: { ...env, ...extraEnv }, input: "{}", encoding: "utf8", timeout: 2000 });
  for (const event of ["user-prompt-submit", "post-tool-use", "stop"]) {
    const result = invoke(event); assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
  const missing = invoke("record"); assert.equal(missing.status, 1); assert.equal(missing.stdout, ""); assert.match(missing.stderr, /not recorded/);
  assert.match(await readFile(join(userData, "logs/hook.log"), "utf8"), /HOOK_LAUNCH_UNAVAILABLE/);
  const runtime = join(app, "Contents/Resources/runtime");
  await fixtureExecutor(runtime);
  await mkdir(join(runtime, "apps/server/dist/hook"), { recursive: true });
  const entry = join(runtime, "apps/server/dist/hook/precedent-hook.js");
  await writeFile(entry, "process.stdout.write(JSON.stringify({args:process.argv.slice(2)}));");
  const valid = invoke("stop", { NODE_OPTIONS: "--require=/does-not-exist" });
  assert.equal(valid.status, 0, valid.stderr); assert.deepEqual(JSON.parse(valid.stdout), { args: ["claude", "stop", ...args] });
  await writeFile(entry, "throw Error('synthetic startup failure');");
  for (const event of ["stop", "user-prompt-submit", "record"]) {
    const result = invoke(event); assert.equal(result.status, event === "record" ? 1 : 0); assert.equal(result.stdout, "");
    assert.equal(result.stderr, event === "record" ? "Precedent Loop: assessment not recorded.\n" : "");
  }
  assert.match(await readFile(join(userData, "logs/hook.log"), "utf8"), /synthetic startup failure/);
  await rm(join(userData, "logs"), { recursive: true }); await writeFile(join(userData, "logs"), "blocked");
  assert.equal(invoke("stop").status, 0); assert.equal(invoke("record").status, 1);
});
