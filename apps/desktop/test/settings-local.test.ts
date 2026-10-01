import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { appConfigSchema, dataPaths, readAppConfig, readBuildInfo, writeAppConfig, type AppConfig } from "../src/config.js";
import { SetupService, type SetupDependencies } from "../src/setup-service.js";
import { createSetupDispatcher } from "../src/setup-ipc.js";
import { exportDiagnostics } from "../src/diagnostics.js";
import { integrationFixture } from "./integration-fixture.js";
import { fixtureProduct, fixtureRuntime } from "./setup-fixture.js";

async function fixture(extra: Partial<SetupDependencies> = {}, completed = true) {
  const f = await integrationFixture();
  await fixtureProduct(f.config.dataDirectory);
  const runtime = await fixtureRuntime(f.root);
  const initial = appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: completed, ...f.config });
  await writeAppConfig(f.env.userData, initial);
  const calls: string[] = [];
  const service = new SetupService({ userData: f.env.userData, home: f.env.home, runtime, integrations: f.env,
    startBackend: async config => { calls.push(`start:${config.port}`); }, stopBackend: async () => { calls.push("stop"); },
    backendStatus: async () => ({ serviceReady: true, mcpReady: true }), portAvailable: async () => true,
    reloadSettings: async port => { calls.push(`load:${port}`); },
    verifyRuntime: async () => "fixture", changeMode: async () => {}, progress: () => {},
    detect: async (agent, path) => ({ agent, source: path ? "manual" : "auto", path: path ?? join(f.root, "bin", agent), found: true, runnable: true, login: "unverified", checkedAt: "2026-09-24T00:00:00.000Z" }), ...extra });
  await service.initialize(); calls.length = 0;
  const config = async (): Promise<AppConfig> => { const result = await readAppConfig(f.env.userData); assert.ok(result.kind === "VALID"); return result.config; };
  return { ...f, service, runtime, calls, config };
}

test("normal startup runs no CLI detection and leaves app-config untouched; AI keeps the persisted paths", async () => {
  let detections = 0;
  const f = await fixture({ detect: async (agent, path) => { detections++; return { agent, source: path ? "manual" : "auto", path: path ?? "/detected", found: true, runnable: true, login: "unverified", checkedAt: "2026-09-24T00:00:00.000Z" }; } });
  try {
    const persisted = { ...await f.config(), detectedPaths: { codex: join(f.root, "bin/codex") } };
    await writeAppConfig(f.env.userData, persisted);
    const before = await readFile(join(f.env.userData, "app-config.json"), "utf8");
    detections = 0;
    await f.service.initialize();
    assert.equal(f.service.startup.mode, "NORMAL");
    assert.equal(detections, 0);
    assert.equal(await readFile(join(f.env.userData, "app-config.json"), "utf8"), before);
    // Settings still detects on demand, after startup.
    await f.service.detectAgents();
    assert.equal(detections, 2);
  } finally { await f.cleanup(); }
});

test("executable paths require a same-Agent dialog result, are single use and cancel/reset invalidates them", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "setup.html"), caller = { url: "http://127.0.0.1:18888/#/settings/codex", mainWindow: true, mainFrame: true };
    let selected: string | null = join(f.root, "chosen/codex");
    const dispatch = createSetupDispatcher(file, f.service, { selectDirectory: async () => null, selectExecutable: async () => selected,
      openLogs: async () => {}, quit: () => {}, getAppInfo: () => ({ version: "test" }), checkForUpdates: async () => {}, revealPath: async () => {}, selectDiagnosticDestination: async () => null }, () => "http://127.0.0.1:18888");
    await assert.rejects(dispatch("saveAgentPath", caller, { agent: "codex", path: selected }), /SELECTION_REQUIRED/);
    await dispatch("selectExecutable", caller, { agent: "codex" });
    await assert.rejects(dispatch("saveAgentPath", caller, { agent: "claude", path: selected }), /SELECTION_REQUIRED/);
    await assert.rejects(dispatch("saveAgentPath", caller, { agent: "codex", path: join(f.root, "forged") }), /SELECTION_REQUIRED/);
    await dispatch("saveAgentPath", caller, { agent: "codex", path: selected });
    assert.equal((await f.config()).manualPaths?.codex, selected);
    await assert.rejects(dispatch("saveAgentPath", caller, { agent: "codex", path: selected }), /SELECTION_REQUIRED/);
    await dispatch("selectExecutable", caller, { agent: "codex" }); selected = null;
    await dispatch("selectExecutable", caller, { agent: "codex" });
    await assert.rejects(dispatch("saveAgentPath", caller, { agent: "codex", path: join(f.root, "chosen/codex") }), /SELECTION_REQUIRED/);
    await dispatch("saveAgentPath", caller, { agent: "codex", path: null });
    assert.equal((await f.config()).manualPaths?.codex, undefined);
  } finally { await f.cleanup(); }
});

test("Setup draft accepts only unchanged, cleared or dialog-selected manual paths", async () => {
  const f = await fixture({}, false);
  try {
    const draft = (await f.service.getState()).draft;
    const input = { step: draft.step, dataDirectory: draft.dataDirectory, agents: draft.agents, manualPaths: draft.manualPaths, aiProvider: draft.aiProvider };
    const path = join(f.root, "selected");
    await assert.rejects(f.service.saveDraft({ ...input, manualPaths: { codex: path, claude: null } }), /SELECTION_REQUIRED/);
    f.service.rememberExecutable("codex", path);
    await assert.rejects(f.service.saveDraft({ ...input, manualPaths: { codex: null, claude: path } }), /SELECTION_REQUIRED/);
    const changed = await f.service.saveDraft({ ...input, manualPaths: { codex: path, claude: null } });
    await f.service.saveDraft({ ...input, manualPaths: changed.manualPaths });
    await f.service.saveDraft({ ...input, manualPaths: { codex: null, claude: null } });
    await assert.rejects(f.service.saveDraft({ ...input, manualPaths: changed.manualPaths }), /SELECTION_REQUIRED/);
  } finally { await f.cleanup(); }
});

test("disabled Agent retains installed, repair and external item status instead of hiding all items", async () => {
  const f = await fixture();
  try {
    const install = await f.engine.plan({ agent: "codex", items: ["mcp", "projectContext"] }); await f.engine.apply(install.planId);
    await writeFile(f.env.claudeConfig, JSON.stringify({ mcpServers: { "precedent": { type: "http", url: "http://127.0.0.1:18888/mcp" } } }));
    await writeAppConfig(f.env.userData, { ...await f.config(), agents: { codex: false, claude: false } });
    let statuses = await f.service.getIntegrationStatus({});
    assert.equal(statuses[0]!.items.find(item => item.item === "projectContext")!.label, "待处理");
    assert.equal(statuses[0]!.items.find(item => item.item === "mcp")!.label, "已配置，未验证");
    assert.equal(statuses[1]!.items.find(item => item.item === "mcp")!.label, "外部已存在");
    assert.equal(statuses[1]!.items.find(item => item.item === "projectContext")!.label, "未接入");
    const hooksPath = join(f.env.codexHome, "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8")); hooks.hooks.UserPromptSubmit[0].hooks[0].command += " modified";
    await writeFile(hooksPath, JSON.stringify(hooks));
    statuses = await f.service.getIntegrationStatus({});
    assert.equal(statuses[0]!.items.find(item => item.item === "projectContext")!.configuration, "repair");
    assert.equal(statuses[0]!.items.find(item => item.item === "projectContext")!.label, "待处理");
    assert.notEqual(statuses[0]!.label, "未接入");
  } finally { await f.cleanup(); }
});

test("Setup completion persists the exact automatic detections used by the Agent page", async () => {
  const f = await fixture({}, false);
  try {
    const detections = await f.service.detectAgents();
    await f.service.complete();
    assert.deepEqual((await f.config()).detectedPaths, Object.fromEntries(detections.map(item => [item.agent, item.path])));
  } finally { await f.cleanup(); }
});

test("AI overrides are strict; reset changes only AI and stages the default port", async () => {
  const f = await fixture();
  try {
    const original = { ...await f.config(), port: 18900, manualPaths: { codex: join(f.root, "manual") }, agents: { codex: true }, integrationChoices: { codex: { mcp: "enabled" as const } } };
    await writeAppConfig(f.env.userData, original);
    const workspace = await readFile(dataPaths(original.dataDirectory).workspaceConfigPath);
    const database = await readFile(dataPaths(original.dataDirectory).databasePath);
    const ai = { defaultProvider: "claude" as const, providers: { codex: { model: "custom", profile: "private", effort: "xhigh", timeoutMs: 180000 }, claude: { model: "other" } } };
    await f.service.saveAiSettings(ai); assert.deepEqual((await f.config()).ai, ai);
    await assert.rejects(f.service.saveAiSettings({ providers: { claude: { profile: "forged" } } } as never));
    await assert.rejects(f.service.saveAiSettings({ providers: { codex: { timeoutMs: 999 } } }));
    await assert.rejects(f.service.saveAiSettings({ providers: { claude: { effort: "high\" --x" } } }));
    await f.service.saveAiSettings({}); assert.equal((await f.config()).ai, undefined);
    await f.service.saveAiSettings(ai);
    const reset = await f.service.restoreDefaults();
    assert.equal(reset.pendingPort, 18888); assert.equal(reset.port, 18900);
    assert.deepEqual(await f.config(), original);
    assert.deepEqual(await readFile(dataPaths(original.dataDirectory).workspaceConfigPath), workspace);
    assert.deepEqual(await readFile(dataPaths(original.dataDirectory).databasePath), database);
    assert.deepEqual(f.calls, []);
    assert.equal(reset.storageVersion, 1); assert.equal(reset.runtime.nodeVersion, "v24.21.0");
  } finally { await f.cleanup(); }
});

test("port confirmation writes config, starts ready backend, reloads window, then repairs the frozen MCP plan once", async () => {
  const f = await fixture();
  try {
    const install = await f.service.planIntegrations({ selections: [{ agent: "codex", items: ["mcp"] }, { agent: "claude", items: ["mcp"] }] }); await f.service.applyIntegrations(install.planId);
    const before = await f.config();
    await f.service.savePort(18889); assert.deepEqual(await f.config(), before); assert.deepEqual(f.calls, []);
    const plan = await f.service.planPortChange(true);
    assert.equal(plan.integration?.items.length, 2);
    for (const item of plan.integration!.items) { assert.match(item.operations[0]!.diff, /18888/); assert.match(item.operations[0]!.diff, /18889/); }
    const run = f.env.run;
    f.env.run = async input => { if (input.args[1] === "add") { assert.equal((await f.config()).port, 18889); assert.equal(f.calls.at(-1), "load:18889"); } return run(input); };
    const result = await f.service.applyPortChange(plan.planId);
    assert.equal(result.status, "success"); assert.deepEqual(result.integration?.items.map(item => item.status), ["success", "success"]);
    assert.equal(result.mcpPending, false);
    assert.deepEqual(f.calls, ["stop", "start:18889", "load:18889"]);
    assert.equal((await f.config()).port, 18889); assert.equal((await f.service.getLocalSettings()).pendingPort, null);
    await assert.rejects(f.service.applyPortChange(plan.planId), /失效/);
  } finally { await f.cleanup(); }
});

test("occupied port preserves old service; new backend startup failure restores config and old service without MCP writes", async () => {
  for (const failure of ["occupied", "startup"] as const) {
    const f = await fixture();
    try {
      const install = await f.service.planIntegrations({ agent: "codex", items: ["mcp"] }); await f.service.applyIntegrations(install.planId);
      const old = await f.config(); await f.service.savePort(18889); const plan = await f.service.planPortChange(true);
      f.commands.length = 0;
      if (failure === "occupied") {
        f.service.dependencies.portAvailable = async () => false;
        await assert.rejects(f.service.applyPortChange(plan.planId), /已被占用/); assert.deepEqual(f.calls, []);
      } else {
        f.service.dependencies.startBackend = async config => { f.calls.push(`start:${config.port}`); if (config.port === 18889) throw new Error("fixture startup failed"); };
        const result = await f.service.applyPortChange(plan.planId);
        assert.equal(result.status, "rolled-back"); assert.match(result.reason!, /fixture startup failed/);
        assert.deepEqual(f.calls, ["stop", "start:18889", "stop", "start:18888", "load:18888"]);
      }
      assert.deepEqual(await f.config(), old); assert.ok(f.commands.every(input => input.args[1] === "get"));
    } finally { await f.cleanup(); }
  }
});

test("MCP failure is partial after port success, and external config changes reject a preview before restarting", async () => {
  const f = await fixture();
  try {
    const install = await f.service.planIntegrations({ selections: [{ agent: "codex", items: ["mcp"] }, { agent: "claude", items: ["mcp"] }] }); await f.service.applyIntegrations(install.planId);
    await f.service.savePort(18889); let plan = await f.service.planPortChange(true);
    await writeAppConfig(f.env.userData, { ...await f.config(), ai: { defaultProvider: "claude" } });
    await assert.rejects(f.service.applyPortChange(plan.planId), /配置已变化/); assert.deepEqual(f.calls, []);
    plan = await f.service.planPortChange(true); f.setFailAdd("claude");
    const result = await f.service.applyPortChange(plan.planId);
    assert.equal(result.status, "success"); assert.equal((await f.config()).port, 18889);
    assert.deepEqual(result.integration?.items.map(item => item.status), ["success", "failed"]);
    assert.equal((await f.service.getIntegrationStatus({}))[1]!.items[0]!.configuration, "repair");
    assert.ok(!f.calls.includes("start:18888"));
  } finally { await f.cleanup(); }
});

test("diagnostics exports bounded safe logs and metadata as private JSON, excluding content, prompts and arbitrary errors", async () => {
  const f = await fixture();
  try {
    const config = await f.config(), paths = dataPaths(config.dataDirectory), marker = "SECRET_KNOWLEDGE_CANDIDATE_PROMPT_AI_OUTPUT";
    await mkdir(join(config.dataDirectory, "logs"), { recursive: true }); await mkdir(join(f.env.userData, "logs"), { recursive: true });
    await writeFile(join(paths.assetRepositoryPath, "assets/body.md"), marker); await writeFile(join(paths.assetRepositoryPath, "inbox/body.md"), marker);
    await writeFile(paths.logPath, JSON.stringify({ event: "HOOK_CONTEXT_UNAVAILABLE", errorMessage: marker, stack: marker }));
    const build = await readBuildInfo(f.runtime);
    const safe = { event: "backend-ready", at: "2026-09-24T00:00:00.000Z", startedAt: "2026-09-24T00:00:00.000Z", mainPid: 1, buildId: build.buildId };
    await writeFile(paths.desktopLogPath, [...Array.from({ length: 230 }, () => JSON.stringify(safe)), JSON.stringify({ ...safe, text: marker }), JSON.stringify({ ...safe, event: "stderr", text: marker }), marker].join("\n"));
    await writeFile(join(f.env.userData, "logs/hook.log"), `2026-09-24T00:00:00.000Z HOOK_UNAVAILABLE\n2026-09-24T00:00:00.000Z ${marker}\n`);
    const statuses = await f.service.getIntegrationStatus({}); statuses[0]!.items[0]!.reasons = [marker]; statuses[0]!.detection!.reason = marker;
    statuses[0]!.items[0]!.evidence.installedAt = marker;
    const target = join(f.root, "diagnostics.json");
    await exportDiagnostics(target, { version: "test", build, config, userData: f.env.userData, statuses, backend: { serviceReady: true, mcpReady: true } });
    const text = await readFile(target, "utf8"), value = JSON.parse(text);
    assert.doesNotMatch(text, new RegExp(marker)); assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(value.appConfig, config); assert.equal(value.logs.server.entries.length, 0);
    assert.ok(value.logs.desktop.entries.length <= 200); assert.ok(value.logs.desktop.entries.length > 0);
    assert.equal(value.logs.hook.entries.length, 1); assert.equal(value.logs.desktop.excludedLines, 3);
  } finally { await f.cleanup(); }
});
