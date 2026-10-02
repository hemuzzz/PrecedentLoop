import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema, dataPaths, readAppConfig, writeAppConfig } from "../src/config.js";
import { inspectDataDirectory } from "../src/data-directory.js";
import { SetupService, chooseSetupPort, type SetupDependencies } from "../src/setup-service.js";
import { emptySetupState, readSetupState, writeSetupState } from "../src/setup-state.js";
import type { PreparationProgress, PrepareRequest } from "../src/setup-contract.js";
import { fixtureProduct, fixtureRuntime } from "./setup-fixture.js";

async function fixture(root: string, overrides: Partial<SetupDependencies> = {}) {
  const progress: PreparationProgress[] = [];
  const service = new SetupService({ userData: join(root, "userData"), runtime: await fixtureRuntime(root), home: root,
    portAvailable: async port => port >= 18890, startBackend: async () => {}, stopBackend: async () => {},
    backendStatus: async () => ({ serviceReady: true, mcpReady: true }), verifyRuntime: async () => "内置 Node 24.21.0",
    changeMode: async () => {}, progress: value => progress.push(value),
    detect: async (agent, manualPath) => ({ agent, source: manualPath ? "manual" : "auto", found: false, runnable: false,
      login: "unverified", checkedAt: new Date().toISOString() }), ...overrides });
  await service.initialize();
  return { service, progress };
}
function request(path: string): PrepareRequest { return { path, syncRiskConfirmed: false }; }

test("ports advance only through 18888–18898 and exhaustion is explicit", async () => {
  const calls: number[] = [];
  assert.equal(await chooseSetupPort(async port => { calls.push(port); return port === 18890; }), 18890);
  assert.deepEqual(calls, [18888, 18889, 18890]);
  let probes = 0;
  await assert.rejects(chooseSetupPort(async () => { probes++; return false; }), /均被占用/);
  assert.equal(probes, 11);
  await assert.rejects(chooseSetupPort(async () => { throw new Error("EPERM"); }), /EPERM/);
});

test("preparation creates new, empty, child and marked incomplete directories without deleting user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-prepare-"));
  try {
    for (const kind of ["missing", "empty", "other", "incomplete"]) {
      const base = join(root, kind); await mkdir(base);
      const { service } = await fixture(base);
      const path = join(base, "data");
      if (kind !== "missing") await mkdir(path);
      if (kind === "empty") await writeFile(join(path, ".DS_Store"), "finder");
      if (kind === "other") await writeFile(join(path, "keep.txt"), "mine");
      if (kind === "incomplete") await fixtureProduct(path, 0, true);
      const actual = kind === "other" ? join(path, "PrecedentLoop") : path;
      const check = await service.checkDirectory(path);
      assert.equal(check.dataDirectory, actual); assert.equal(check.port, 18890);
      const state = await service.prepareDirectory(request(path));
      assert.equal(state.config?.setupCompleted, false); assert.equal(state.config?.dataDirectory, actual);
      assert.equal(state.config?.port, 18890); assert.equal(state.dataCommitted, true); assert.equal(state.draft.step, 2);
      assert.equal((await inspectDataDirectory(actual)).kind, "PRODUCT");
      if (kind === "other") assert.equal(await readFile(join(path, "keep.txt"), "utf8"), "mine");
      await assert.rejects(service.prepareDirectory(request(join(base, "replacement"))), /已提交/);
      await assert.rejects(service.saveDraft({ step: 2, dataDirectory: join(base, "replacement"), agents: state.draft.agents,
        manualPaths: state.draft.manualPaths, aiProvider: state.draft.aiProvider }), /已提交/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing knowledge is inspected without writes and exposes only workspace statistics", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-existing-"));
  try {
    const { service } = await fixture(root);
    const path = join(root, "data"); await fixtureProduct(path);
    await writeFile(dataPaths(path).workspaceConfigPath, '{"schemaVersion":1,"workspaces":[{},{}]}');
    const check = await service.checkDirectory(path);
    assert.deepEqual(check.statistics, { workspaces: 2 });
    assert.ok(await readFile(join(path, ".precedentloop.json")));
    const before = await readFile(dataPaths(path).databasePath);
    await service.prepareDirectory(request(path));
    assert.deepEqual(await readFile(dataPaths(path).databasePath), before);
    assert.ok(await readFile(join(path, ".precedentloop.json")));
    await assert.rejects(readFile(join(path, "commands.jsonl")), { code: "ENOENT" });
    await writeFile(dataPaths(path).workspaceConfigPath, "broken");
    assert.equal((await service.checkDirectory(path)).statistics?.workspaces, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preparation requires synchronization risk consent and rechecks classification on submit", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-sync-"));
  try {
    const { service } = await fixture(root);
    const path = join(root, "Library/CloudStorage/data");
    assert.equal((await service.checkDirectory(path)).inspection.kind, "SYNC_RISK");
    await assert.rejects(service.prepareDirectory(request(path)), /确认同步盘风险/);
    await service.prepareDirectory({ ...request(path), syncRiskConfirmed: true });
    assert.equal((await service.getState()).dataCommitted, true);
    const separate = join(root, "separate"); await mkdir(separate);
    const second = await fixture(separate);
    const another = join(separate, "data");
    assert.equal((await second.service.checkDirectory(another)).inspection.kind, "MISSING");
    await fixtureProduct(another, 7, true);
    await writeFile(dataPaths(another).databasePath, "invalid SQLite header");
    await assert.rejects(second.service.prepareDirectory(request(another)), /目标不是/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed service retries do not repeat completed storage or folder writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-retry-"));
  try {
    let starts = 0;
    const { service, progress } = await fixture(root, { startBackend: async () => { if (++starts === 1) throw new Error("fixture service failed"); } });
    const path = join(root, "data");
    await assert.rejects(service.prepareDirectory(request(path)), /fixture service failed/);
    assert.ok(progress.some(item => item.step === "service" && item.status === "failed" && item.reason?.includes("fixture service failed")));
    const commands = await readFile(join(path, "commands.jsonl"));
    const workspace = await stat(dataPaths(path).workspaceConfigPath);
    const marker = await stat(join(path, ".precedentloop.json"));
    await service.prepareDirectory(request(path));
    assert.equal(starts, 2);
    assert.deepEqual(await readFile(join(path, "commands.jsonl")), commands);
    assert.equal((await stat(dataPaths(path).workspaceConfigPath)).mtimeMs, workspace.mtimeMs);
    assert.equal((await stat(join(path, ".precedentloop.json"))).mtimeMs, marker.mtimeMs);
    assert.equal(progress.filter(item => item.step === "folders" && item.status === "running").length, 1);
    assert.equal(progress.filter(item => item.step === "storage" && item.status === "running").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("interrupted storage retries resume missing migration and retain completed layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-storage-retry-"));
  try {
    const { service, progress } = await fixture(root);
    const path = join(root, "data"); await fixtureProduct(path, 0, true);
    await writeFile(join(path, "fail-migration"), "fail");
    await assert.rejects(service.prepareDirectory(request(path)), /init-database/);
    const marker = await readFile(join(path, ".precedentloop.json"));
    await rm(join(path, "fail-migration"));
    await service.prepareDirectory(request(path));
    assert.equal(progress.filter(item => item.step === "folders" && item.status === "running").length, 1);
    assert.deepEqual(await readFile(join(path, ".precedentloop.json")), marker);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete Setup resumes its draft and starts the service; completing always rechecks all core conditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-complete-"));
  try {
    const path = join(root, "data"); await fixtureProduct(path);
    const userData = join(root, "userData");
    await writeAppConfig(userData, appConfigSchema.parse({ configVersion: 1, setupVersion: 0, setupCompleted: false, dataDirectory: path }));
    await writeSetupState(userData, { ...emptySetupState(path), step: 4, agents: { codex: true, claude: false } });
    let starts = 0, healthy = false;
    const modes: string[] = [];
    const { service } = await fixture(root, { startBackend: async () => { starts++; },
      backendStatus: async () => ({ serviceReady: healthy, mcpReady: healthy }), changeMode: async mode => { modes.push(mode.mode); } });
    const snapshot = await service.getState();
    assert.equal(snapshot.draft.step, 4); assert.equal(snapshot.resumed, true); assert.equal(snapshot.dataCommitted, true);
    assert.equal(starts, 1);
    await assert.rejects(service.complete(), /核心检查未通过/);
    assert.equal((await readAppConfig(userData)).kind, "VALID");
    healthy = true;
    assert.ok((await service.checkCore()).every(check => check.ok));
    healthy = false;
    await assert.rejects(service.complete(), /核心检查未通过/);
    healthy = true;
    await service.complete();
    const config = await readAppConfig(userData);
    assert.ok(config.kind === "VALID" && config.config.setupCompleted && config.config.setupVersion === 1);
    assert.equal(modes.at(-1), "NORMAL");
    await assert.rejects(service.prepareDirectory(request(path)), /当前模式/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery rejects unrelated directories and only updates the association to existing supported data", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-recovery-"));
  try {
    const userData = join(root, "userData");
    const original = appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: true, dataDirectory: join(root, "missing") });
    await writeAppConfig(userData, original);
    const { service } = await fixture(root);
    assert.equal((await service.getState()).startup.mode, "RECOVERY");
    await assert.rejects(service.selectRecoveryDirectory(join(root, "new")), /已初始化的本产品/);
    const invalid = join(root, "invalid"); await fixtureProduct(invalid);
    await writeFile(dataPaths(invalid).databasePath, "invalid SQLite header");
    await assert.rejects(service.selectRecoveryDirectory(invalid), /已初始化的本产品/);
    assert.deepEqual(await readAppConfig(userData), { kind: "VALID", config: original });
    const valid = join(root, "existing"); await fixtureProduct(valid);
    const before = await readFile(dataPaths(valid).databasePath);
    const state = await service.selectRecoveryDirectory(valid);
    assert.equal(state.startup.mode, "NORMAL");
    assert.deepEqual(await readFile(dataPaths(valid).databasePath), before);
    const updated = await readAppConfig(userData);
    assert.ok(updated.kind === "VALID" && updated.config.dataDirectory === valid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime, storage and MCP failures independently block completion, while Agent detection does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-core-"));
  try {
    let runtimeHealthy = false, mcpReady = true;
    const { service } = await fixture(root, { verifyRuntime: async () => { if (!runtimeHealthy) throw new Error("Node ABI mismatch"); return "Node 24.21.0"; },
      backendStatus: async () => ({ serviceReady: true, mcpReady }) });
    const path = join(root, "data"); await fixtureProduct(path);
    await service.prepareDirectory(request(path));
    await assert.rejects(service.complete(), /核心检查未通过/);
    const checks = await service.checkCore();
    assert.equal(checks.find(item => item.id === "runtime")?.ok, false);
    runtimeHealthy = true; mcpReady = false;
    assert.equal((await service.checkCore()).find(item => item.id === "service")?.ok, true);
    await assert.rejects(service.complete(), /核心检查未通过/);
    mcpReady = true;
    await fixtureProduct(path, 0);
    await assert.rejects(service.complete(), /核心检查未通过/);
    await fixtureProduct(path, 2);
    await service.detectAgents(); // Neither Agent is installed in this isolated fixture.
    await service.complete();
    assert.equal(service.startup.mode, "NORMAL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an uninitialized saved app config returns to step one without starting the backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-unprepared-"));
  try {
    const userData = join(root, "userData"), path = join(root, "missing");
    await writeAppConfig(userData, appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: path }));
    await writeSetupState(userData, { ...emptySetupState(path), step: 4 });
    let starts = 0;
    const { service } = await fixture(root, { startBackend: async () => { starts++; } });
    const state = await service.getState();
    assert.equal(state.startup.mode, "SETUP"); assert.equal(state.draft.step, 1); assert.equal(state.dataCommitted, false); assert.equal(starts, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("damaged app configuration is preserved when recovery cannot safely retain its settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-damaged-config-"));
  try {
    const userData = join(root, "userData"); await mkdir(userData);
    await writeFile(join(userData, "app-config.json"), "{damaged");
    const { service } = await fixture(root);
    const path = join(root, "data"); await fixtureProduct(path);
    await assert.rejects(service.selectRecoveryDirectory(path), /先修复配置文件/);
    assert.equal(await readFile(join(userData, "app-config.json"), "utf8"), "{damaged");
    assert.equal(service.startup.mode, "RECOVERY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid config reset moves the original bytes and inode to a new backup and returns to Setup step one", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-reset-invalid-"));
  try {
    for (const [name, content] of [["json", Buffer.from([123, 0, 255])], ["schema", Buffer.from('{"configVersion":99,"port":19999}')]] as const) {
      const base = join(root, name); await mkdir(base);
      const userData = join(base, "userData"); await mkdir(userData);
      const source = join(userData, "app-config.json"); await writeFile(source, content, { mode: 0o600 });
      const original = await stat(source);
      const dataDirectory = join(base, "knowledge"); await fixtureProduct(dataDirectory);
      const database = await readFile(dataPaths(dataDirectory).databasePath);
      await writeSetupState(userData, { ...emptySetupState(dataDirectory), step: 4 });
      const modes: string[] = [];
      const instant = new Date("2026-09-23T10:11:12.345Z");
      const { service } = await fixture(base, { now: () => instant, changeMode: async mode => { modes.push(mode.mode); } });
      assert.equal(service.startup.mode, "RECOVERY");
      const snapshot = await service.resetInvalidConfig();
      const backup = join(userData, "backups/2026-09-23T10-11-12-345Z/app-config.json");
      assert.deepEqual(await readFile(backup), content);
      assert.equal((await stat(backup)).ino, original.ino); // rename, not copy followed by deletion
      await assert.rejects(readFile(source), { code: "ENOENT" });
      assert.equal(snapshot.startup.mode, "SETUP"); assert.equal(modes.at(-1), "SETUP");
      assert.equal(snapshot.draft.step, 1); assert.equal(snapshot.draft.dataDirectory, dataDirectory);
      assert.equal(snapshot.config, null); assert.equal(snapshot.dataCommitted, false);
      assert.equal((await readSetupState(userData, dataDirectory)).state.step, 1);
      assert.deepEqual(await readFile(dataPaths(dataDirectory).databasePath), database);
      assert.equal((await service.recheck()).startup.mode, "SETUP");
      await assert.rejects(service.resetInvalidConfig(), /仅配置文件无效/);
      assert.deepEqual(await readFile(backup), content);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid config reset rereads disk and refuses repaired, missing, or unreadable configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-reset-refuse-"));
  try {
    for (const kind of ["valid", "missing", "directory"]) {
      const base = join(root, kind); await mkdir(base);
      const userData = join(base, "userData"); await mkdir(userData);
      const source = join(userData, "app-config.json"); await writeFile(source, "{broken");
      const { service } = await fixture(base);
      if (kind === "valid") await writeAppConfig(userData, appConfigSchema.parse({ configVersion: 1, setupVersion: 1,
        setupCompleted: false, dataDirectory: join(base, "data") }));
      else { await rm(source); if (kind === "directory") await mkdir(source); }
      await assert.rejects(service.resetInvalidConfig(), kind === "valid" ? /恢复正常/ : kind === "missing" ? { code: "ENOENT" } : /不是普通文件/);
      await assert.rejects(readdir(join(userData, "backups")), { code: "ENOENT" });
      if (kind === "valid") assert.equal((await readAppConfig(userData)).kind, "VALID");
      assert.equal(service.startup.mode, "RECOVERY");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid config backup collision preserves both existing backup and source without resetting the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-reset-collision-"));
  try {
    const userData = join(root, "userData"); await mkdir(userData);
    const source = join(userData, "app-config.json"); await writeFile(source, "{broken-current");
    const draft = { ...emptySetupState(join(root, "data")), step: 3 as const }; await writeSetupState(userData, draft);
    const instant = new Date("2026-09-23T10:11:12.345Z");
    const backupRoot = join(userData, "backups/2026-09-23T10-11-12-345Z"); await mkdir(backupRoot, { recursive: true });
    const backup = join(backupRoot, "app-config.json"); await writeFile(backup, "previous backup");
    const { service } = await fixture(root, { now: () => instant });
    await assert.rejects(service.resetInvalidConfig(), { code: "EEXIST" });
    assert.equal(await readFile(source, "utf8"), "{broken-current");
    assert.equal(await readFile(backup, "utf8"), "previous backup");
    assert.equal((await readSetupState(userData, draft.dataDirectory)).state.step, 3);
    assert.equal(service.startup.mode, "RECOVERY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a config repaired during backend shutdown is not moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-reset-changed-"));
  try {
    const userData = join(root, "userData"); await mkdir(userData);
    await writeFile(join(userData, "app-config.json"), "{broken");
    const config = appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: false, dataDirectory: join(root, "data") });
    const { service } = await fixture(root, { stopBackend: () => writeAppConfig(userData, config) });
    await assert.rejects(service.resetInvalidConfig(), /配置文件已变化/);
    assert.deepEqual(await readAppConfig(userData), { kind: "VALID", config });
  } finally { await rm(root, { recursive: true, force: true }); }
});
