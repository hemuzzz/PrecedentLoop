import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AiService } from "../src/ai/service.js";
import { readAiConfiguration, runAiCli, type AiProvider } from "../src/ai/cli.js";
import { candidateFixture } from "../test-support/candidate-fixture.js";

test("AI overlays reuse provider validation, reread each call and clear back to resource defaults without restart", async () => {
  const f = await candidateFixture(), appConfigPath = join(f.root, "app-config.json"), calls: AiProvider[] = [];
  const ai = new AiService(f.service, { configPath: f.configPath, appConfigPath, runner: async input => { calls.push(input.provider); return { reply: "OK" }; } });
  try {
    await writeFile(f.configPath, JSON.stringify({ providers: [{ id: "codex", executable: "/resource/codex", model: "resource-model", profile: "resource-profile", timeoutMs: 600000 }, { id: "claude", executable: "/resource/claude", timeoutMs: 600000 }] }));
    const base = { detectedPaths: { codex: process.execPath, claude: join(f.root, "auto-claude") } };
    await writeFile(appConfigPath, JSON.stringify(base));
    assert.equal((await ai.test({ provider: "codex" })).success, true);
    assert.equal(calls[0]!.model, "resource-model"); assert.equal(calls[0]!.executable, process.execPath);
    const override = { defaultProvider: "claude", providers: { codex: { model: "override", timeoutMs: 180000 }, claude: { model: "claude-override" } } };
    await writeFile(appConfigPath, JSON.stringify({ ...base, manualPaths: { codex: join(f.root, "manual-codex") }, ai: override }));
    assert.equal((await ai.test({ provider: "codex" })).success, true);
    assert.equal(calls[1]!.id, "codex"); assert.equal(calls[1]!.executable, join(f.root, "manual-codex"));
    assert.equal(calls[1]!.model, "override"); assert.equal(calls[1]!.profile, "resource-profile"); assert.equal(calls[1]!.timeoutMs, 180000);
    const settings = await ai.settings(); assert.equal(settings.defaultProvider, "claude"); assert.deepEqual(settings.overrides, override);
    await writeFile(appConfigPath, JSON.stringify(base)); await ai.test({ provider: "codex" });
    assert.deepEqual(calls[2], calls[0]); assert.deepEqual((await ai.settings()).overrides, {});
    for (const invalid of [{ providers: { claude: { profile: "invalid" } } }, { providers: { codex: { timeoutMs: 999 } } }, { providers: { codex: { model: " " } } }, { providers: { codex: { executable: "/forged" } } }, { defaultProvider: "other" }]) {
      await writeFile(appConfigPath, JSON.stringify({ ...base, ai: invalid }));
      await assert.rejects(readAiConfiguration(f.configPath, appConfigPath), { code: "AI_CONFIGURATION_INVALID" });
      assert.equal((await ai.test({ provider: "codex" })).error?.code, "AI_CONFIGURATION_INVALID");
    }
    assert.equal(calls.length, 3);
    await writeFile(appConfigPath, "{}"); assert.equal((await ai.test({ provider: "codex" })).error?.code, "AI_CLI_UNAVAILABLE");
    assert.equal((await ai.settings()).providers[0]!.executable, null);
    await writeFile(appConfigPath, "{broken"); await assert.rejects(ai.settings(), { code: "AI_CONFIGURATION_INVALID" });
  } finally { await ai.close(); await f.cleanup(); }
});

test("active imports block tests and subsequent imports reread overlays on the same service instance", async () => {
  const f = await candidateFixture(), appConfigPath = join(f.root, "app-config.json"), calls: AiProvider[] = [];
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const ai = new AiService(f.service, { configPath: f.configPath, appConfigPath, runner: async input => {
    calls.push(input.provider);
    if (calls.length === 1) { entered(); await blocked; }
    return { schemaVersion: 1, candidates: [], sourceResults: [{ sourceKey: "0", explanation: "测试资料没有增量", pendingRef: null }], warnings: [] };
  } });
  const request = { provider: "codex", sources: [{ name: "one.md", content: "isolated fixture" }], targets: [{ scope: "GLOBAL" }] };
  const completed = async (requestId: string) => {
    for (let count = 0; count < 200; count++) { const result = await ai.status(requestId); if (result?.state !== "RUNNING") return result; await delay(10); }
    throw new Error("fixture did not complete");
  };
  try {
    await writeFile(appConfigPath, JSON.stringify({ detectedPaths: { codex: process.execPath } }));
    await ai.import({ ...request, requestId: "first" }); await ready;
    await assert.rejects(ai.test({ provider: "codex" }), { code: "AI_BUSY" });
    release(); assert.equal((await completed("first"))?.state, "SUCCEEDED");
    await writeFile(appConfigPath, JSON.stringify({ manualPaths: { codex: "/fake/manual-codex" }, ai: { providers: { codex: { model: "next-call", timeoutMs: 180000 } } } }));
    await ai.import({ ...request, requestId: "second" }); assert.equal((await completed("second"))?.state, "SUCCEEDED");
    assert.equal(calls[0]!.executable, process.execPath); assert.equal(calls[1]!.executable, "/fake/manual-codex");
    assert.equal(calls[1]!.model, "next-call"); assert.equal(calls[1]!.timeoutMs, 180000);
  } finally { release(); await ai.close(); await f.cleanup(); }
});

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await snapshot(path))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return result;
}

test("test request uses the real restricted Codex runner with a fake executable and writes no knowledge, candidate or receipt", async () => {
  const f = await candidateFixture(), executable = join(f.root, "fake-codex"), log = join(f.root, "invocations.jsonl");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';
    const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:a,cwd:process.cwd()})+'\\n');
    if(a.includes('--help')) console.log('--ignore-rules --output-schema --output-last-message --ephemeral --sandbox');
    else if(a.includes('features')) console.log('hooks stable true\\nshell_tool stable true\\nplugins stable true');
    else if(a.includes('mcp')) console.log(JSON.stringify([{name:'known',enabled:!a.includes('mcp_servers.known.enabled=false')}]));
    else {let prompt='';for await(const chunk of process.stdin)prompt+=chunk;if(prompt!=='请仅回复 OK')process.exit(7);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({reply:'OK'}));}
  `, { mode: 0o700 });
  await writeFile(f.configPath, JSON.stringify({ providers: [{ id: "codex", executable, timeoutMs: 2000 }] }));
  const ai = new AiService(f.service, { configPath: f.configPath });
  try {
    const database = await readFile(f.options.databasePath);
    const result = await ai.test({ provider: "codex" }); assert.equal(result.success, true); assert.ok(result.durationMs >= 0);
    assert.deepEqual(await readFile(f.options.databasePath), database);
    assert.equal(await ai.status(), null);
    const entries = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string });
    const args = entries.at(-1)!.args;
    for (const flag of ["read-only", "--ignore-rules", "--ephemeral", "hooks", "shell_tool", "plugins", "mcp_servers.known.enabled=false"]) assert.ok(args.includes(flag), flag);
    await assert.rejects(access(entries.at(-1)!.cwd), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify(result), /reply|prompt|input|output/u);
  } finally { await ai.close(); await f.cleanup(); }
});

test("test request uses restricted Claude parameters, a temporary policy and no persistent candidate writes", { skip: process.platform !== "darwin" }, async () => {
  const f = await candidateFixture(), executable = join(f.root, "fake-claude"), log = join(f.root, "claude.jsonl");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
    if(a.includes('--help')) console.log('--tools --strict-mcp-config --settings --json-schema --no-session-persistence --disallowedTools --disable-slash-commands');
    else if(a.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'pro'}));
    else {let text='';for await(const chunk of process.stdin)text+=chunk;if(text!=='请仅回复 OK')process.exit(7);console.log(JSON.stringify({structured_output:{reply:'OK'}}));}
  `, { mode: 0o700 });
  await writeFile(f.configPath, JSON.stringify({ providers: [{ id: "claude", executable, timeoutMs: 2000 }] }));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: input => runAiCli({ ...input, claudePolicy: { managedDirectory: join(f.root, "managed"), claudeDirectory: join(f.root, "claude"), checkSystemPolicy: async () => {} } }) });
  try {
    const database = await readFile(f.options.databasePath);
    assert.equal((await ai.test({ provider: "claude" })).success, true);
    const args = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)!) as string[];
    for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "mcp__*"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), { disableAllHooks: true, autoMemoryEnabled: false });
    assert.equal(args[args.indexOf("--tools") + 1], ""); assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.deepEqual(await readFile(f.options.databasePath), database);
  } finally { await ai.close(); await f.cleanup(); }
});

test("test requests and imports share mutual exclusion; failure reasons never echo CLI output", async () => {
  const f = await candidateFixture(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => { entered(); await wait; return { reply: "OK" }; } });
  try {
    const running = ai.test({ provider: "codex" }); await ready;
    await assert.rejects(ai.test({ provider: "codex" }), { code: "AI_BUSY" });
    await assert.rejects(ai.import({ requestId: "busy-import", provider: "codex", sources: [{ name: "one.md", content: "fixture" }], targets: [{ scope: "GLOBAL" }] }), { code: "AI_BUSY" });
    release(); await running;
    await assert.rejects(ai.test({ provider: "codex", prompt: "forged" }));
    for (const [script, code] of [["setInterval(()=>{},1000)", "AI_TIMEOUT"], ["console.error('not logged in SECRET_BODY');process.exit(1)", "AI_AUTH_UNAVAILABLE"]]) {
      const executable = join(f.root, "failure-cli"); await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
      await writeFile(f.configPath, JSON.stringify({ providers: [{ id: "codex", executable, timeoutMs: 1000 }] }));
      const failing = new AiService(f.service, { configPath: f.configPath });
      const result = await failing.test({ provider: "codex" }); assert.equal(result.error?.code, code); assert.doesNotMatch(JSON.stringify(result), /SECRET_BODY/); await failing.close();
    }
  } finally { release(); await ai.close(); await f.cleanup(); }
});
