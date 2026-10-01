import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSetupDispatcher, isSetupSender, setupMethods, setupRequestSchemas, type SetupMethod } from "../src/setup-ipc.js";
import { emptySetupState, readSetupState, setupStateSchema, writeSetupState } from "../src/setup-state.js";
import type { SetupStateFile } from "../src/setup-contract.js";
import type { SetupService } from "../src/setup-service.js";
import { initializeAppIdentity } from "../src/identity.js";
import { APP_NAME, BUNDLE_ID } from "../src/config.js";

test("setup IPC admits only the exact packaged file URL and validates every request before effects", async () => {
  const file = "/temporary/测试 App/runtime/apps/hub/dist/setup.html";
  const url = pathToFileURL(file).href;
  let calls = 0;
  const service = { getState: async () => { calls++; return "snapshot"; } } as unknown as SetupService;
  const dispatcher = createSetupDispatcher(file, service, { selectDirectory: async () => null, selectExecutable: async () => null, openLogs: async () => {}, quit: () => {}, getAppInfo: () => ({ version: "test" }), checkForUpdates: async () => {}, revealPath: async () => {}, selectDiagnosticDestination: async () => null });
  const dispatch = (method: SetupMethod, url: string, raw: unknown) => dispatcher(method, { url, mainWindow: true, mainFrame: true }, raw);
  assert.ok(isSetupSender(`${url}?mode=SETUP#step-1`, file));
  for (const sender of ["http://127.0.0.1:18888/", "https://example.com/setup.html", "file:///tmp/setup.html", "file://remote/tmp/setup.html", "about:blank", "data:text/html,test", "not-url", `${url}/child`]) {
    assert.equal(isSetupSender(sender, file), false, sender);
    await assert.rejects(dispatch("getState", sender, {}), /CALLER_REJECTED/);
    await assert.rejects(dispatch("resetInvalidConfig", sender, {}), /CALLER_REJECTED/);
    for (const method of ["getIntegrationStatus", "planIntegrations", "applyIntegrations", "planIntegrationRemoval", "listCodexProjects", "planWorkspaceImport", "importWorkspaces"] as const) {
      await assert.rejects(dispatch(method, sender, {}), /CALLER_REJECTED/);
    }
  }
  assert.equal(calls, 0);
  assert.equal(await dispatch("getState", url, {}), "snapshot");
  for (const method of Object.keys(setupRequestSchemas) as SetupMethod[]) {
    const error = setupMethods.includes(method) ? /INVALID_ARGUMENT/ : /CALLER_REJECTED/;
    await assert.rejects(dispatch(method, url, { unexpected: true }), error, method);
    await assert.rejects(dispatch(method, url, null), error, method);
  }
  for (const path of ["relative", "/tmp/\0bad", ""]) await assert.rejects(dispatch("checkDirectory", url, { path }), /INVALID_ARGUMENT/);
  await assert.rejects(dispatch("prepareDirectory", url, { path: "/tmp/data", syncRiskConfirmed: "yes", upgradeConfirmed: false, writersStopped: false }), /INVALID_ARGUMENT/);
  await assert.rejects(dispatch("selectExecutable", url, { agent: "shell" }), /INVALID_ARGUMENT/);
  await assert.rejects(dispatch("planIntegrations", url, { agent: "claude", items: ["mcp", "mcp"] }), /INVALID_ARGUMENT/);
  for (const selections of [[], [{ agent: "claude", items: ["mcp"] }, { agent: "claude", items: ["skills"] }], [{ agent: "codex", items: ["mcp"], path: "/tmp/foreign" }]]) {
    await assert.rejects(dispatch("planIntegrations", url, { selections }), /INVALID_ARGUMENT/);
  }
  await assert.rejects(dispatch("applyIntegrations", url, { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4", path: "/tmp/foreign" }), /INVALID_ARGUMENT/);
  await assert.rejects(dispatch("importWorkspaces", url, { paths: ["/tmp/arbitrary"] }), /INVALID_ARGUMENT/);
  assert.equal(calls, 1);
});

test("parsed optional detection fields omit undefined keys while retaining concrete values", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-state-optionals-"));
  try {
    const base = emptySetupState(join(root, "data"));
    const state: SetupStateFile = setupStateSchema.parse({ ...base, detections: [
      { agent: "codex", source: "auto", found: false, runnable: false, login: "unverified", checkedAt: base.updatedAt,
        path: undefined, version: undefined, reason: undefined },
      { agent: "claude", source: "manual", found: true, runnable: true, login: "logged-in", checkedAt: base.updatedAt,
        path: join(root, "claude"), version: "2.3.1", reason: "检测完成" },
    ] });
    const missing = state.detections[0]!;
    for (const key of ["path", "version", "reason"]) assert.equal(Object.hasOwn(missing, key), false);
    await writeSetupState(root, state);
    const loaded = await readSetupState(root, base.dataDirectory);
    assert.equal(loaded.resumed, true);
    assert.deepEqual(loaded.state.detections, state.detections);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent IPC mutations are rejected while state and progress remain readable", async () => {
  const file = "/tmp/setup.html";
  let finish: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const service = { prepareDirectory: () => blocked, getState: async () => "working" } as unknown as SetupService;
  const dispatcher = createSetupDispatcher(file, service, { selectDirectory: async () => null, selectExecutable: async () => null, openLogs: async () => {}, quit: () => {}, getAppInfo: () => ({ version: "test" }), checkForUpdates: async () => {}, revealPath: async () => {}, selectDiagnosticDestination: async () => null });
  const dispatch = (method: SetupMethod, url: string, raw: unknown) => dispatcher(method, { url, mainWindow: true, mainFrame: true }, raw);
  const preparation = dispatch("prepareDirectory", pathToFileURL(file).href, { path: "/tmp/data", syncRiskConfirmed: false, upgradeConfirmed: false, writersStopped: false });
  await assert.rejects(dispatch("complete", pathToFileURL(file).href, {}), /SETUP_BUSY/);
  await assert.rejects(dispatch("applyIntegrations", pathToFileURL(file).href, { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4" }), /SETUP_BUSY/);
  await assert.rejects(dispatch("importWorkspaces", pathToFileURL(file).href, { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4" }), /SETUP_BUSY/);
  assert.equal(await dispatch("getState", pathToFileURL(file).href, {}), "working");
  finish!(); await preparation;
});

test("setup-state preserves invalid files and atomically saves a strict 0600 draft without account fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-state-"));
  try {
    const path = join(root, "setup-state.json");
    const draft = emptySetupState(join(root, "data"));
    assert.equal((await readSetupState(root, draft.dataDirectory)).resumed, false);
    await writeFile(path, "broken");
    assert.ok((await readSetupState(root, draft.dataDirectory)).warning);
    assert.equal(await readFile(path, "utf8"), "broken");
    draft.step = 3; draft.agents.codex = true; draft.manualPaths.codex = join(root, "codex"); draft.aiProvider = "codex";
    await writeSetupState(root, draft);
    const oldInode = (await stat(path)).ino;
    await chmod(path, 0o644);
    await writeSetupState(root, { ...draft, step: 4 });
    assert.notEqual((await stat(path)).ino, oldInode);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const saved = await readSetupState(root, draft.dataDirectory);
    assert.equal(saved.state.step, 4); assert.equal(saved.resumed, true);
    assert.deepEqual(saved.state.manualPaths, draft.manualPaths);
    await assert.rejects(writeSetupState(root, { ...draft, extra: "secret@example.com" } as typeof draft));
    assert.deepEqual(await readdir(root), ["setup-state.json"]);
    await rm(path); await mkdir(path);
    await assert.rejects(writeSetupState(root, draft));
    assert.deepEqual(await readdir(root), ["setup-state.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("application name and test userData are established synchronously before ready registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-identity-"));
  try {
    const events: string[] = [];
    const name = `${APP_NAME}-Test-startup`;
    const identity = { isPackaged: true,
      setName: (value: string) => { events.push(`name:${value}`); },
      getPath: (_key: "appData") => join(root, "Application Support"),
      setPath: (_key: "userData", value: string) => { events.push(`path:${value}`); },
    };
    const target = join(root, "test-user-data");
    const result = initializeAppIdentity(identity, join(root, `${name}.app/Contents/MacOS`, name),
      plist => { assert.equal(plist, join(root, `${name}.app/Contents/Info.plist`)); return `${BUNDLE_ID}.test.startup`; },
      { PRECEDENT_LOOP_USER_DATA_DIR: target });
    events.push("whenReady");
    assert.equal(result, target);
    assert.deepEqual(events, [`name:${name}`, `path:${target}`, "whenReady"]);
    assert.ok((await stat(target)).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});
