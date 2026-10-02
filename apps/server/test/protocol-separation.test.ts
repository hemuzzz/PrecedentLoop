import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
const dist = process.env.PRECEDENT_LOOP_TEST_DIST === "1";
const modules = new URL(dist ? "../dist/" : "../src/", import.meta.url);
const { initializeDatabase }: typeof import("../src/storage/schema.js") = await import(new URL("storage/schema.js", modules).href);
const { handleCodexHook }: typeof import("../src/hook/user-prompt-submit.js") = await import(new URL("hook/user-prompt-submit.js", modules).href);
const { KnowledgeRepository }: typeof import("../src/knowledge/repository.js") = await import(new URL("knowledge/repository.js", modules).href);
const { WorkspaceCapabilityService }: typeof import("../src/workspace/capability.js") = await import(new URL("workspace/capability.js", modules).href);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codex-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "独立 home"); const cwd = join(root, "unrelated-project");
  await mkdir(home); await mkdir(cwd);
  for (const path of [join(home, "AGENTS.md"), join(cwd, "AGENTS.md")]) await writeFile(path, "保留用户工作区；不提交代码。\n");
  const databasePath = join(root, "knowledge.sqlite");
  const workspaceConfigPath = join(root, "workspaces.json");
  initializeDatabase(databasePath);
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [
    { name: "target", paths: [join(root, "target")], aliases: ["目标项目"], knowledgeAccess: "PREAUTHORIZED" },
  ] }));
  const input = { hook_event_name: "UserPromptSubmit", cwd, session_id: "isolated-session", turn_id: "isolated-turn" };
  return { root, home, cwd, databasePath, workspaceConfigPath, input };
}
function context(output: string | null): string {
  assert.ok(output);
  const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext;
}

test("self-contained injection needs no installed files; target capability works across cwd", async t => {
  const f = await fixture(t);
  const output = context(await handleCodexHook(f.input, f));
  assert.doesNotMatch(output, /Skills|KNOWLEDGE|memory-recall|knowledge-capture|memory-usage-settlement/);
  for (const tool of ["knowledge_recall", "asset_read", "asset_mark_used", "candidate_prepare"]) assert.ok(output.includes(tool));
  assert.ok(output.includes("CANDIDATE（已准备或并入候选，references 填 candidateId）"));
  const list = JSON.parse(output.split("Precedent Loop WorkspaceCapability\n")[1]!.split("\n")[0]!) as { capabilityId: string; workspace: string }[];
  assert.deepEqual(list.map(item => item.workspace), ["target"]);
  const repository = new KnowledgeRepository(f.databasePath);
  try {
    const selected = await new WorkspaceCapabilityService(repository, f.workspaceConfigPath).select(list.map(item => item.capabilityId));
    assert.deepEqual(selected.authorizedWorkspaces, ["target"]);
  } finally { repository.close(); }
  for (const file of [join(f.home, "AGENTS.md"), join(f.cwd, "AGENTS.md")]) assert.equal(await readFile(file, "utf8"), "保留用户工作区；不提交代码。\n");
});

test("capture requirement survives missing command; valid command and identity are delivered exactly", async t => {
  const f = await fixture(t);
  const absent = context(await handleCodexHook(f.input, f));
  assert.match(absent, /candidate_prepare/); assert.match(absent, /命令缺失/); assert.doesNotMatch(absent, /"command":/);
  const captureCommand = "/bin/sh '/isolated path/capture.sh' --record";
  const present = context(await handleCodexHook(f.input, { ...f, captureCommand }));
  const envelope = JSON.parse(present.split(`${captureCommand}\n`)[1]!.split("\n")[0]!);
  assert.deepEqual(envelope, { sessionId: f.input.session_id, turnId: f.input.turn_id, outcome: "NO_INCREMENT", reason: "<具体原因>" });
  const missing = context(await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: f.cwd }, { ...f, captureCommand }));
  assert.match(missing, /candidate_prepare/); assert.match(missing, /评估标识或命令缺失/); assert.doesNotMatch(missing, /"command":|"sessionId":/);
});

test("capability failures preserve fixed protocol and valid capture context without fake empty success", async t => {
  const f = await fixture(t);
  await writeFile(f.workspaceConfigPath, "invalid JSON");
  for (const configuration of [f, { ...f, databasePath: join(f.root, "missing", "db.sqlite") }, {}]) {
    const output = context(await handleCodexHook(f.input, { ...configuration, captureCommand: "/isolated/capture --record" }));
    assert.match(output, /CAPABILITY_UNAVAILABLE/);
    assert.match(output, /candidate_prepare/); assert.match(output, /knowledge_recall/);
    assert.match(output, /"sessionId":"isolated-session"/);
    assert.doesNotMatch(output, /Precedent Loop WorkspaceCapability\n/);
    assert.doesNotMatch(output, /SQLITE_|SyntaxError|at handleCodexHook/);
  }
});

test("successful empty capability list is distinct from failure", async t => {
  const f = await fixture(t);
  await writeFile(f.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  const output = context(await handleCodexHook(f.input, f));
  assert.match(output, /Precedent Loop WorkspaceCapability\n\[\]/);
  assert.doesNotMatch(output, /CAPABILITY_UNAVAILABLE/);
});

test("beyond the context bound, the cwd project is kept, the rest are omitted by name and the omission is reported", async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`);
  const current = f.input.cwd;
  await writeFile(f.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [...names.map(name => ({ name, paths: [join(f.root, name)] })), { name: "zz-current", paths: [current] }] }));
  const output = context(await handleCodexHook(f.input, f));
  const issued = JSON.parse(output.split("Precedent Loop WorkspaceCapability\n")[1]!.split("\n")[0]!) as Array<{ workspace: string }>;
  assert.equal(issued.length, 24);
  assert.deepEqual(issued.map(item => item.workspace), ["zz-current", ...names.slice(0, 23)]);
  assert.match(output, /本轮省略 7 个/); assert.doesNotMatch(output, /WORKSPACE_CAPABILITY_LIMIT/);
  const repository = new KnowledgeRepository(f.databasePath);
  try { assert.equal(repository.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM workspace_capability").get()!.n, 24); }
  finally { repository.close(); }
});

test("both hosts deliver bounded context with filled record template and no protocol dependency", async t => {
  const f = await fixture(t);
  const lengths: Array<{ host: string; context: number; unavailable: number }> = [];
  await writeFile(f.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: Array.from({ length: 1000 }, (_, index) => ({ name: `workspace-${index}`, paths: [join(f.root, String(index))] })) }));
  for (const host of ["codex", "claude"] as const) {
    const captureCommand = `"$HOME/.precedent/bin/precedent-hook" ${host} record`;
    const identity = { session_id: "11111111-1111-4111-8111-111111111111", turn_id: "22222222-2222-4222-8222-222222222222", prompt_id: "33333333-3333-4333-8333-333333333333" };
    const output = context(await handleCodexHook({ ...f.input, ...identity }, { ...f, captureCommand }, host));
    const withoutCapabilities = output.replace(/(Precedent Loop WorkspaceCapability\n)[^\n]+/u, "$1");
    assert.ok(output.includes("用到的知识过时、有误、不完整、标题误导或换说法才召回到，且不能直接修订时，记录中加 knowledgeIssues：[{assetId,kind,detail,evidence?,missedQueries?}]，kind 取 OUTDATED|INACCURATE|INCOMPLETE|MISLEADING|MISSED，detail 写明哪里不对与已知现状。"));
    assert.doesNotMatch(output, /Skills|KNOWLEDGE|协议位置/);
    assert.ok(output.includes(`cat <<'EOF' | ${captureCommand}`));
    assert.ok(output.includes(`"sessionId":"${identity.session_id}"`));
    assert.ok(output.includes(`"turnId":"${host === "codex" ? identity.turn_id : identity.prompt_id}"`));
    const unavailable = context(await handleCodexHook({ ...f.input, ...identity }, { captureCommand }, host));
    lengths.push({ host, context: withoutCapabilities.length, unavailable: unavailable.length });
    for (const outcome of ["NO_INCREMENT", "CANDIDATE", "FAILED", "SKIPPED"]) assert.ok(output.includes(outcome));
  }
  t.diagnostic(JSON.stringify(lengths));
  assert.ok(lengths.every(value => value.context <= 1800 && value.unavailable <= 1800), JSON.stringify(lengths));
});

test("both hosts preserve complete 128-character identities in the record template", async t => {
  const f = await fixture(t);
  const identity = { session_id: "s".repeat(128), turn_id: "t".repeat(128), prompt_id: "p".repeat(128) };
  for (const host of ["codex", "claude"] as const) {
    const captureCommand = `"$HOME/.precedent/bin/precedent-hook" ${host} record`;
    const output = context(await handleCodexHook({ ...f.input, ...identity }, { ...f, captureCommand }, host));
    const envelope = JSON.parse(output.split(`${captureCommand}\n`)[1]!.split("\n")[0]!);
    assert.deepEqual(envelope, { sessionId: identity.session_id, turnId: host === "codex" ? identity.turn_id : identity.prompt_id, outcome: "NO_INCREMENT", reason: "<具体原因>" });
  }
});

test("CLI preserves context on missing configuration but rejects invalid host input without inventing a turn", async t => {
  const f = await fixture(t);
  const entry = fileURLToPath(new URL(`hook/user-prompt-submit.${dist ? "js" : "ts"}`, modules));
  const invoke = (input: string) => spawnSync(process.execPath, [...(dist ? [] : ["--import", "tsx"]), entry], {
    input, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH },
  });
  const valid = invoke(JSON.stringify(f.input));
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(context(valid.stdout), /CAPABILITY_UNAVAILABLE/);
  for (const input of ["invalid JSON", JSON.stringify({ ...f.input, cwd: "relative" })]) {
    const result = invoke(input); assert.equal(result.status, 0); assert.equal(result.stdout, "");
    assert.match(result.stderr, /CAPABILITY_UNAVAILABLE/); assert.doesNotMatch(result.stderr, /SyntaxError|stack/);
  }
  assert.equal(await handleCodexHook({ hook_event_name: "Stop" }, {}), null);
});
