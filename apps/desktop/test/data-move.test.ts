import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema, dataPaths, readAppConfig, writeAppConfig, type AppConfig } from "../src/config.js";
import { SetupService, type SetupDependencies } from "../src/setup-service.js";
import { createSetupDispatcher, settingsMethods, setupRequestSchemas } from "../src/setup-ipc.js";
import type { StartupMode } from "../src/startup.js";
import { integrationFixture } from "./integration-fixture.js";
import { fixtureProduct, fixtureRuntime } from "./setup-fixture.js";

async function fixture(extra: Partial<SetupDependencies> = {}) {
  const f = await integrationFixture();
  await fixtureProduct(f.config.dataDirectory, 2, true);
  await mkdir(join(f.config.dataDirectory, "repository/assets/global/memories"), { recursive: true });
  await writeFile(join(f.config.dataDirectory, "repository/assets/global/memories/a.md"), "# 正式知识\n");
  await mkdir(join(f.config.dataDirectory, "repository/inbox/global/memories"), { recursive: true });
  await writeFile(join(f.config.dataDirectory, "repository/inbox/global/memories/b.md"), "# 候选\n", { mode: 0o600 });
  await mkdir(join(f.config.dataDirectory, "logs"), { recursive: true });
  await writeFile(join(f.config.dataDirectory, "logs/server.log"), "log\n");
  const runtime = await fixtureRuntime(f.root);
  await writeAppConfig(f.env.userData, appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: true, ...f.config }));
  const calls: string[] = [], modes: StartupMode[] = [];
  const service = new SetupService({ userData: f.env.userData, home: f.env.home, runtime, integrations: f.env,
    startBackend: async config => { calls.push(`start:${config.dataDirectory}`); }, stopBackend: async () => { calls.push("stop"); },
    backendStatus: async () => ({ serviceReady: true, mcpReady: true }), portAvailable: async () => true,
    reloadSettings: async (port, page) => { calls.push(`load:${port}:${page}`); },
    verifyRuntime: async () => "fixture", changeMode: async mode => { modes.push(mode); }, progress: () => {},
    detect: async (agent, path) => ({ agent, source: path ? "manual" : "auto", path: path ?? join(f.root, "bin", agent), found: true, runnable: true, login: "unverified", checkedAt: "2026-09-24T00:00:00.000Z" }), ...extra });
  await service.initialize(); calls.length = 0; modes.length = 0;
  const config = async (): Promise<AppConfig> => { const result = await readAppConfig(f.env.userData); assert.ok(result.kind === "VALID"); return result.config; };
  return { ...f, service, runtime, calls, modes, config, source: f.config.dataDirectory };
}
async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(root, path));
    else result[path] = (await readFile(join(root, path))).toString("base64");
  }
  return result;
}

test("migrate copies every file with verification, switches config, restarts and keeps the old directory", async () => {
  const f = await fixture();
  try {
    const before = await tree(f.source), target = join(f.root, "moved");
    const plan = await f.service.planDataMove("migrate", target);
    assert.equal(plan.reason, null); assert.ok(plan.planId); assert.equal(plan.to, target); assert.equal(plan.syncRisk, false);
    assert.deepEqual(plan.statistics, { workspaces: 0 });
    const result = await f.service.applyDataMove(plan.planId!, false);
    assert.equal(result.status, "success", result.reason ?? undefined);
    assert.equal(result.files, Object.keys(before).length);
    assert.equal((await f.config()).dataDirectory, target);
    assert.deepEqual(f.calls, ["stop", `start:${target}`, `load:18888:storage`]);
    assert.deepEqual(f.modes, [{ mode: "NORMAL", dataDirectory: target }]);
    assert.deepEqual(await tree(f.source), before);
    assert.deepEqual(await tree(target), before);
    assert.equal((await stat(join(target, "repository/inbox/global/memories/b.md"))).mode & 0o777, 0o600);
    assert.equal((await f.service.getLocalSettings()).lastDataMove?.status, "success");
    // A plan is single use.
    await assert.rejects(f.service.applyDataMove(plan.planId!, false), /已失效/);
  } finally { await f.cleanup(); }
});

test("migrate refuses overlapping or non-empty targets, and uses a PrecedentLoop subfolder inside an unrelated folder", async () => {
  const f = await fixture();
  try {
    for (const target of [f.source, join(f.source, "nested")]) {
      const plan = await f.service.planDataMove("migrate", target);
      assert.equal(plan.planId, null); assert.match(plan.reason ?? "", /子目录或上级目录/);
    }
    // The parent is non-empty, so the target becomes a sibling subfolder, never the parent itself.
    assert.equal((await f.service.planDataMove("migrate", f.root)).to, join(f.root, "PrecedentLoop"));
    const other = join(f.root, "other-product"); await fixtureProduct(other, 2, true);
    assert.match((await f.service.planDataMove("migrate", other)).reason ?? "", /关联其他数据目录/);
    const unrelated = join(f.root, "Documents"); await mkdir(unrelated); await writeFile(join(unrelated, "notes.txt"), "mine");
    const plan = await f.service.planDataMove("migrate", unrelated);
    assert.equal(plan.reason, null); assert.equal(plan.to, join(unrelated, "PrecedentLoop"));
    // A target that is no longer empty at confirmation time is refused before stopping anything.
    await mkdir(plan.to); await writeFile(join(plan.to, "late.txt"), "x");
    await assert.rejects(f.service.applyDataMove(plan.planId!, false), /所选位置已变化/);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("a copy failure keeps the original directory in use and restarts the original service", async () => {
  const f = await fixture();
  try {
    await symlink("/etc/hosts", join(f.source, "repository/link.md"));
    const target = join(f.root, "moved"), plan = await f.service.planDataMove("migrate", target);
    const result = await f.service.applyDataMove(plan.planId!, false);
    assert.equal(result.status, "failed"); assert.match(result.reason ?? "", /符号链接/); assert.match(result.reason ?? "", /未切换/);
    assert.equal((await f.config()).dataDirectory, f.source);
    assert.deepEqual(f.calls, ["stop", `start:${f.source}`, "load:18888:storage"]);
    assert.deepEqual(f.modes, []);
  } finally { await f.cleanup(); }
});

test("associate switches to an initialized directory without copying; other kinds are refused", async () => {
  const f = await fixture();
  try {
    const unsupported = join(f.root, "invalid"); await fixtureProduct(unsupported);
    await writeFile(dataPaths(unsupported).databasePath, "invalid SQLite header");
    assert.match((await f.service.planDataMove("associate", unsupported)).reason ?? "", /SQLite 文件头无效/);
    assert.match((await f.service.planDataMove("associate", join(f.root, "empty"))).reason ?? "", /已初始化/);
    const other = join(f.root, "other"); await fixtureProduct(other, 2, true);
    await mkdir(join(other, "repository/assets/global/memories"), { recursive: true });
    await writeFile(join(other, "repository/assets/global/memories/x.md"), "x"); await writeFile(join(other, "repository/assets/global/memories/y.md"), "y");
    const plan = await f.service.planDataMove("associate", other);
    assert.equal(plan.reason, null); assert.deepEqual(plan.statistics, {});
    const before = await tree(other);
    const result = await f.service.applyDataMove(plan.planId!, false);
    assert.equal(result.status, "success"); assert.equal(result.files, undefined);
    assert.equal((await f.config()).dataDirectory, other);
    assert.deepEqual(await tree(other), before);
    assert.deepEqual(f.calls, ["stop", `start:${other}`, "load:18888:storage"]);
  } finally { await f.cleanup(); }
});

test("sync-drive targets need explicit confirmation; a failed start after switching enters recovery without reverting", async () => {
  const f = await fixture({ startBackend: async config => { if (config.dataDirectory.includes("CloudStorage")) throw new Error("fixture start failure"); } });
  try {
    const target = join(f.env.home, "Library/CloudStorage/Drive/PrecedentLoop");
    const plan = await f.service.planDataMove("migrate", target);
    assert.equal(plan.syncRisk, true);
    await assert.rejects(f.service.applyDataMove(plan.planId!, false), /同步盘风险/);
    const confirmed = await f.service.planDataMove("migrate", target);
    const result = await f.service.applyDataMove(confirmed.planId!, true);
    assert.equal(result.status, "recovery"); assert.match(result.reason ?? "", /服务启动失败/);
    assert.equal((await f.config()).dataDirectory, target);
    assert.equal(f.service.startup.mode, "RECOVERY");
    assert.equal(f.modes.at(-1)?.mode, "RECOVERY");
    assert.ok((await stat(f.source)).isDirectory());
  } finally { await f.cleanup(); }
});

test("Hub can plan and apply a move, but only with a location from the main-process dialog", async () => {
  const f = await fixture();
  try {
    assert.ok(settingsMethods.includes("planDataMove") && settingsMethods.includes("applyDataMove"));
    let selected: string | null = null;
    const dispatch = createSetupDispatcher(join(f.root, "setup.html"), f.service, { selectDirectory: async () => selected, selectExecutable: async () => null,
      openLogs: async () => {}, quit: () => {}, getAppInfo: () => ({ version: "test" }), checkForUpdates: async () => {}, revealPath: async () => {}, selectDiagnosticDestination: async () => null }, () => "http://127.0.0.1:18888");
    const caller = { url: "http://127.0.0.1:18888/#/settings/storage", mainWindow: true, mainFrame: true };
    // The renderer cannot supply a path.
    assert.equal(setupRequestSchemas.planDataMove.safeParse({ mode: "migrate", path: "/tmp/x" }).success, false);
    await assert.rejects(dispatch("planDataMove", caller, { mode: "migrate", path: join(f.root, "moved") }), /SETUP_INVALID_ARGUMENT/);
    assert.equal(await dispatch("planDataMove", caller, { mode: "migrate" }), null);
    selected = join(f.root, "moved");
    const plan = await dispatch("planDataMove", caller, { mode: "migrate" }) as { planId: string; to: string };
    assert.equal(plan.to, selected);
    await assert.rejects(dispatch("applyDataMove", { ...caller, url: "http://127.0.0.1:18889/" }, { planId: plan.planId, syncRiskConfirmed: false }), /SETUP_CALLER_REJECTED/);
    const result = await dispatch("applyDataMove", caller, { planId: plan.planId, syncRiskConfirmed: false }) as { status: string };
    assert.equal(result.status, "success");
  } finally { await f.cleanup(); }
});
