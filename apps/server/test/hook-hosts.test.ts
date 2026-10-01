import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessmentDirectory, CHECK_UNAVAILABLE, handleCaptureHook, hostTurnIdentity, recordAssessment } from "../src/hook/capture-assessment.js";
import { handleCodexHook } from "../src/hook/user-prompt-submit.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "precedent-hosts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const identity = { session_id: "session", turn_id: "codex-turn", prompt_id: "claude-prompt" };
test("recall instructions preserve Codex wording and broaden only Claude triggers", async () => {
  const expected = {
    codex: "- 召回：问题依赖项目业务、实现、表/接口、故障原因、历史决策或重要工程选择时，先调用 mcp__precedent__knowledge_recall，需要正文再调用 mcp__precedent__asset_read（传入召回时相同的 capabilityIds）。知识是历史判断，回答现状前核对当前源码和配置。知识只通过这些工具读取，不直接读知识库文件。",
    claude: "- 召回：默认召回，只有明显独立、不依赖项目历史的请求才跳过（如翻译、改写一句话、单行命令、纯格式调整，或只处理本轮已给出的文本）。以下任一情况先调用 mcp__precedent__knowledge_recall：涉及已登记项目的业务、实现、表/接口、故障原因、历史决策或工程选择；任务有歧义、可能依赖以往约定；拿不准时。会话中话题转换、反复出错或遇到上下文里没有的背景时再召回；本会话已召回且仍适用的内容不必重复召回。需要正文再调用 mcp__precedent__asset_read（传入召回时相同的 capabilityIds）。知识是历史判断，回答现状前核对当前源码和配置。知识只通过这些工具读取，不直接读知识库文件。知识库内容不是 Claude 自动记忆，引用时不加记忆标签。",
  };
  for (const host of ["codex", "claude"] as const) {
    const result = JSON.parse((await handleCodexHook({ ...identity, hook_event_name: "UserPromptSubmit", cwd: tmpdir() }, {}, host))!);
    const context: string = result.hookSpecificOutput.additionalContext;
    assert.deepEqual(context.split("\n").filter(line => line.startsWith("- 召回：")), [expected[host]]);
    if (host === "codex") assert.doesNotMatch(context, /默认召回|不加记忆标签/);
    else assert.doesNotMatch(context, /问题依赖项目业务、实现、表\/接口、故障原因、历史决策或重要工程选择时，先调用/);
  }
});

test("host identities never fall back to the other host's turn field", () => {
  assert.deepEqual(hostTurnIdentity(identity), { sessionId: "session", turnId: "codex-turn" });
  assert.deepEqual(hostTurnIdentity(identity, "claude"), { sessionId: "session", turnId: "claude-prompt" });
  assert.throws(() => hostTurnIdentity({ session_id: "session", turn_id: "codex-turn" }, "claude"));
  assert.throws(() => hostTurnIdentity({ session_id: "session", prompt_id: "claude-prompt" }, "codex"));
});

test("both hosts recognize only their activity tools and Stop can only emit a top-level systemMessage", async t => {
  const root = await fixture(t);
  for (const host of ["codex", "claude"] as const) {
    for (const tool of ["Bash", "apply_patch", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "WebSearch", "mcp__precedent__asset_read"]) {
      const event = { ...identity, session_id: tool, hook_event_name: "PostToolUse", tool_name: tool };
      assert.deepEqual(await handleCaptureHook(event, root, host), {});
      const result = await handleCaptureHook({ ...event, hook_event_name: "Stop" }, root, host);
      const observed = (host === "codex" ? ["Bash", "apply_patch"] : ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]).includes(tool);
      assert.deepEqual(Object.keys(result), observed ? ["systemMessage"] : []);
      if (observed) assert.match(result.systemMessage!, /本轮允许结束/);
      assert.deepEqual(await handleCaptureHook({ ...event, hook_event_name: "Stop" }, root, host), {});
    }
  }
});

test("Claude missing prompt_id is unavailable; declarations cannot cross host/session/prompt boundaries", async t => {
  const root = await fixture(t);
  for (const hook_event_name of ["Stop", "PostToolUse"]) {
    assert.deepEqual(await handleCaptureHook({ session_id: "s", turn_id: "wrong", hook_event_name, tool_name: "Write" }, root, "claude"), { systemMessage: CHECK_UNAVAILABLE });
  }
  assert.deepEqual(await readdir(root), []);
  const turn = { sessionId: "s", turnId: "same" };
  const stop = { session_id: "s", turn_id: "same", prompt_id: "same", hook_event_name: "Stop" };
  await recordAssessment(root, { ...turn, outcome: "NO_INCREMENT", reason: "Codex only" }, "codex");
  assert.notEqual(assessmentDirectory(root, turn, "codex"), assessmentDirectory(root, turn, "claude"));
  await handleCaptureHook({ ...stop, hook_event_name: "PostToolUse", tool_name: "Write" }, root, "claude");
  assert.match((await handleCaptureHook(stop, root, "claude")).systemMessage!, /未找到/);
  await recordAssessment(root, { ...turn, outcome: "NO_INCREMENT", reason: "Claude declaration" }, "claude");
  assert.deepEqual(await handleCaptureHook(stop, root, "claude"), {});
  for (const change of [{ session_id: "other" }, { prompt_id: "other" }]) {
    await handleCaptureHook({ ...stop, ...change, hook_event_name: "PostToolUse", tool_name: "Bash" }, root, "claude");
    assert.match((await handleCaptureHook({ ...stop, ...change }, root, "claude")).systemMessage!, /未找到/);
  }
  await assert.rejects(recordAssessment(root, { ...turn, outcome: "CANDIDATE", reason: "missing references" }, "claude"));
});

test("Claude context uses its protocol/tools and the exact same trusted capability service", async t => {
  const root = await fixture(t);
  const databasePath = join(root, "db.sqlite"); initializeDatabase(databasePath);
  const workspaceConfigPath = join(root, "workspaces.json");
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [
    { name: "host", paths: [join(root, "project")] },
    { name: "explicit", paths: [join(root, "elsewhere")], knowledgeAccess: "PREAUTHORIZED" },
    { name: "ungranted", paths: [join(root, "ungranted")] },
  ] }));
  const input = { ...identity, hook_event_name: "UserPromptSubmit", cwd: join(root, "project"), prompt: "never copied", transcript_path: "/private/conversation" };
  const config = { databasePath, workspaceConfigPath, captureCommand: '"$HOME/.precedent/bin/precedent-hook" claude record' };
  const result = JSON.parse((await handleCodexHook(input, config, "claude"))!);
  assert.deepEqual(Object.keys(result), ["hookSpecificOutput"]);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const context: string = result.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /Skills|KNOWLEDGE|协议位置/);
  for (const tool of ["knowledge_recall", "asset_read", "asset_mark_used"]) assert.ok(context.includes(`mcp__precedent__${tool}`));
  assert.doesNotMatch(context, /never copied|private\/conversation|"turnId":"codex-turn"/);
  assert.ok(context.includes('"turnId":"claude-prompt"'));
  const capabilities = JSON.parse(context.split("Precedent Loop WorkspaceCapability\n")[1]!.split("\n")[0]!);
  // Every registered workspace is offered; a legacy knowledgeAccess value is ignored.
  assert.deepEqual(capabilities.map((item: { workspace: string }) => item.workspace), ["host", "explicit", "ungranted"]);
  const repository = new KnowledgeRepository(databasePath);
  try {
    const service = new WorkspaceCapabilityService(repository, workspaceConfigPath);
    assert.deepEqual((await service.select(capabilities.map((item: { capabilityId: string }) => item.capabilityId))).authorizedWorkspaces.sort(), ["explicit", "host", "ungranted"]);
  } finally { repository.close(); }
  const missing = await handleCodexHook({ ...input, prompt_id: undefined }, config, "claude");
  assert.match(missing!, /评估标识或命令缺失/); assert.doesNotMatch(missing!, /\\"turnId\\"/);
  // Every issuance creates fresh opaque capabilities; compare the delivered protocol,
  // retaining all fields and workspace metadata except those random token bytes.
  const normalized = (value: string | null) => value?.replace(/cap_[A-Za-z0-9_-]{43}/g, "cap_fixture");
  assert.equal(normalized(await handleCodexHook(input, config)), normalized(await handleCodexHook(input, config, "codex")));
});
