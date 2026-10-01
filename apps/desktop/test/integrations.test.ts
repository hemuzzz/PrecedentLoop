import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { integrationItems, type IntegrationProgress } from "../src/integrations/contract.js";
import { desiredHook, hookPath, launcherPath, parseTrust } from "../src/integrations/adapters.js";
import { readLedger } from "../src/integrations/ledger.js";
import { appConfigSchema } from "../src/config.js";
import { integrationStatus } from "../src/integrations/status.js";
import { executeMcpCommand, integrationEnvironment, runMcp } from "../src/integrations/environment.js";
import { integrationFixture } from "./integration-fixture.js";

test("legacy choices and ledger artifacts are ignored without cleanup on read or active updates", async () => {
  const f = await integrationFixture();
  try {
    const config = appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: false, ...f.config, integrationChoices: { codex: { skills: "legacy-value", mcp: "enabled" } } });
    assert.deepEqual(config.integrationChoices, { codex: { mcp: "enabled" } });
    const target = join(f.env.codexHome, "skills/memory-recall/SKILL.md");
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, "old installation");
    const artifact = { target, kind: "directory", hash: "old", owners: ["codex:skills"], installedAt: "2026-09-01", backups: [], trust: null };
    const old = { version: 1, artifacts: { "codex:skill:memory-recall": artifact, "codex:protocol": { ...artifact, kind: "file" }, "codex:reference:README.md": { ...artifact, kind: "file" } }, failures: { "codex:skills": { at: "2026-09-01", reason: "old failure" } } };
    const path = join(f.env.userData, "integrations.json"); await writeFile(path, JSON.stringify(old));
    assert.deepEqual(await readLedger(f.env.userData), { version: 1, artifacts: {}, failures: {} });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
    await f.engine.apply((await f.engine.plan({ agent: "codex", items: ["projectContext"] })).planId);
    const saved = JSON.parse(await readFile(path, "utf8"));
    for (const [id, value] of Object.entries(old.artifacts)) assert.deepEqual(saved.artifacts[id], value);
    assert.deepEqual(saved.failures["codex:skills"], old.failures["codex:skills"]);
    assert.equal(await readFile(target, "utf8"), "old installation");
    assert.ok((await readLedger(f.env.userData)).artifacts["codex:hooks:projectContext"]);
  } finally { await f.cleanup(); }
});

test("one confirmed plan applies both Agents with ordered per-item progress and shared ownership", async () => {
  const f = await integrationFixture();
  try {
    const plan = await f.engine.plan({ selections: ["codex", "claude"].map(agent => ({ agent: agent as "codex" | "claude", items: [...integrationItems] })) });
    assert.equal(plan.items.length, 6);
    const updates: IntegrationProgress[] = [];
    const result = await f.engine.apply(plan.planId, progress => { updates.push(progress); });
    assert.ok(result.items.every(item => item.status === "success"));
    assert.equal(updates.length, 12);
    for (const [index, item] of result.items.entries()) {
      assert.deepEqual(updates[index * 2], { planId: plan.planId, agent: item.agent, item: item.item, status: "running", reason: null });
      assert.deepEqual(updates[index * 2 + 1], { planId: plan.planId, agent: item.agent, item: item.item, status: "success", reason: null });
    }
    const launcher = (await readLedger(f.env.userData)).artifacts.launcher!;
    assert.deepEqual(launcher.owners.sort(), ["claude:captureReminder", "claude:projectContext", "codex:captureReminder", "codex:projectContext"]);
    assert.ok(plan.items.filter(item => item.agent === "claude").flatMap(item => item.operations).filter(operation => operation.target === launcherPath(f.env)).every(operation => operation.action === "none"));
  } finally { await f.cleanup(); }
});

test("changes to either Agent invalidate the entire combined plan before writes or progress", async () => {
  const f = await integrationFixture();
  try {
    const plan = await f.engine.plan({ selections: [{ agent: "codex", items: ["mcp"] }, { agent: "claude", items: ["mcp"] }] });
    await writeFile(f.env.claudeConfig, '{"external":true}');
    const updates: IntegrationProgress[] = [];
    await assert.rejects(f.engine.apply(plan.planId, value => { updates.push(value); }), /外部配置已变化，请重新预览/);
    assert.deepEqual(updates, []);
    assert.ok(f.commands.every(command => command.args[1] === "get"));
    await assert.rejects(readFile(join(f.env.codexHome, "config.toml")), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.env.userData, "integrations.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("combined failures retain other successes, retry only failed items, and ignore observer failures", async () => {
  const f = await integrationFixture();
  try {
    f.setFailAdd("codex");
    const plan = await f.engine.plan({ selections: [{ agent: "codex", items: ["mcp", "projectContext"] }, { agent: "claude", items: ["mcp"] }] });
    const updates: IntegrationProgress[] = [];
    const result = await f.engine.apply(plan.planId, progress => { updates.push(progress); throw new Error("renderer closed"); });
    assert.deepEqual(result.items.map(item => item.status), ["failed", "success", "success"]);
    assert.deepEqual(updates.map(value => value.status), ["running", "failed", "running", "success", "running", "success"]);
    const claudeConfig = await readFile(f.env.claudeConfig);
    f.setFailAdd(null);
    const retry = await f.engine.plan({ selections: [{ agent: "codex", items: ["mcp"] }] });
    assert.equal((await f.engine.apply(retry.planId)).items[0]!.status, "success");
    assert.deepEqual(await readFile(f.env.claudeConfig), claudeConfig);
  } finally { await f.cleanup(); }
});

test("combined conflict choices are scoped to each Agent and replaced previews stay immutable", async () => {
  const f = await integrationFixture();
  try {
    await runMcp(f.env, "codex", ["mcp", "add", "precedent", "--url", "http://127.0.0.1:18000/mcp"]);
    await runMcp(f.env, "claude", ["mcp", "add", "--transport", "http", "--scope", "user", "precedent", "http://127.0.0.1:18000/mcp"]);
    const original = await f.engine.plan({ selections: [{ agent: "codex", items: ["mcp"] }, { agent: "claude", items: ["mcp"] }] });
    assert.ok(original.items.every(item => item.operations[0]!.action === "none"));
    const replacement = await f.engine.plan({ selections: [{ agent: "codex", items: ["mcp"], conflicts: { mcp: "replace" } }, { agent: "claude", items: ["mcp"] }] });
    assert.equal(original.items[0]!.operations[0]!.action, "none");
    assert.equal(replacement.items[0]!.operations[0]!.action, "modify");
    assert.equal(replacement.items[1]!.operations[0]!.action, "none");
    assert.deepEqual((await f.engine.apply(replacement.planId)).items.map(item => item.status), ["success", "preserved"]);
  } finally { await f.cleanup(); }
});

for (const agent of ["codex", "claude"] as const) test(`${agent}: all three items plan/apply/detect/remove, exact resources, ownership, atomic modes and backups`, async () => {
  const f = await integrationFixture();
  try {
    const plan = await f.engine.plan({ agent, items: [...integrationItems] });
    assert.ok(Object.isFrozen(plan)); assert.equal(plan.items.length, 3);
    assert.ok(plan.items.every(item => item.error === null));
    const result = await f.engine.apply(plan.planId);
    assert.deepEqual(result.items.map(item => item.status), ["success", "success", "success"]);
    await assert.rejects(f.engine.apply(plan.planId), /失效/);
    assert.equal((await stat(launcherPath(f.env))).mode & 0o777, 0o755);
    assert.equal((await stat(join(f.env.userData, "integrations.json"))).mode & 0o777, 0o600);
    await promisify(execFile)("/bin/sh", ["-n", launcherPath(f.env)]);
    const launcher = await readFile(launcherPath(f.env), "utf8");
    assert.ok(launcher.includes("App'\\''s"));
    const hooks = JSON.parse(await readFile(hookPath(f.env, agent), "utf8")).hooks;
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"] as const) assert.deepEqual(hooks[event], [desiredHook(f.env, agent, event)]);
    for (const retired of [join(f.env.codexHome, "KNOWLEDGE.md"), join(f.env.userData, "agents"), join(f.env.codexHome, "skills"), join(f.env.claudeDirectory, "skills")]) await assert.rejects(stat(retired), { code: "ENOENT" });
    const state = (await integrationStatus(f.env, f.config, { choices: { [agent]: { mcp: "enabled" } } }, true)).find(value => value.agent === agent)!;
    assert.equal(state.items[0]!.configuration, "configured");
    assert.equal(state.items[1]!.configuration, agent === "codex" ? "pending-trust" : "configured");
    const replay = await f.engine.plan({ agent, items: [...integrationItems] });
    assert.ok(replay.items.flatMap(item => item.operations).every(operation => operation.action === "none"));
    assert.equal((await f.engine.apply(replay.planId)).items.every(item => item.status === "success"), true);
    const removal = await f.engine.planRemoval({ agent, items: [...integrationItems] });
    const launcherRemovals = removal.items.flatMap(item => item.operations).filter(operation => operation.target === launcherPath(f.env) && operation.action === "remove");
    assert.equal(launcherRemovals.length, 1); assert.ok(launcherRemovals[0]!.backup);
    const removed = await f.engine.apply(removal.planId);
    assert.ok(removed.items.every(item => item.status === "success"), JSON.stringify(removed));
    assert.ok(removed.items.some(item => item.backups.length));
    assert.deepEqual((await readLedger(f.env.userData)).artifacts, {});
    await assert.rejects(readFile(launcherPath(f.env)), { code: "ENOENT" });
    await assert.rejects(stat(join(f.env.userData, "agents")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(hookPath(f.env, agent), "utf8")).hooks, {});
    assert.ok((await integrationStatus(f.env, f.config, {}, true)).find(value => value.agent === agent)!.items.every(item => item.configuration === "unconfigured"));
  } finally { await f.cleanup(); }
});

test("conflicts preserve external MCP and retired skill directories; MCP replacement backs up only its original", async () => {
  const f = await integrationFixture();
  try {
    await writeFile(f.env.claudeConfig, JSON.stringify({ account: "keep", mcpServers: { "precedent": { type: "stdio", command: "other", env: { TOKEN: "synthetic-secret" } }, other: { command: "keep" } } }));
    const skill = join(f.env.claudeDirectory, "skills/memory-recall");
    await mkdir(skill, { recursive: true }); await writeFile(join(skill, "custom.txt"), "original");
    const before = await readFile(f.env.claudeConfig);
    const plan = await f.engine.plan({ agent: "claude", items: ["mcp", "projectContext"] });
    assert.equal(plan.items[0]!.operations[0]!.conflict, "external");
    assert.equal(plan.items[0]!.operations[0]!.action, "none");
    await f.engine.apply(plan.planId);
    await assert.rejects(stat(join(f.env.userData, "agents")), { code: "ENOENT" });
    assert.deepEqual(await readFile(f.env.claudeConfig), before);
    assert.equal(await readFile(join(skill, "custom.txt"), "utf8"), "original");
    const replacement = await f.engine.plan({ agent: "claude", items: ["mcp", "projectContext"], conflicts: { mcp: "replace", projectContext: "replace" } });
    assert.match(replacement.items[0]!.operations[0]!.diff, /env/); assert.doesNotMatch(JSON.stringify(replacement), /synthetic-secret/);
    const result = await f.engine.apply(replacement.planId);
    assert.ok(result.items.every(item => item.status === "success"));
    const saved = JSON.parse(await readFile(f.env.claudeConfig, "utf8"));
    assert.equal(saved.account, "keep"); assert.deepEqual(saved.mcpServers.other, { command: "keep" });
    assert.deepEqual(await readFile(result.items[0]!.backups[0]!), before);
    assert.equal(await readFile(join(skill, "custom.txt"), "utf8"), "original");
  } finally { await f.cleanup(); }
});

test("preview fingerprints reject changed files, launcher, ledger, port or launcher inputs before any writes", async () => {
  for (const change of ["json", "launcher", "ledger", "port", "app", "draft"] as const) {
    const f = await integrationFixture();
    try {
      const plan = await f.engine.plan({ agent: "claude", items: [...integrationItems] });
      if (change === "json") await writeFile(hookPath(f.env, "claude"), '{"unrelated":true}');
      if (change === "launcher") { await mkdir(dirname(launcherPath(f.env)), { recursive: true }); await writeFile(launcherPath(f.env), "external launcher"); }
      if (change === "ledger") await writeFile(join(f.env.userData, "integrations.json"), "{}");
      if (change === "port") f.config.port++;
      if (change === "app") f.env.appPath += ".moved";
      if (change === "draft") await writeFile(join(f.env.userData, "setup-state.json"), '{"agents":{"claude":false}}');
      await assert.rejects(f.engine.apply(plan.planId), /外部配置已变化/);
      assert.equal(f.commands.filter(command => command.args[1] !== "get").length, 0);
      await assert.rejects(stat(join(f.env.userData, "backups")), { code: "ENOENT" });
      if (change === "launcher") assert.equal(await readFile(launcherPath(f.env), "utf8"), "external launcher");
      else await assert.rejects(stat(launcherPath(f.env)), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("JSON merges preserve unrelated keys, nested sibling commands and all legacy entries; malformed JSON never rewritten", async () => {
  const f = await integrationFixture();
  try {
    const target = hookPath(f.env, "claude");
    const legacy = { matcher: "legacy", hooks: [{ type: "command", command: "/repo/integrations/codex/capture-hook.sh" }] };
    const original = { env: { retained: "yes" }, hooks: { Stop: [legacy], OtherEvent: [{ hooks: [] }] } };
    await writeFile(target, JSON.stringify(original));
    await f.engine.apply((await f.engine.plan({ agent: "claude", items: ["projectContext", "captureReminder"] })).planId);
    const content = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(content.hooks.Stop[0], legacy); assert.deepEqual(content.env, original.env); assert.deepEqual(content.hooks.OtherEvent, original.hooks.OtherEvent);
    content.hooks.Stop[1].hooks.push({ type: "command", command: "keep sibling" });
    await writeFile(target, JSON.stringify(content));
    await f.engine.apply((await f.engine.planRemoval({ agent: "claude", items: ["captureReminder"], removeModified: ["captureReminder"] })).planId);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")).hooks.Stop, [legacy, { hooks: [{ type: "command", command: "keep sibling" }] }]);
    await writeFile(target, "{broken");
    const plan = await f.engine.plan({ agent: "claude", items: ["captureReminder", "mcp"] });
    assert.match(plan.items.find(item => item.item === "captureReminder")!.error!, /JSON/);
    const result = await f.engine.apply(plan.planId);
    assert.equal(result.items.find(item => item.item === "mcp")!.status, "success");
    assert.equal(result.items.find(item => item.item === "captureReminder")!.status, "failed");
    assert.equal(await readFile(target, "utf8"), "{broken");
  } finally { await f.cleanup(); }
});

test("partial CLI failure preserves backup, continues remaining items and records exact per-item failures", async () => {
  const f = await integrationFixture();
  try {
    f.setFailAdd("codex");
    const result = await f.engine.apply((await f.engine.plan({ agent: "codex", items: [...integrationItems] })).planId);
    assert.deepEqual(result.items.map(item => item.status), ["failed", "success", "success"]);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.ok((await readLedger(f.env.userData)).failures["codex:mcp"]);
    f.setFailAdd(null);
    assert.equal((await f.engine.apply((await f.engine.plan({ agent: "codex", items: ["mcp"] })).planId)).items[0]!.status, "success");
    assert.equal((await readLedger(f.env.userData)).failures["codex:mcp"], undefined);
  } finally { await f.cleanup(); }
});

test("modified launcher needs explicit removal and survives until its last consumer", async () => {
  const f = await integrationFixture();
  try {
    for (const agent of ["codex", "claude"] as const) await f.engine.apply((await f.engine.plan({ agent, items: ["projectContext", "captureReminder"] })).planId);
    const target = launcherPath(f.env); await writeFile(target, "user edit");
    await f.engine.apply((await f.engine.planRemoval({ agent: "codex", items: ["projectContext"] })).planId);
    assert.equal(await readFile(target, "utf8"), "user edit");
    const plan = await f.engine.planRemoval({ agent: "all", items: ["projectContext", "captureReminder"] });
    assert.ok(plan.items.flatMap(item => item.operations).some(operation => operation.target === target && operation.conflict === "modified" && operation.action === "none"));
    await f.engine.apply(plan.planId);
    assert.equal(await readFile(target, "utf8"), "user edit");
    await f.engine.apply((await f.engine.planRemoval({ agent: "all", items: ["projectContext", "captureReminder"], removeModified: ["projectContext", "captureReminder"] })).planId);
    await assert.rejects(readFile(target), { code: "ENOENT" });
    assert.deepEqual((await readLedger(f.env.userData)).artifacts, {});
  } finally { await f.cleanup(); }
});

test("repair detects changed port, deleted Claude MCP, changed hook, and stale launcher including mode", async () => {
  const f = await integrationFixture();
  try {
    await f.engine.apply((await f.engine.plan({ agent: "claude", items: [...integrationItems] })).planId);
    await writeFile(launcherPath(f.env), "modified launcher");
    assert.equal((await integrationStatus(f.env, f.config, {}, true))[1]!.items[1]!.configuration, "repair");
    f.config.port++;
    assert.equal((await integrationStatus(f.env, f.config, {}, true))[1]!.items[0]!.configuration, "repair");
    await writeFile(f.env.claudeConfig, '{"mcpServers":{}}');
    const hooks = JSON.parse(await readFile(hookPath(f.env, "claude"), "utf8")); hooks.hooks.Stop[0].hooks[0].command += " edited";
    await writeFile(hookPath(f.env, "claude"), JSON.stringify(hooks));
    const items = (await integrationStatus(f.env, f.config, {}, true))[1]!.items;
    assert.ok(items.every(item => item.configuration === "repair"));
    await f.engine.apply((await f.engine.plan({ agent: "claude", items: [...integrationItems] })).planId);
    await chmod(launcherPath(f.env), 0o644);
    assert.equal((await integrationStatus(f.env, f.config, {}, true))[1]!.items[1]!.configuration, "repair");
    f.env.appPath += ".updated";
    const repair = await f.engine.plan({ agent: "claude", items: ["projectContext"] });
    assert.equal(repair.items[0]!.operations.find(value => value.target === launcherPath(f.env))!.action, "modify");
    await f.engine.apply(repair.planId);
    assert.equal((await stat(launcherPath(f.env))).mode & 0o777, 0o755);
  } finally { await f.cleanup(); }
});

test("Codex trust snapshots distinguish unchanged, accepted, revoked/moved and unparseable without rewriting trust", async () => {
  const f = await integrationFixture();
  try {
    const configPath = join(f.env.codexHome, "config.toml"), key = `${hookPath(f.env, "codex")}:user_prompt_submit:0:0`;
    const trust = (value: string) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:${value}"\n`;
    await writeFile(configPath, trust("aaa"));
    await f.engine.apply((await f.engine.plan({ agent: "codex", items: ["projectContext"] })).planId);
    const inspect = async () => (await integrationStatus(f.env, f.config, {}, true))[0]!.items[1]!;
    assert.equal((await inspect()).evidence.trust, "pending");
    assert.equal(await readFile(configPath, "utf8"), trust("aaa"));
    await writeFile(configPath, trust("bbb"));
    assert.equal((await inspect()).evidence.trust, "trusted");
    assert.equal((await inspect()).evidence.trust, "trusted");
    await writeFile(configPath, trust("ccc"));
    assert.equal((await inspect()).evidence.trust, "pending");
    await writeFile(configPath, ""); assert.equal((await inspect()).evidence.trust, "pending");
    await writeFile(configPath, trust("ddd")); assert.equal((await inspect()).evidence.trust, "trusted");
    const doc = JSON.parse(await readFile(hookPath(f.env, "codex"), "utf8"));
    doc.hooks.UserPromptSubmit.unshift({ hooks: [{ type: "command", command: "external" }] });
    await writeFile(hookPath(f.env, "codex"), JSON.stringify(doc));
    assert.equal((await inspect()).evidence.trust, "pending");
    await writeFile(configPath, '[hooks.state."unknown"]\ntrusted_hash = ["changed format"]');
    assert.equal((await inspect()).evidence.trust, "unverified");
    assert.deepEqual(parseTrust(null), {}); assert.equal(parseTrust("[hooks.state]\na = {}"), null);
  } finally { await f.cleanup(); }
});

test("Claude disable and managed policy, time evidence, unknown MCP attribution and service waiting stay distinct", async () => {
  const f = await integrationFixture();
  try {
    await f.engine.apply((await f.engine.plan({ agent: "claude", items: [...integrationItems] })).planId);
    const target = hookPath(f.env, "claude"), doc = JSON.parse(await readFile(target, "utf8"));
    doc.disableAllHooks = true; await writeFile(target, JSON.stringify(doc));
    assert.equal((await integrationStatus(f.env, f.config, {}, true))[1]!.items[1]!.label, "待处理");
    await mkdir(dirname(f.env.managedSettings)); await writeFile(f.env.managedSettings, '{"allowManagedHooksOnly":true}');
    assert.equal((await integrationStatus(f.env, f.config, {}, true))[1]!.items[1]!.label, "被策略禁用");
    await writeFile(f.env.managedSettings, "{}"); delete doc.disableAllHooks; await writeFile(target, JSON.stringify(doc));
    const activity = join(f.config.dataDirectory, "runtime/integration-activity"); await mkdir(activity, { recursive: true });
    const at = "2026-09-24T05:00:00.000Z";
    await writeFile(join(activity, "hook-claude-user-prompt-submit.json"), JSON.stringify({ at }));
    await writeFile(join(activity, "mcp-unknown.json"), JSON.stringify({ at }));
    let state = (await integrationStatus(f.env, f.config, {}, true))[1]!;
    assert.equal(state.items[1]!.verification, "verified"); assert.equal(state.items[0]!.verification, "unverified");
    f.env.mcpClientNames.claude = ["fixture-observed-client"];
    await writeFile(join(activity, "mcp-fixture-observed-client.json"), JSON.stringify({ at }));
    state = (await integrationStatus(f.env, f.config, {}, true))[1]!;
    assert.equal(state.items[0]!.evidence.lastConnected, at); assert.equal(state.items[0]!.verification, "verified");
    state = (await integrationStatus(f.env, f.config, {}, false))[1]!;
    assert.equal(state.items[0]!.label, "等待服务"); assert.equal(state.items[0]!.verification, "unverified");
    assert.equal(state.items[1]!.label, "正常"); assert.equal(state.items[1]!.verification, "verified");
    assert.equal(state.items[1]!.evidence.lastTriggered, at);
    assert.equal(state.items[2]!.label, "已配置，未验证");
    assert.ok(state.items.slice(1).every(item => !item.reasons.some(reason => reason.includes("等待服务"))));
    await writeFile(join(activity, "hook-claude-post-tool-use.json"), JSON.stringify({ at }));
    state = (await integrationStatus(f.env, f.config, {}, false))[1]!;
    assert.equal(state.items[2]!.verification, "unverified", "one reminder event is insufficient");
    await writeFile(join(activity, "hook-claude-stop.json"), JSON.stringify({ at }));
    state = (await integrationStatus(f.env, f.config, { choices: { claude: { mcp: "enabled", projectContext: "enabled", captureReminder: "enabled" } } }, false))[1]!;
    assert.equal(state.items[2]!.label, "正常"); assert.equal(state.items[2]!.verification, "verified");
    assert.equal(state.label, "等待服务", "the Agent summary still includes server-dependent MCP verification");
    doc.disableAllHooks = true; await writeFile(target, JSON.stringify(doc));
    state = (await integrationStatus(f.env, f.config, {}, false))[1]!;
    assert.ok(state.items.slice(1).every(item => item.label === "待处理" && item.verification === "unverified"));
    await writeFile(f.env.managedSettings, '{"allowManagedHooksOnly":true}');
    state = (await integrationStatus(f.env, f.config, {}, false))[1]!;
    assert.ok(state.items.slice(1).every(item => item.label === "被策略禁用" && item.verification === "unverified"));
  } finally { await f.cleanup(); }
});

test("CLI allowlist and symlink isolation reject unsupported operations without touching targets", async () => {
  const f = await integrationFixture();
  try {
    for (const args of [["exec"], ["mcp", "list"], ["mcp", "remove", "other"], ["mcp", "add", "precedent", "--url", "https://other"]]) await assert.rejects(runMcp(f.env, "codex", args), /不允许/);
    await assert.rejects(runMcp(f.env, "claude", ["mcp", "get", "precedent"]), /不允许/);
    const protectedPath = join(f.root, "protected"); await writeFile(protectedPath, "unchanged");
    await symlink(protectedPath, hookPath(f.env, "claude"));
    const plan = await f.engine.plan({ agent: "claude", items: ["captureReminder"] });
    assert.ok(plan.items[0]!.error);
    assert.equal((await f.engine.apply(plan.planId)).items[0]!.status, "failed");
    assert.equal(await readFile(protectedPath, "utf8"), "unchanged");
  } finally { await f.cleanup(); }
});

test("CLI execution terminates a timed-out process group and never inherits the shell", async () => {
  const f = await integrationFixture();
  try {
    const executable = join(f.root, "fake-cli");
    await writeFile(executable, '#!/bin/sh\n/bin/sleep 30 &\nwait\n', { mode: 0o700 });
    const start = performance.now();
    const result = await executeMcpCommand({ executable, args: ["mcp", "get"], cwd: f.env.home, env: { HOME: f.env.home, PATH: "/usr/bin:/bin" }, timeout: 100 });
    assert.equal(result.code, null); assert.ok(performance.now() - start < 2000);
  } finally { await f.cleanup(); }
});

test("observed MCP client names attribute each connection to its own Agent only", async () => {
  const f = await integrationFixture();
  try {
    const names = integrationEnvironment({ userData: f.env.userData, appPath: f.env.appPath, resources: f.env.resources }).mcpClientNames;
    assert.deepEqual(names, { codex: ["codex-mcp-client"], claude: ["claude-code"] });
    const activity = join(f.config.dataDirectory, "runtime/integration-activity");
    await mkdir(activity, { recursive: true });
    await writeFile(join(activity, "mcp-codex-mcp-client.json"), JSON.stringify({ at: "2026-09-24T16:41:15.683Z", name: "codex-mcp-client" }));
    const mcp = async (agent: string) => (await integrationStatus({ ...f.env, mcpClientNames: names }, f.config, {}, true))
      .find(value => value.agent === agent)!.items.find(item => item.item === "mcp")!;
    assert.equal((await mcp("codex")).evidence.lastConnected, "2026-09-24T16:41:15.683Z");
    assert.equal((await mcp("claude")).evidence.lastConnected, null);
    await writeFile(join(activity, "mcp-claude-code.json"), JSON.stringify({ at: "2026-09-25T04:11:12.950Z", name: "claude-code" }));
    assert.equal((await mcp("claude")).evidence.lastConnected, "2026-09-25T04:11:12.950Z");
    assert.equal((await mcp("codex")).evidence.lastConnected, "2026-09-24T16:41:15.683Z");
  } finally { await f.cleanup(); }
});
