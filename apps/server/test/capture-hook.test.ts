import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessmentDirectory, handleCaptureHook, recordAssessment } from "../src/hook/capture-assessment.js";

const turn = { sessionId: "session-1", turnId: "turn-1" };
const stop = { hook_event_name: "Stop", session_id: turn.sessionId, turn_id: turn.turnId };
const activity = { ...stop, hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { exit_code: 1 } };
const assessment = { ...turn, outcome: "NO_INCREMENT", reason: "仅按冻结规范改文件名，未发现新判断。" };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codex-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("ordinary turns stay empty; failed Bash activity warns once without replacing assessment", async t => {
  const root = await fixture(t);
  assert.deepEqual(await handleCaptureHook(stop, root), {});
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await handleCaptureHook({ ...activity, tool_name: "WebSearch" }, root), {});
  assert.deepEqual(await readdir(root), []);
  await Promise.all(Array.from({ length: 8 }, () => handleCaptureHook(activity, root)));
  const warnings = await Promise.all(Array.from({ length: 8 }, () => handleCaptureHook(stop, root)));
  assert.equal(warnings.filter(value => value.systemMessage).length, 1);
  assert.match(warnings.find(value => value.systemMessage)!.systemMessage!, /未找到知识评估记录/);
  const directory = assessmentDirectory(root, turn);
  assert.deepEqual((await readdir(directory)).sort(), ["activity.flag", "warned.flag"]);
  await recordAssessment(root, assessment);
  const bytes = await readFile(join(directory, "assessment.json"), "utf8");
  await handleCaptureHook({ ...activity, tool_name: "apply_patch" }, root);
  assert.equal(await readFile(join(directory, "assessment.json"), "utf8"), bytes);
  assert.deepEqual(await handleCaptureHook(stop, root), {});
});

test("four outcomes, candidate references and no-activity engineering delivery", async t => {
  const root = await fixture(t);
  for (const outcome of ["SKIPPED", "NO_INCREMENT", "CANDIDATE", "FAILED"]) {
    const current = { ...assessment, turnId: outcome, outcome, references: ["inbox/example.md sha256:example"] };
    await recordAssessment(root, current);
    const response = await handleCaptureHook({ ...stop, turn_id: outcome }, root);
    assert.equal(Boolean(response.systemMessage), outcome === "FAILED");
    if (outcome === "FAILED") assert.match(response.systemMessage!, /未完成/);
    else assert.deepEqual(response, {});
  }
  for (const invalid of [
    { ...assessment, reason: "  " }, { ...assessment, outcome: "INCOMPLETE" },
    { ...assessment, outcome: "CANDIDATE" }, { ...assessment, references: [""] },
    { ...assessment, sessionId: "../../outside" }, { ...assessment, turnId: "" },
    { ...assessment, capabilityId: "must-not-be-stored" },
    { ...assessment, reason: "字".repeat(2000), references: ["字".repeat(1000)] },
  ]) await assert.rejects(recordAssessment(root, invalid));
});

test("turn and session isolation; corrupt, oversized and mismatched records cannot pass", async t => {
  const root = await fixture(t);
  await recordAssessment(root, assessment);
  await handleCaptureHook({ ...activity, turn_id: "turn-2" }, root);
  assert.ok((await handleCaptureHook({ ...stop, turn_id: "turn-2" }, root)).systemMessage);
  await handleCaptureHook({ ...activity, session_id: "session-2" }, root);
  assert.ok((await handleCaptureHook({ ...stop, session_id: "session-2" }, root)).systemMessage);
  for (const [i, bytes] of ["{", JSON.stringify({ ...assessment, turnId: "other" }), "x".repeat(8193)].entries()) {
    const currentTurn = { ...turn, turnId: `corrupt-${i}` };
    const directory = assessmentDirectory(root, currentTurn);
    await mkdir(directory);
    await writeFile(join(directory, "assessment.json"), bytes);
    assert.ok((await handleCaptureHook({ ...stop, turn_id: currentTurn.turnId }, root)).systemMessage);
    assert.deepEqual(await handleCaptureHook({ ...stop, turn_id: currentTurn.turnId }, root), {});
  }
  assert.deepEqual(await handleCaptureHook(stop, root), {});
});

test("atomic concurrent records and markers stay parseable; new assessment replaces old one", async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.all([
    recordAssessment(root, { ...assessment, reason: `完整结果 ${i}` }), handleCaptureHook(activity, root),
  ])));
  const directory = assessmentDirectory(root, turn);
  assert.match(JSON.parse(await readFile(join(directory, "assessment.json"), "utf8")).reason, /^完整结果 \d+$/);
  await recordAssessment(root, { ...assessment, outcome: "FAILED", reason: "新验证证据尚未核对" });
  assert.match((await handleCaptureHook(stop, root)).systemMessage!, /新验证证据尚未核对/);
  assert.deepEqual((await readdir(directory)).sort(), ["activity.flag", "assessment.json", "warned.flag"]);
});

test("unavailable filesystem, missing identities and symlink records fail open", async t => {
  const root = await fixture(t);
  const file = join(root, "not-a-directory");
  await writeFile(file, "unchanged");
  for (const event of [stop, activity]) {
    const result = await handleCaptureHook(event, file);
    assert.deepEqual(Object.keys(result), ["systemMessage"]);
    assert.match(result.systemMessage!, /检查不可用/);
  }
  assert.ok((await handleCaptureHook({ hook_event_name: "Stop" }, root)).systemMessage);
  const directory = assessmentDirectory(root, turn);
  await mkdir(directory);
  await symlink(file, join(directory, "assessment.json"));
  assert.ok((await handleCaptureHook(stop, root)).systemMessage);
  assert.equal(await readFile(file, "utf8"), "unchanged");
});

test("real CLI processes fail open, time out, and run with no knowledge service or database", async t => {
  const root = await fixture(t);
  async function cli(input: string | null, record = false) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/hook/capture-cli.ts", ...(record ? ["--record"] : [])], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, PRECEDENT_LOOP_CAPTURE_CACHE_PATH: root }, stdio: "pipe",
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    if (input !== null) child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { code, stdout, stderr };
  }
  for (const input of ["{", JSON.stringify({}), "x".repeat(1_000_001), null]) {
    const result = await cli(input);
    assert.equal(result.code, 0);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["systemMessage"]);
  }
  assert.equal((await cli(JSON.stringify(activity))).code, 0);
  assert.equal((await cli(JSON.stringify({ ...assessment, outcome: "CANDIDATE" }), true)).code, 1);
  const result = await cli(JSON.stringify(assessment), true);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { recorded: true });
  assert.deepEqual(JSON.parse((await cli(JSON.stringify(stop))).stdout), {});
  const large = JSON.stringify({ ...assessment, knowledgeIssues: Array.from({ length: 4 }, () => ({ assetId: "ast1", kind: "OUTDATED", detail: "中".repeat(500), evidence: "文".repeat(500) })) });
  assert.ok(Buffer.byteLength(large) > 8192 && Buffer.byteLength(large) < 16384);
  const failedIssues = await cli(large, true);
  assert.equal(failedIssues.code, 0); assert.deepEqual(JSON.parse(failedIssues.stdout), { recorded: true, issues: { recorded: 0, error: "ISSUES_NOT_RECORDED" } });
  assert.equal((await cli(large + " ".repeat(16385 - Buffer.byteLength(large)), true)).code, 1);
  const started = performance.now();
  assert.equal((await cli(null, true)).code, 1);
  assert.ok(performance.now() - started >= 3000 && performance.now() - started < 4500);
  assert.equal((await readdir(root)).length, 1);
});
