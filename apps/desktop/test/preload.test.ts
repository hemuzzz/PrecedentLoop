import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { SetupBridge } from "../src/setup-contract.js";

test("sandbox preload exposes only fixed functions, strips IPC events and removes subscriptions", async () => {
  const source = await readFile(new URL("../src/preload.cts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { fileName: "preload.cts", compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 } });
  let exposed: SetupBridge | undefined;
  const requests: Array<{ channel: string; args: unknown }> = [];
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  runInNewContext(compiled.outputText, { exports: {}, require: (name: string) => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (namespace: string, value: SetupBridge) => { assert.equal(namespace, "precedentSetup"); exposed = value; } },
      ipcRenderer: {
        invoke: async (channel: string, args: unknown) => { requests.push({ channel, args }); },
        on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener); },
        removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); },
      } };
  } });
  assert.ok(exposed);
  assert.ok(Object.values(exposed).every(value => typeof value === "function"));
  assert.equal("ipcRenderer" in exposed, false);
  await exposed.getState();
  await exposed.checkDirectory({ path: "/isolated/data" });
  await exposed.selectExecutable({ agent: "codex" });
  await exposed.resetInvalidConfig();
  assert.deepEqual(requests.map(item => item.channel), ["setup:getState", "setup:checkDirectory", "setup:selectExecutable", "setup:resetInvalidConfig"]);
  assert.equal(JSON.stringify(requests.at(-1)?.args), "{}");
  await exposed.getSettings();
  await exposed.saveAgentPath({ agent: "claude", path: "/isolated/claude" });
  await exposed.saveAgentPath({ agent: "claude", path: null });
  await exposed.detectAgents({ agent: "claude" });
  await exposed.getAppInfo();
  await exposed.checkForUpdates();
  assert.deepEqual(requests.slice(-6).map(item => item.channel), ["setup:getSettings", "setup:saveAgentPath", "setup:saveAgentPath", "setup:detectAgents", "setup:getAppInfo", "setup:checkForUpdates"]);
  assert.equal(JSON.stringify(requests.at(-3)?.args), '{"agent":"claude"}');
  await exposed.getLocalSettings(); await exposed.revealSettingsPath({ target: "workspaces" });
  await exposed.listAiModels(); await exposed.saveAiSettings({ ai: {} }); await exposed.savePort({ port: 18889 });
  await exposed.planPortChange({ repairMcp: true }); await exposed.applyPortChange({ planId: "main-process-port-plan" });
  await exposed.restoreDefaults(); await exposed.exportDiagnostics();
  assert.deepEqual(requests.slice(-9).map(item => item.channel), ["setup:getLocalSettings", "setup:revealSettingsPath", "setup:listAiModels", "setup:saveAiSettings", "setup:savePort", "setup:planPortChange", "setup:applyPortChange", "setup:restoreDefaults", "setup:exportDiagnostics"]);
  await exposed.getIntegrationStatus({});
  await exposed.planIntegrations({ agent: "codex", items: ["mcp"] });
  await exposed.applyIntegrations({ planId: "main-process-plan" });
  await exposed.planIntegrationRemoval({ agent: "all", items: ["mcp"] });
  await exposed.listCodexProjects();
  await exposed.planWorkspaceImport({ listId: "main-process-list", candidateIds: ["selected-id"] });
  await exposed.importWorkspaces({ planId: "main-process-plan" });
  assert.deepEqual(requests.slice(-7).map(item => item.channel), ["setup:getIntegrationStatus", "setup:planIntegrations", "setup:applyIntegrations", "setup:planIntegrationRemoval", "setup:listCodexProjects", "setup:planWorkspaceImport", "setup:importWorkspaces"]);
  let received: unknown;
  const unsubscribe = exposed.onProgress(value => { received = value; });
  const progress = { step: "storage", status: "done" };
  listeners.get("setup:progress")!({ sender: "privileged IPC event" }, progress);
  assert.equal(received, progress);
  unsubscribe(); assert.equal(listeners.size, 0);
  const unsubscribeIntegration = exposed.onIntegrationProgress(value => { received = value; });
  const integrationProgress = { planId: "confirmed-plan", agent: "codex", item: "mcp", status: "running", reason: null };
  listeners.get("setup:integration-progress")!({ sender: "privileged IPC event" }, integrationProgress);
  assert.equal(received, integrationProgress);
  unsubscribeIntegration(); assert.equal(listeners.size, 0);
  assert.equal(typeof exposed.onOpenInbox, "function");
  let inboxArguments: unknown[] | undefined;
  const unsubscribeInbox = exposed.onOpenInbox!((...args) => { inboxArguments = args; });
  listeners.get("hub:open-inbox")!({ sender: "privileged IPC event" }, { ignored: true });
  assert.equal(inboxArguments?.length, 0);
  unsubscribeInbox(); assert.equal(listeners.size, 0);
});
