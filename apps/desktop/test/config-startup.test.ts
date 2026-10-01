import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_NAME, BUNDLE_ID, appConfigSchema, buildConfigSchema, dataPaths, readAppConfig, resolveUserData, writeAppConfig } from "../src/config.js";
import { backendFailureMode, determineStartupMode } from "../src/startup.js";
import type { DataDirectoryInspection } from "../src/data-directory.js";

const draft = { configVersion: 1, setupVersion: 0, setupCompleted: false, dataDirectory: "/temporary/data" };

test("build configuration strips legacy fields while app configuration is strict", () => {
  assert.deepEqual(buildConfigSchema.parse({ nodePath: "/runtime/node", dataDirectory: "ignored", port: "ignored" }), {});
  assert.deepEqual(buildConfigSchema.parse({ nodePath: "relative", nodeLicensePath: "relative" }), {});
  assert.deepEqual(buildConfigSchema.parse({}), {});
  const config = appConfigSchema.parse(draft);
  assert.equal(config.port, 18888);
  assert.equal(config.startupTimeoutMs, 30000);
  assert.equal(config.shutdownTimeoutMs, 15000);
  for (const value of [{ ...draft, configVersion: 2 }, { ...draft, setupVersion: 1.5 }, { ...draft, setupVersion: -1 },
    { ...draft, setupCompleted: "true" }, { ...draft, dataDirectory: "relative" }, { ...draft, port: 65536 },
    { ...draft, startupTimeoutMs: 0 }, { ...draft, shutdownTimeoutMs: -1 }, { ...draft, nodePath: "/external/node" },
    { ...draft, extra: true }, { ...draft, setupVersion: undefined }]) assert.equal(appConfigSchema.safeParse(value).success, false);
  assert.deepEqual(dataPaths(config.dataDirectory), { assetRepositoryPath: "/temporary/data/repository",
    databasePath: "/temporary/data/runtime/precedent-loop.sqlite", workspaceConfigPath: "/temporary/data/config/workspaces.json",
    logPath: "/temporary/data/logs/server.log", desktopLogPath: "/temporary/data/logs/desktop.log" });
});

test("app config distinguishes missing, damaged and invalid files without overwriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-config-"));
  const file = join(root, "app-config.json");
  try {
    assert.deepEqual(await readAppConfig(root), { kind: "MISSING" });
    for (const text of ["{broken", JSON.stringify({ ...draft, extra: true }), "null"]) {
      await writeFile(file, text);
      assert.equal((await readAppConfig(root)).kind, "INVALID");
      assert.equal(await readFile(file, "utf8"), text);
    }
    await writeFile(file, JSON.stringify(draft));
    assert.deepEqual(await readAppConfig(root), { kind: "VALID", config: appConfigSchema.parse(draft) });
    await rm(file);
    await mkdir(file);
    assert.equal((await readAppConfig(root)).kind, "INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("app config writes replace atomically with 0600 permissions and clean failed temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-config-write-"));
  const file = join(root, "app-config.json");
  const config = appConfigSchema.parse(draft);
  try {
    await writeAppConfig(root, config);
    await chmod(file, 0o644);
    const oldInode = (await stat(file)).ino;
    await writeAppConfig(root, { ...config, setupCompleted: true });
    assert.notEqual((await stat(file)).ino, oldInode);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    let writing = true;
    const writer = (async () => {
      try { for (let i = 0; i < 15; i++) await writeAppConfig(root, { ...config, setupVersion: i }); }
      finally { writing = false; }
    })();
    while (writing) assert.equal((await readAppConfig(root)).kind, "VALID");
    await writer;
    assert.deepEqual(await readdir(root), ["app-config.json"]);
    const before = await readFile(file, "utf8");
    await assert.rejects(writeAppConfig(root, { ...config, port: 0 }));
    assert.equal(await readFile(file, "utf8"), before);
    await rm(file); await mkdir(file);
    await assert.rejects(writeAppConfig(root, config));
    assert.deepEqual(await readdir(root), ["app-config.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only a complete test identity can override userData", () => {
  const appData = "/temporary/Application Support";
  const env = { PRECEDENT_LOOP_USER_DATA_DIR: "/temporary/isolated" };
  const production = { name: APP_NAME, bundleId: BUNDLE_ID };
  const testIdentity = { name: `${APP_NAME}-Test-config`, bundleId: `${BUNDLE_ID}.test.config` };
  assert.equal(resolveUserData(production, appData, env), join(appData, APP_NAME));
  assert.equal(resolveUserData({ ...testIdentity, bundleId: BUNDLE_ID }, appData, env), join(appData, testIdentity.name));
  assert.equal(resolveUserData({ ...testIdentity, name: APP_NAME }, appData, env), join(appData, APP_NAME));
  assert.equal(resolveUserData(testIdentity, appData, env), env.PRECEDENT_LOOP_USER_DATA_DIR);
  assert.equal(resolveUserData(testIdentity, appData, {}), join(appData, testIdentity.name));
  assert.throws(() => resolveUserData(testIdentity, appData, { PRECEDENT_LOOP_USER_DATA_DIR: "relative" }));
  assert.equal(resolveUserData(production, appData, { PRECEDENT_LOOP_USER_DATA_DIR: "relative" }), join(appData, APP_NAME));
});

test("startup classifies every directory outcome before starting a backend", () => {
  assert.equal(determineStartupMode({ kind: "MISSING" }).mode, "SETUP");
  const invalid = determineStartupMode({ kind: "INVALID", reason: "坏 JSON" });
  assert.equal(invalid.mode, "RECOVERY");
  assert.ok(invalid.mode !== "NORMAL" && invalid.code === "CONFIG_INVALID" && invalid.reason.includes("坏 JSON"));
  const config = appConfigSchema.parse(draft);
  assert.equal(determineStartupMode({ kind: "VALID", config }, { kind: "PRODUCT", storageVersion: 1 }).mode, "SETUP");
  assert.equal(determineStartupMode({ kind: "VALID", config }, { kind: "MISSING" }).mode, "SETUP");
  const complete = { kind: "VALID" as const, config: { ...config, setupCompleted: true } };
  assert.deepEqual(determineStartupMode(complete, { kind: "PRODUCT", storageVersion: 1 }), { mode: "NORMAL", dataDirectory: config.dataDirectory });
  const cases: Array<[DataDirectoryInspection | undefined, string]> = [
    [{ kind: "MISSING" }, "DATA_MISSING"], [{ kind: "EMPTY" }, "DATA_NOT_PRODUCT"], [{ kind: "OTHER_NON_EMPTY" }, "DATA_NOT_PRODUCT"],
    [{ kind: "NOT_WRITABLE", reason: "无权限" }, "DATA_INACCESSIBLE"],
    [{ kind: "PRODUCT_INCOMPLETE" }, "STORAGE_INCOMPLETE"],
    [{ kind: "PRODUCT_UNSUPPORTED", storageVersion: 7, reason: "版本太新" }, "STORAGE_UNSUPPORTED"], [undefined, "DATA_UNCHECKED"],
    [{ kind: "SYNC_RISK", inspection: { kind: "NOT_WRITABLE", reason: "无权限" } }, "DATA_INACCESSIBLE"],
  ];
  for (const [inspection, code] of cases) {
    const mode = determineStartupMode(complete, inspection);
    assert.equal(mode.mode, "RECOVERY");
    assert.ok(mode.mode !== "NORMAL" && mode.code === code && mode.reason.length > 0);
    assert.equal(mode.dataDirectory, config.dataDirectory);
  }
  assert.equal(determineStartupMode(complete, { kind: "SYNC_RISK", inspection: { kind: "PRODUCT", storageVersion: 1 } }).mode, "NORMAL");
  const failure = backendFailureMode(config.dataDirectory, new Error("端口被占用"), "/temporary/desktop.log");
  assert.equal(failure.mode, "RECOVERY");
  assert.ok(failure.mode !== "NORMAL" && failure.code === "BACKEND_FAILED");
  assert.ok(failure.mode !== "NORMAL" && failure.reason.includes("端口被占用") && failure.reason.includes("/temporary/desktop.log"));
});
