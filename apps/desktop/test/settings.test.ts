import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { appConfigSchema, readAppConfig, writeAppConfig } from "../src/config.js";
import { createSetupDispatcher, isAllowedCaller, settingsMethods, setupMethods, setupRequestSchemas, type SetupCaller, type SetupMethod } from "../src/setup-ipc.js";
import { SetupService } from "../src/setup-service.js";
import { emptySetupState, writeSetupState } from "../src/setup-state.js";
import { integrationFixture } from "./integration-fixture.js";
import { fixtureProduct, fixtureRuntime } from "./setup-fixture.js";

test("Hub dispatcher uses exact running origin, main window/frame and an explicit method allowlist", async () => {
  const setupFile = "/isolated/App/runtime/setup.html";
  let origin: string | null = "http://127.0.0.1:18888", effects = 0;
  const effect = async () => { effects++; return "ok"; };
  const service = { detectAgents: effect, saveAgentPath: effect, getSettings: effect, getIntegrationStatus: effect,
    planIntegrations: effect, applyIntegrations: effect, planIntegrationRemoval: effect, rememberExecutable: () => {},
    listAiModels: effect, saveAiSettings: effect, savePort: effect, planPortChange: effect, applyPortChange: effect, restoreDefaults: effect,
    listCodexProjects: effect, planWorkspaceImport: effect, importWorkspaces: effect, applyDataMove: effect,
    getLocalSettings: async () => { effects++; return { dataDirectory: "/tmp/data", paths: { workspaceConfigPath: "/tmp/workspaces.json" } }; } } as unknown as SetupService;
  const dispatch = createSetupDispatcher(setupFile, service, { selectDirectory: async () => { effects++; return null; }, selectExecutable: async () => { effects++; return null; },
    openLogs: async () => { await effect(); }, quit: () => {}, getAppInfo: () => { effects++; return { version: "test" }; }, checkForUpdates: async () => { await effect(); },
    revealPath: async () => {}, selectDiagnosticDestination: async () => { effects++; return null; } }, () => origin);
  const caller: SetupCaller = { url: `${origin}/#/settings/codex`, mainWindow: true, mainFrame: true };
  const requests: Partial<Record<SetupMethod, unknown>> = { selectExecutable: { agent: "codex" }, saveAgentPath: { agent: "codex", path: null },
    planIntegrations: { agent: "codex", items: ["mcp"] }, planIntegrationRemoval: { agent: "all", items: ["mcp"] },
    applyIntegrations: { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4" }, revealSettingsPath: { target: "data" }, saveAiSettings: { ai: {} }, savePort: { port: 18889 }, planPortChange: { repairMcp: true },
    applyPortChange: { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4" }, importWorkspaces: { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4" },
    planWorkspaceImport: { listId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4", candidateIds: ["c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4"] },
    planDataMove: { mode: "migrate" }, applyDataMove: { planId: "c8d7e5ef-a3d6-4b87-928e-f9a070afdbb4", syncRiskConfirmed: false } };
  assert.deepEqual(settingsMethods, ["detectAgents", "selectExecutable", "saveAgentPath", "getSettings", "getIntegrationStatus", "planIntegrations", "applyIntegrations", "planIntegrationRemoval", "openLogs", "getAppInfo", "checkForUpdates",
    "getLocalSettings", "revealSettingsPath", "listAiModels", "saveAiSettings", "savePort", "planPortChange", "applyPortChange", "restoreDefaults", "exportDiagnostics", "listCodexProjects", "planWorkspaceImport", "importWorkspaces", "planDataMove", "applyDataMove"]);
  for (const method of settingsMethods) await dispatch(method, caller, requests[method] ?? {});
  assert.equal(effects, settingsMethods.length);
  for (const method of Object.keys(setupRequestSchemas) as SetupMethod[]) if (!settingsMethods.includes(method)) {
    await assert.rejects(dispatch(method, caller, {}), /SETUP_CALLER_REJECTED/, method);
  }
  for (const method of settingsMethods) {
    await assert.rejects(dispatch(method, caller, { unexpected: true }), /SETUP_INVALID_ARGUMENT/, method);
    for (const invalid of [
      { ...caller, mainFrame: false }, { ...caller, mainWindow: false },
      ...["http://127.0.0.1:18889/", "http://localhost:18888/", "https://127.0.0.1:18888/", "https://example.com/",
        "http://127.0.0.1:18888/api/", "http://127.0.0.1:18888/index.html", "http://127.0.0.1:18888/?source=foreign",
        "http://user@127.0.0.1:18888/", "about:blank"].map(url => ({ ...caller, url })),
    ]) await assert.rejects(dispatch(method, invalid, requests[method] ?? {}), /SETUP_CALLER_REJECTED/);
  }
  await assert.rejects(dispatch("getIntegrationStatus", caller, { choices: { codex: { mcp: "enabled" } } }), /SETUP_INVALID_ARGUMENT/);
  for (const path of ["relative", "", "/tmp/\0bad"]) await assert.rejects(dispatch("saveAgentPath", caller, { agent: "codex", path }), /SETUP_INVALID_ARGUMENT/);
  origin = null;
  for (const method of settingsMethods) await assert.rejects(dispatch(method, caller, requests[method] ?? {}), /SETUP_CALLER_REJECTED/);
  assert.equal(effects, settingsMethods.length);
  const packaged = { ...caller, url: `${pathToFileURL(setupFile).href}?mode=RECOVERY` };
  for (const method of setupMethods) {
    assert.equal(isAllowedCaller(method, packaged, setupFile, null), true);
    assert.equal(isAllowedCaller(method, { ...packaged, mainFrame: false }, setupFile, null), false);
    assert.equal(isAllowedCaller(method, { ...packaged, mainWindow: false }, setupFile, null), false);
  }
  // The event sender uses the same predicate as apply dispatch, including service shutdown.
  assert.equal(isAllowedCaller("applyIntegrations", caller, setupFile, null), false);
  assert.equal(isAllowedCaller("applyIntegrations", packaged, setupFile, null), true);
  origin = "http://127.0.0.1:18889";
  for (const method of settingsMethods) {
    await assert.rejects(dispatch(method, caller, requests[method] ?? {}), /SETUP_CALLER_REJECTED/);
    await dispatch(method, { ...caller, url: `${origin}/#/settings/advanced` }, requests[method] ?? {});
  }
});

test("legacy app-config reads with no expectations or overrides; complete persists the exact draft choices", async () => {
  const f = await integrationFixture();
  try {
    await fixtureProduct(f.config.dataDirectory);
    const config = appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: false, ...f.config });
    await writeAppConfig(f.env.userData, config);
    const old = await readAppConfig(f.env.userData);
    assert.ok(old.kind === "VALID"); assert.equal(old.config.agents, undefined); assert.equal(old.config.manualPaths, undefined); assert.equal(old.config.integrationChoices, undefined);
    const draft = { ...emptySetupState(f.config.dataDirectory), step: 4 as const, agents: { codex: true, claude: false },
      manualPaths: { codex: join(f.root, "manual/codex"), claude: null },
      integrationChoices: { codex: { mcp: "enabled" as const, skills: "skipped" as const, projectContext: "undecided" as const } } };
    await writeSetupState(f.env.userData, draft);
    const service = new SetupService({ userData: f.env.userData, home: f.env.home, runtime: await fixtureRuntime(f.root),
      startBackend: async () => {}, stopBackend: async () => {}, backendStatus: async () => ({ serviceReady: true, mcpReady: true }),
      verifyRuntime: async () => "fixture Node", changeMode: async () => {}, progress: () => {} });
    await service.initialize(); await service.complete();
    const saved = await readAppConfig(f.env.userData);
    assert.ok(saved.kind === "VALID"); assert.equal(saved.config.configVersion, 1);
    assert.deepEqual(saved.config.agents, draft.agents); assert.deepEqual(saved.config.manualPaths, { codex: draft.manualPaths.codex });
    assert.deepEqual(saved.config.integrationChoices, { codex: { mcp: "enabled", projectContext: "undecided" } });
  } finally { await f.cleanup(); }
});

test("Settings detects persistent paths, restores automatic detection and saves successful install/removal expectations", async () => {
  const f = await integrationFixture();
  try {
    await fixtureProduct(f.config.dataDirectory);
    await writeAppConfig(f.env.userData, appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: true, ...f.config }));
    const stale = { ...emptySetupState(f.config.dataDirectory), manualPaths: { codex: "/unused/stale-codex", claude: null } };
    await writeSetupState(f.env.userData, stale);
    const originalDraft = await readFile(join(f.env.userData, "setup-state.json"));
    const detected: Array<{ agent: string; path: string | null }> = [];
    const service = new SetupService({ userData: f.env.userData, home: f.env.home, runtime: await fixtureRuntime(f.root), integrations: f.env,
      startBackend: async () => {}, stopBackend: async () => {}, backendStatus: async () => ({ serviceReady: true, mcpReady: true }),
      verifyRuntime: async () => "fixture Node", changeMode: async () => {}, progress: () => {}, detect: async (agent, path) => {
        detected.push({ agent, path });
        return { agent, source: path ? "manual" : "auto", path: path ?? join(f.root, "auto", agent), found: true, runnable: true,
          version: "1.2.3", login: "unverified", checkedAt: "2026-09-24T00:00:00.000Z" };
      } });
    await service.initialize();
    assert.deepEqual(await service.getSettings(), { agents: {}, manualPaths: {}, integrationChoices: {}, port: 18888, setupCompleted: true });
    const legacy = await service.getIntegrationStatus({ choices: { codex: { mcp: "enabled" } } });
    assert.equal(legacy[0]!.items[0]!.choice, "undecided"); assert.equal(detected[0]!.path, null);
    const manual = join(f.root, "manual", "codex");
    service.rememberExecutable("codex", manual);
    assert.equal((await service.saveAgentPath({ agent: "codex", path: manual })).find(value => value.agent === "codex")?.source, "manual");
    assert.equal((await service.getSettings()).manualPaths.codex, manual);
    const plan = await service.planIntegrations({ selections: [{ agent: "codex", items: ["mcp"] }, { agent: "claude", items: ["mcp"] }] });
    assert.equal(plan.items[0]!.operations[0]!.commands[0]![0], manual);
    f.setFailAdd("claude");
    const result = await service.applyIntegrations(plan.planId);
    assert.deepEqual(result.items.map(item => item.status), ["success", "failed"]);
    assert.deepEqual((await service.getSettings()).integrationChoices, { codex: { mcp: "enabled" } });
    assert.equal((await service.getSettings()).agents.codex, true);
    f.setFailAdd(null);
    // Items are mandatory: Settings removes a connected Agent as a whole.
    await assert.rejects(service.planIntegrationRemoval({ agent: "codex", items: ["mcp"] }), /整体移除/);
    const removed = await service.planIntegrationRemoval({ agent: "codex", items: ["mcp", "projectContext", "captureReminder"] });
    assert.equal((await service.applyIntegrations(removed.planId)).items.find(item => item.item === "mcp")!.status, "success");
    assert.equal((await service.getSettings()).integrationChoices.codex?.mcp, "skipped");
    await service.saveAgentPath({ agent: "codex", path: null });
    assert.equal((await service.getSettings()).manualPaths.codex, undefined); assert.deepEqual(detected.at(-1), { agent: "codex", path: null });
    const autoPlan = await service.planIntegrations({ agent: "codex", items: ["mcp"] });
    assert.equal(autoPlan.items[0]!.operations[0]!.commands[0]![0], join(f.root, "auto/codex"));
    service.rememberExecutable("codex", manual);
    await service.saveAgentPath({ agent: "codex", path: manual });
    await assert.rejects(service.applyIntegrations(autoPlan.planId), /外部配置已变化/);
    assert.deepEqual(await readFile(join(f.env.userData, "setup-state.json")), originalDraft);
    // Renderer requests and obsolete Setup choices never override persisted expectations.
    assert.equal((await service.getIntegrationStatus({ choices: { codex: { mcp: "enabled" } } }))[0]!.items[0]!.choice, "skipped");
  } finally { await f.cleanup(); }
});

test("M2 preserves only sanitized external context without add/remove lines, commands or backups", async () => {
  const f = await integrationFixture();
  try {
    const entry = { type: "http", url: "https://user:password@example.com/mcp?token=secret#private", headers: { Authorization: "hidden-header" }, env: { TOKEN: "hidden-env" }, args: ["hidden-argument"] };
    await writeFile(f.env.claudeConfig, JSON.stringify({ mcpServers: { "precedent": entry } }));
    const before = await readFile(f.env.claudeConfig);
    const plan = await f.engine.plan({ agent: "claude", items: ["mcp"] });
    const operation = plan.items[0]!.operations[0]!;
    assert.equal(operation.action, "none"); assert.deepEqual(operation.commands, []); assert.equal(operation.backup, null);
    assert.match(operation.diff, /^--- .+\n\+\+\+ .+\n/u); assert.match(operation.diff, /https:\/\/example.com\/mcp/u);
    assert.doesNotMatch(operation.diff, /user:|password|token=secret|#private|hidden-header|hidden-env|hidden-argument/u);
    assert.ok(operation.diff.split("\n").slice(2).every(line => !/^[+-]/u.test(line)));
    assert.equal((await f.engine.apply(plan.planId)).items[0]!.status, "preserved");
    assert.deepEqual(await readFile(f.env.claudeConfig), before);
    assert.ok(f.commands.every(command => command.args[1] === "get"));
    const replacement = await f.engine.plan({ agent: "claude", items: ["mcp"], conflicts: { mcp: "replace" } });
    const diff = replacement.items[0]!.operations[0]!.diff;
    assert.match(diff, /\n-\{\n/u); assert.match(diff, /\n-\}\n\+\{\n/u); assert.match(diff, /\n\+\}/u);
    assert.match(diff, /-.*headers/u); assert.match(diff, /\+.*127\.0\.0\.1:18888\/mcp/u);
    assert.doesNotMatch(diff, /password|hidden-header|hidden-env|hidden-argument/u);
  } finally { await f.cleanup(); }
});

test("remove-all modified choices stay independent per Agent and the default preserves modified resources", async () => {
  const f = await integrationFixture();
  try {
    const install = await f.engine.plan({ selections: [{ agent: "codex", items: ["projectContext"] }, { agent: "claude", items: ["projectContext"] }] });
    await f.engine.apply(install.planId);
    const codex = join(f.env.codexHome, "hooks.json"), claude = join(f.env.claudeDirectory, "settings.json");
    const modify = async (path: string) => { const doc = JSON.parse(await readFile(path, "utf8")); doc.hooks.UserPromptSubmit[0].hooks[0].command += " user modification"; await writeFile(path, JSON.stringify(doc)); };
    await modify(codex); await modify(claude);
    const claudeBefore = await readFile(claude, "utf8");
    const preserve = await f.engine.planRemoval({ agent: "all", items: ["projectContext"] });
    assert.ok(preserve.items.flatMap(item => item.operations).filter(operation => operation.conflict === "modified").every(operation => operation.action === "none"));
    const plan = await f.engine.planRemoval({ agent: "all", items: ["projectContext"], removeModifiedByAgent: { codex: ["projectContext"] } });
    assert.equal(plan.items.find(item => item.agent === "codex" && item.item === "projectContext")!.operations.find(operation => operation.conflict === "modified")!.action, "remove");
    assert.equal(plan.items.find(item => item.agent === "claude" && item.item === "projectContext")!.operations.find(operation => operation.conflict === "modified")!.action, "none");
    await f.engine.apply(plan.planId);
    assert.deepEqual(JSON.parse(await readFile(codex, "utf8")).hooks, {}); assert.equal(await readFile(claude, "utf8"), claudeBefore);
  } finally { await f.cleanup(); }
});
