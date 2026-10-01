import assert from "node:assert/strict";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { candidateFixture, content, selection } from "../test-support/candidate-fixture.js";
import { candidatePrepareInputSchema, candidateUpdateInputSchema, updateStructuredCandidate, prepareStructuredCandidate as prepareWithReview, renderStructuredCandidate, candidateReviewInstruction } from "../src/asset/structured-candidate.js";
import type { CandidateService } from "../src/asset/candidate-service.js";
import { checkStructuredContent } from "../src/asset/structured-candidate-checks.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { createAssetMcpServer } from "../src/mcp/tools.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { AssetSearchService } from "../src/asset/search.js";
import { freezeAssets, releaseAssets, withRepositoryAccess } from "../src/asset/coordination.js";

const memory = { capabilityIds: [], type: "MEMORY", title: "事务判断", summary: "在隔离仓库内先核对基线再准备候选", conclusion: "候选准备必须核对正式基线与当前内容，只有保持身份和范围一致时才允许修订。", conditions: "本地隔离仓库，正式内容已确认", verified: "临时目录中检查候选与正式文件", reasons: "保留基线能够明确修订对象，避免把不同历史内容误认为同一次判断。" };
async function fixture() {
  const f = await candidateFixture();
  const repository = new KnowledgeRepository(f.options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, f.options.workspaceConfigPath);
  const alpha = (await capabilities.issueFromTrustedHost(f.root))[0]!.capabilityId;
  return { ...f, repository, capabilities, alpha, close: async () => { repository.close(); await f.cleanup(); } };
}

// Existing rendering/security cases acknowledge the fixture's current candidates.
// Review gating itself is exercised with prepareWithReview below.
async function prepareStructuredCandidate(input: object, service: CandidateService, capabilities: WorkspaceCapabilityService) {
  let result = await prepareWithReview(input, service, capabilities);
  if ("pendingCandidates" in result) {
    const reviewedCandidateIds = result.pendingCandidates.map(item => item.candidateId);
    result = await prepareWithReview({ ...input, reviewedCandidateIds }, service, capabilities);
  }
  assert.ok(!("status" in result));
  return result;
}

test("prepare reviews all buckets, intents and scopes without writes, and requires the current complete set", async () => {
  const f = await fixture();
  try {
    const first = await prepareWithReview({ ...memory, requestId: "first-review" }, f.service, f.capabilities);
    assert.ok(!("status" in first));
    const before = await readFile(first.path, "utf8");
    await f.service.defer({ ...selection(first, "defer-first"), deferred: true });
    const formal = (await f.service.prepare("workspace-formal", [{ ...content(), target: { scope: "WORKSPACE", workspace: "alpha" } }])).candidates[0]!;
    await f.service.accept(selection(formal, "accept-workspace"));
    const revision = (await f.service.prepare("workspace-revision", [{ ...content(), target: { scope: "WORKSPACE", workspace: "alpha" }, existingAssetId: formal.assetId, baselineHash: formal.contentHash }])).candidates[0]!;
    const snapshot = await f.service.pendingCandidates();
    for (const reviewedCandidateIds of [undefined, [], [first.candidateId]]) {
      const review = await prepareWithReview({ ...memory, requestId: "review-only", reviewedCandidateIds }, f.service, f.capabilities);
      assert.equal(review.status, "REVIEW_REQUIRED");
      assert.ok("pendingCandidates" in review);
      assert.equal(review.instruction, candidateReviewInstruction);
      assert.equal(review.omittedBodies, 0);
      assert.deepEqual(new Set(review.pendingCandidates.map(item => item.candidateId)), new Set([first.candidateId, revision.candidateId]));
      assert.equal(review.pendingCandidates.find(item => item.candidateId === first.candidateId)!.reviewBucket, "DEFERRED");
      const workspace = review.pendingCandidates.find(item => item.candidateId === revision.candidateId)!;
      assert.ok("scope" in workspace);
      assert.equal(workspace.scope, "WORKSPACE"); assert.equal(workspace.workspace, "alpha");
      assert.ok("candidateHash" in workspace);
      assert.equal(workspace.assetId, formal.assetId); assert.equal(workspace.candidateHash, revision.contentHash);
      assert.ok("bodyMarkdown" in workspace);
      assert.doesNotMatch(workspace.bodyMarkdown, /^---/);
      assert.deepEqual(await f.service.pendingCandidates(), snapshot);
      assert.equal(await f.service.receipt("review-only"), undefined);
      assert.equal(await readFile(first.path, "utf8"), before);
    }
    const independent = await prepareWithReview({ ...memory, requestId: "independent", reviewedCandidateIds: [first.candidateId, revision.candidateId, "999999"] }, f.service, f.capabilities);
    assert.ok(!("status" in independent));
    assert.equal((await f.service.pendingCandidates()).length, 3);
    // A committed receipt bypasses review, including after its candidate is rejected.
    await f.service.reject(selection(first, "reject-first"));
    assert.deepEqual(await prepareWithReview({ ...memory, requestId: "first-review" }, f.service, f.capabilities), first);
    assert.deepEqual(await prepareWithReview({ ...memory, requestId: "independent" }, f.service, f.capabilities), independent);
    await assert.rejects(prepareWithReview({ ...memory, requestId: "independent", summary: "不同内容" }, f.service, f.capabilities), { code: "REQUEST_ID_CONFLICT" });
    const stale = await prepareWithReview({ ...memory, reviewedCandidateIds: [first.candidateId, revision.candidateId] }, f.service, f.capabilities);
    assert.equal(stale.status, "REVIEW_REQUIRED");
    const complete = await prepareWithReview({ ...memory, reviewedCandidateIds: [first.candidateId, revision.candidateId, independent.candidateId] }, f.service, f.capabilities);
    assert.ok(!("status" in complete));
  } finally { await f.close(); }
});

test("review orders by candidate update time and omits whole bodies after the 30000 character budget", async () => {
  const f = await fixture();
  try {
    const older = (await f.service.prepare("small", [content("早先的小正文")])).candidates[0]!;
    const large = (await f.service.prepare("large", [content("文".repeat(30_001))])).candidates[0]!;
    const latest = (await f.service.prepare("latest", [content("最新的小正文")])).candidates[0]!;
    // Bucket updates count as updates even though the file mtime does not change.
    await f.service.defer({ ...selection(older, "defer-old"), deferred: true });
    const database = new Database(f.options.databasePath);
    try {
      for (const [index, item] of [older, large, latest].entries()) {
        database.prepare("UPDATE inbox_candidate SET updated_at=? WHERE candidate_id=?").run(`2026-09-2${9 - index}T00:00:00.000Z`, item.candidateId);
      }
    } finally { database.close(); }
    const records = await f.service.pendingCandidates();
    const review = await prepareWithReview(memory, f.service, f.capabilities);
    assert.ok("pendingCandidates" in review);
    assert.deepEqual(review.pendingCandidates.map(item => item.candidateId), [older.candidateId, large.candidateId, latest.candidateId]);
    assert.deepEqual(review.pendingCandidates.map(item => item.candidateId), records.map(item => item.record.candidateId));
    const largeIndex = review.pendingCandidates.findIndex(item => item.candidateId === large.candidateId);
    assert.ok(largeIndex >= 0);
    assert.equal(review.omittedBodies, review.pendingCandidates.length - largeIndex);
    for (const item of review.pendingCandidates.slice(largeIndex)) {
      assert.ok("bodyOmitted" in item); assert.equal(item.bodyOmitted, true); assert.ok(!("bodyMarkdown" in item));
      assert.ok(!("candidateHash" in item));
      assert.equal(item.title, "候选知识"); assert.equal(typeof item.summary, "string");
    }
    assert.ok(review.pendingCandidates.reduce((total, item) => total + ("bodyMarkdown" in item ? item.bodyMarkdown.length : 0), 0) <= 30_000);
    assert.ok(review.pendingCandidates.some(item => item.candidateId === latest.candidateId));
  } finally { await f.close(); }
});

test("review budget includes exactly 30000 body characters and omits subsequent smaller bodies", async () => {
  const f = await fixture();
  try {
    await f.service.prepare("budget", [content("小正文"), content("😀".repeat(14_998)), content("文".repeat(14_998))]);
    const review = await prepareWithReview(memory, f.service, f.capabilities);
    assert.ok("pendingCandidates" in review);
    assert.equal(review.omittedBodies, 1);
    assert.equal(review.pendingCandidates.reduce((total, item) => total + ("bodyMarkdown" in item ? [...item.bodyMarkdown].length : 0), 0), 30_000);
    assert.deepEqual(review.pendingCandidates.map(item => "bodyOmitted" in item), [false, false, true]);
  } finally { await f.close(); }
});

test("concurrent prepares review the committed candidate; receipt retries do not scan changed pending files", async () => {
  const f = await fixture();
  try {
    const inputs = ["concurrent-a", "concurrent-b"].map(requestId => ({ ...memory, requestId }));
    const results = await Promise.all(inputs.map(input => prepareWithReview(input, f.service, f.capabilities)));
    assert.equal(results.filter(result => "status" in result).length, 1);
    const writtenIndex = results.findIndex(result => !("status" in result));
    const written = results[writtenIndex]!;
    assert.ok(!("status" in written));
    assert.equal((await f.service.pendingCandidates()).length, 1);
    await writeFile(written.path, (await readFile(written.path, "utf8")) + "\n外部改动\n");
    assert.deepEqual(await prepareWithReview(inputs[writtenIndex], f.service, f.capabilities), written);
    const review = await prepareWithReview(memory, f.service, f.capabilities);
    assert.ok("pendingCandidates" in review);
    assert.deepEqual(review.pendingCandidates, [{ candidateId: written.candidateId,
      assetId: written.assetId, reviewBucket: "PENDING", problem: true }]);
  } finally { await f.close(); }
});

test("missing, invalid and hash-mismatched candidates remain in review without bodies and do not block independent writes", async () => {
  const f = await fixture();
  try {
    const created: Array<Awaited<ReturnType<typeof prepareStructuredCandidate>>> = [];
    for (const requestId of ["missing", "changed", "invalid"]) created.push(await prepareStructuredCandidate({ ...memory, requestId }, f.service, f.capabilities));
    await unlink(created[0]!.path);
    await writeFile(created[1]!.path, (await readFile(created[1]!.path, "utf8")) + "\n外部改动\n");
    await writeFile(created[2]!.path, "---\ninvalid: [\n---\n正文\n");
    const review = await prepareWithReview(memory, f.service, f.capabilities);
    assert.ok("pendingCandidates" in review);
    assert.equal(review.omittedBodies, 0);
    assert.equal(review.pendingCandidates.length, 3);
    for (const item of review.pendingCandidates) {
      assert.equal(item.problem, true); assert.ok(!("bodyMarkdown" in item));
      const original = created.find(candidate => candidate.candidateId === item.candidateId)!;
      assert.ok(!("candidateHash" in item));
      await assert.rejects(updateStructuredCandidate({ capabilityIds: [], candidateId: item.candidateId, candidateHash: original.contentHash,
        title: memory.title, summary: memory.summary, bodyMarkdown: memory.conclusion }, f.service, f.capabilities), { code: "CONTENT_HASH_MISMATCH" });
    }
    const incomplete = await prepareWithReview({ ...memory, reviewedCandidateIds: created.slice(1).map(item => item.candidateId) }, f.service, f.capabilities);
    assert.equal(incomplete.status, "REVIEW_REQUIRED");
    const independent = await prepareWithReview({ ...memory, reviewedCandidateIds: created.map(item => item.candidateId) }, f.service, f.capabilities);
    assert.ok(!("status" in independent));
    assert.equal((await f.service.pendingCandidates()).length, 4);
    assert.ok((await readFile(independent.path, "utf8")).includes(memory.conclusion));
  } finally { await f.close(); }
});

test("update preserves identity, type, scope and revision baseline, moves deferred candidates to pending and replays receipts", async () => {
  const f = await fixture();
  try {
    for (const type of ["MEMORY", "SKILL", "DOCUMENT"] as const) {
      for (const scope of ["GLOBAL", "WORKSPACE"] as const) {
        const target = scope === "GLOBAL" ? { scope } : { scope, workspace: "alpha" };
        const original = (await f.service.prepare(`original-${type}-${scope}`, [{ ...content(memory.conclusion), type, target }])).candidates[0]!;
        await f.service.accept(selection(original, `accept-${type}-${scope}`));
        const revision = (await f.service.prepare(`revision-${type}-${scope}`, [{ ...content(memory.conclusion), type, target,
          existingAssetId: original.assetId, baselineHash: original.contentHash }])).candidates[0]!;
        await f.service.defer({ ...selection(revision, `defer-${type}-${scope}`), deferred: true });
        const before = (await f.service.pendingCandidates()).find(item => item.record.candidateId === revision.candidateId)!;
        const input = { capabilityIds: scope === "GLOBAL" ? [] : [f.alpha], candidateId: revision.candidateId, candidateHash: revision.contentHash,
          title: "原有判断与补充", summary: memory.summary, bodyMarkdown: `${before.asset!.content}\n\n补充：写入后仍须核对待审状态与原有身份，确认之前不能替代正式知识。`, requestId: `update-${type}-${scope}` };
        const result = await updateStructuredCandidate(input, f.service, f.capabilities);
        assert.equal(result.changed, true); assert.equal(result.assetId, original.assetId); assert.equal(result.candidateId, revision.candidateId);
        assert.equal(result.path, join(f.options.repositoryPath, before.record.relativePath));
        assert.equal(result.display, `已修改候选 #${revision.candidateId}，已回到待审，请在 Hub 候选管理中审核`);
        assert.deepEqual(await updateStructuredCandidate(input, f.service, f.capabilities), result);
        await assert.rejects(updateStructuredCandidate({ ...input, summary: "冲突请求" }, f.service, f.capabilities), { code: "REQUEST_ID_CONFLICT" });
        const after = (await f.service.pendingCandidates()).find(item => item.record.candidateId === revision.candidateId)!;
        assert.equal(after.record.reviewBucket, "PENDING"); assert.equal(after.record.baselineHash, original.contentHash);
        assert.equal(after.record.intent, "REVISION"); assert.equal(after.record.relativePath, before.record.relativePath);
        assert.deepEqual(after.asset!.frontmatter, { ...before.asset!.frontmatter, title: input.title, summary: input.summary });
        assert.equal(after.asset!.content.trim(), input.bodyMarkdown.trim());
        assert.equal(after.asset!.contentHash, result.contentHash);
      }
    }
  } finally { await f.close(); }
});

test("update rejects invalid input and accepts a previously returned hash outside the current review budget", async () => {
  const f = await fixture();
  try {
    const global = await prepareStructuredCandidate(memory, f.service, f.capabilities);
    const workspace = await prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha] }, f.service, f.capabilities);
    for (const [candidate, capabilityIds, wrong] of [[global, [], [f.alpha]], [workspace, [f.alpha], []]] as const) {
      const input = { capabilityIds: [...capabilityIds], candidateId: candidate.candidateId, candidateHash: candidate.contentHash,
        title: memory.title, summary: memory.summary, bodyMarkdown: memory.conclusion };
      const before = await readFile(candidate.path, "utf8");
      await assert.rejects(updateStructuredCandidate({ ...input, capabilityIds: [...wrong] }, f.service, f.capabilities), { code: "CAPABILITY_INVALID" });
      await assert.rejects(updateStructuredCandidate({ ...input, candidateHash: "a".repeat(64) }, f.service, f.capabilities), { code: "CONTENT_HASH_MISMATCH" });
      for (const field of ["title", "summary", "bodyMarkdown"] as const) {
        await assert.rejects(updateStructuredCandidate({ ...input, [field]: 'password="DO_NOT_ECHO"' }, f.service, f.capabilities), { code: "CONTENT_CONTAINS_SECRET", field });
      }
      await assert.rejects(updateStructuredCandidate({ ...input, bodyMarkdown: "参见 https://example.com/guide.md" }, f.service, f.capabilities), { code: "CONTENT_DEPENDS_ON_LINKS", field: "bodyMarkdown" });
      assert.equal(candidateUpdateInputSchema.safeParse({ ...input, bodyMarkdown: "---\nid: ast123\n---\n正文" }).success, false);
      for (const field of ["type", "scope", "assetId", "baselineHash", "workspace"]) assert.equal(candidateUpdateInputSchema.safeParse({ ...input, [field]: "override" }).success, false);
      assert.equal(await readFile(candidate.path, "utf8"), before);
    }
    await f.service.prepare("oversized", [content("文".repeat(30_001))]);
    const review = await prepareWithReview(memory, f.service, f.capabilities);
    assert.ok("pendingCandidates" in review);
    assert.ok(review.pendingCandidates.every(item => "bodyOmitted" in item && item.bodyOmitted === true));
    assert.ok(review.pendingCandidates.every(item => !("candidateHash" in item)));
    const updated = await updateStructuredCandidate({ capabilityIds: [], candidateId: global.candidateId, candidateHash: global.contentHash,
      title: memory.title, summary: memory.summary, bodyMarkdown: memory.conclusion }, f.service, f.capabilities);
    assert.equal(updated.candidateId, global.candidateId);
  } finally { await f.close(); }
});

test("all structured types render their own model chapters and evidence annotations", () => {
  const retained = "2026-09-26T00:00:00.000Z";
  const parsed = candidatePrepareInputSchema.parse({ ...memory, unverified: "真实宿主未验证", recheckPoints: "核对基线", revision: { assetId: "ast123", baselineHash: "a".repeat(64) },
    evidence: [{ supports: "事务边界", kind: "EXCERPT", processing: "REDACTED", content: "摘录含 ``` 围栏", sourceHint: "service.ts", sourceTime: "2026-09" }, { supports: "说明", kind: "INFERENCE", content: "推断材料" }], related: [{ assetId: "ast1", relation: "补充" }] });
  const body = renderStructuredCandidate(parsed, [{ title: "正式标题", assetId: "ast1", relation: "补充" }], retained);
  for (const section of ["结论与适用条件", "理由与取舍", "依据与验证边界", "历史依据", "再次使用时的核验点", "相关知识", "本次变更说明"]) assert.ok(body.includes(`## ${section}`));
  for (const text of ["已验证：", "未验证：真实宿主未验证", "摘录；处理：脱敏", "材料：推断", "留存：2026-09-26T00:00:00.000Z，本次会话提交", "材料所述时间：2026-09", "正式标题（ast1）：补充", "修订自基线 aaaaaaaaaaaa", "````text"]) assert.ok(body.includes(text), text);
  const skill = candidatePrepareInputSchema.parse({ capabilityIds: [], type: "SKILL", title: "流程", summary: "摘要", trigger: "准备时", prerequisites: "临时库", steps: [memory.conclusion, "核验结果"], verification: "读回", stopConditions: "基线不同停止", recheckPoints: "版本" });
  const skillBody = renderStructuredCandidate(skill, [], retained);
  for (const section of ["触发", "输入与前置条件", "步骤", "验证", "停止条件", "再次使用时的核验点"]) assert.ok(skillBody.includes(`## ${section}`));
  assert.ok(skillBody.includes(`1. ${memory.conclusion}\n\n2. 核验结果`)); assert.doesNotMatch(skillBody, /历史依据|本次变更说明/);
  const document = candidatePrepareInputSchema.parse({ capabilityIds: [], type: "DOCUMENT", title: "参考", summary: "摘要", purpose: memory.conclusion, coverage: "截至本次，只覆盖临时测试", bodyMarkdown: "## 自然章节\n\n资料" });
  assert.equal(renderStructuredCandidate(document, [], retained), `# 参考\n\n## 用途与范围\n\n${memory.conclusion}\n\n截至本次，只覆盖临时测试\n\n## 自然章节\n\n资料`);
});

test("schema rejects missing required, foreign type fields, unpaired revisions and unlabelled excerpts", () => {
  for (const input of [{ ...memory, conclusion: undefined }, { ...memory, steps: ["错位"] }, { ...memory, revision: { assetId: "ast1" } }, { ...memory, revision: { baselineHash: "a".repeat(64) } }, { ...memory, evidence: [{ kind: "EXCERPT", supports: "判断", content: "内容" }] }, { ...memory, workspace: "alpha" }, { ...memory, capabilityIds: ["cap_" + "a".repeat(43), "cap_" + "b".repeat(43)] }]) assert.equal(candidatePrepareInputSchema.safeParse(input).success, false);
  for (const input of [{ capabilityIds: [], type: "SKILL", title: "流程", summary: "摘要", trigger: "触发", steps: [], verification: "检查" }, { capabilityIds: [], type: "DOCUMENT", title: "参考", summary: "摘要", purpose: "目的", coverage: "范围", bodyMarkdown: "---\nid: ast1\n---", verified: "错位" }]) assert.equal(candidatePrepareInputSchema.safeParse(input).success, false);
});

test("link dependency and credential checks report only field names across nested content", () => {
  for (const conclusion of ["见 https://example.com/decision", "参见 /repo/docs/decision.md:123", "见 docs/decision.md 第12行", "见 C:\\repo\\decision.md:10",
    "见（docs/very-long-directory/decision）", "见：~/very-long-directory/decision。", "见 './very-long-directory/decision'", "见 ../very-long-directory/decision", "/very-long-directory/decision", "见 C:\\very-long-directory\\decision", "见 /very-long-directory/decision#L12-L24",
    "见（/项目文档/足够长且没有独立结论的目录名称/设计内容）",
  ]) assert.throws(() => checkStructuredContent(candidatePrepareInputSchema.parse({ ...memory, conclusion })), { code: "CONTENT_DEPENDS_ON_LINKS", field: "conclusion" });
  checkStructuredContent(candidatePrepareInputSchema.parse(memory));
  for (const content of ["-----BEGIN RSA PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP", "ghp_syntheticToken", "github_pat_synthetic", "sk-synthetic1234567890", "sk-ant-synthetic1234567890", "xoxb-synthetic", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "password = 1234-abcd-5678", '"token": "synthetic"', "secret: 'abcd1234efgh5678'",
    "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop", 'password = "hunter2hunter2"', "token: 'abcd1234efgh5678'",
  ]) {
    assert.throws(() => checkStructuredContent(candidatePrepareInputSchema.parse({ ...memory, evidence: [{ kind: "EXPLANATION", supports: "检查", content }] })), error => {
      assert.equal((error as { code: string }).code, "CONTENT_CONTAINS_SECRET"); assert.equal((error as { field: string }).field, "evidence.0.content"); assert.ok(!(error as Error).message.includes(content)); return true;
    });
  }
});

test("Chinese prose and code excerpts are not mistaken for paths or credential literals", () => {
  checkStructuredContent(candidatePrepareInputSchema.parse({ ...memory, conclusion: "依赖项目业务实现、表/接口或故障原因时必须先召回再核对当前源码，不能直接凭记忆回答。" }));
  for (const content of [
    "interface LoginResult { token: string; expiresIn: number }",
    "const schema = z.object({ password: z.string().min(8) })",
    "password = synthetic", "secret: synthetic", "token=synthetic", "password=DO_NOT_ECHO",
    "token: AccessToken", "token = accessToken", "secret = process.env.X", "password = z.string().min(8)",
    'token: "process.env.X"', 'password: "<占位符占位符>"', 'secret: "********"', 'token: "xxxxxxxx"',
    'password: "string"', 'token: "abcd123"', "secret: ***", "token: xxx",
  ]) assert.doesNotThrow(() => checkStructuredContent(candidatePrepareInputSchema.parse({ ...memory, evidence: [{ kind: "EXCERPT", processing: "ORIGINAL", supports: "代码结构", content }] })), content);
});

test("prepare maps capabilities, checks related current scope, preserves idempotency and formal assets", async () => {
  const f = await fixture();
  try {
    const global = (await f.service.prepare("global", [content()])).candidates[0]!; await f.service.accept(selection(global, "accept-global"));
    const formalPath = join(f.options.repositoryPath, `assets/global/memories/${global.assetId}.md`);
    await rename(formalPath, join(f.options.repositoryPath, "assets/global/memories/custom-name.md"));
    const alpha = (await f.service.prepare("alpha", [{ ...content(), target: { scope: "WORKSPACE", workspace: "alpha" } }])).candidates[0]!; await f.service.accept(selection(alpha, "accept-alpha"));
    const input = { ...memory, requestId: "structured", evidence: [{ kind: "EXPLANATION", supports: "判断", content: "材料" }], related: [{ assetId: global.assetId, relation: "补充" }] };
    const first = await prepareStructuredCandidate(input, f.service, f.capabilities);
    assert.deepEqual(await prepareStructuredCandidate(input, f.service, f.capabilities), first);
    assert.equal((await f.service.receipt("structured"))?.operation, "prepare");
    assert.match(first.path, /inbox\/global\/memories/); assert.match(first.display, /请在 Hub 候选管理中审核/);
    const source = await readFile(first.path, "utf8"); assert.match(source, /scope: "GLOBAL"/); assert.ok(source.includes(`候选知识（${global.assetId}）`));
    await assert.rejects(prepareStructuredCandidate({ ...input, summary: "改变输入" }, f.service, f.capabilities), { code: "REQUEST_ID_CONFLICT" });
    const workspace = await prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha], related: [{ assetId: alpha.assetId, relation: "同项目" }, { assetId: global.assetId, relation: "全局" }] }, f.service, f.capabilities);
    assert.match(workspace.path, /inbox\/workspaces\/alpha/); assert.match(workspace.requestId, /^tsk\d+$/);
    assert.deepEqual(await prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha], related: [{ assetId: alpha.assetId, relation: "同项目" }, { assetId: global.assetId, relation: "全局" }], requestId: workspace.requestId }, f.service, f.capabilities), workspace);
    await assert.rejects(prepareStructuredCandidate({ ...memory, related: [{ assetId: alpha.assetId, relation: "越界" }] }, f.service, f.capabilities), { code: "RELATED_ASSET_INVALID", field: "related.0.assetId" });
    await assert.rejects(prepareStructuredCandidate({ ...memory, related: [{ assetId: first.assetId, relation: "未确认" }] }, f.service, f.capabilities), { code: "RELATED_ASSET_INVALID" });
    await assert.rejects(prepareStructuredCandidate({ ...memory, capabilityIds: ["cap_" + "z".repeat(43)] }, f.service, f.capabilities), { code: "CAPABILITY_INVALID" });
    await assert.rejects(prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha, f.alpha] }, f.service, f.capabilities));
    const revision = { ...memory, revision: { assetId: global.assetId, baselineHash: global.contentHash }, requestId: "revision" };
    await withRepositoryAccess(f.options.repositoryPath, async () => freezeAssets(f.options.repositoryPath, [global.assetId], "test-owner"));
    await assert.rejects(prepareStructuredCandidate(revision, f.service, f.capabilities), { code: "ASSET_FROZEN" });
    await releaseAssets(f.options.repositoryPath, "test-owner");
    const revised = await prepareStructuredCandidate(revision, f.service, f.capabilities);
    assert.equal(revised.intent, "REVISION"); assert.equal(revised.assetId, global.assetId);
    assert.ok((await readFile(revised.path, "utf8")).includes(`修订自基线 ${global.contentHash.slice(0, 12)}`));
    assert.ok(!(await readFile(revised.path.replace("/inbox/", "/assets/"), "utf8")).includes(memory.conclusion));
    assert.match(revised.path, /custom-name\.md$/);
    await f.service.accept({ ...selection(revised, "accept-revision"), baselineHash: global.contentHash });
    assert.deepEqual(await prepareStructuredCandidate(revision, f.service, f.capabilities), revised);
    await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
    await assert.rejects(prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha] }, f.service, f.capabilities), { code: "CAPABILITY_INVALID" });
  } finally { await f.close(); }
});

test("SKILL and DOCUMENT save complete candidates; cross-workspace and ineligible related assets are rejected", async () => {
  const f = await fixture();
  try {
    await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [f.root] }, { name: "beta", paths: [join(f.root, "beta")] }] }));
    const beta = (await f.service.prepare("beta", [{ ...content(), target: { scope: "WORKSPACE", workspace: "beta" } }])).candidates[0]!;
    await f.service.accept(selection(beta, "accept-beta"));
    await assert.rejects(prepareStructuredCandidate({ ...memory, capabilityIds: [f.alpha], related: [{ assetId: beta.assetId, relation: "另一项目" }] }, f.service, f.capabilities), { code: "RELATED_ASSET_INVALID" });
    const betaPath = join(f.options.repositoryPath, `assets/workspaces/beta/memories/${beta.assetId}.md`);
    await writeFile(betaPath, "invalid frontmatter");
    const betaCapability = (await f.capabilities.issueFromTrustedHost(join(f.root, "beta"))).find(value => value.workspace === "beta")!.capabilityId;
    await assert.rejects(prepareStructuredCandidate({ ...memory, capabilityIds: [betaCapability], related: [{ assetId: beta.assetId, relation: "当前不合格" }] }, f.service, f.capabilities), { code: "RELATED_ASSET_INVALID" });
    for (const input of [
      { capabilityIds: [], type: "SKILL", title: "流程", summary: "步骤摘要", trigger: "临时测试", steps: [memory.conclusion], verification: "读回检查" },
      { capabilityIds: [f.alpha], type: "DOCUMENT", title: "资料", summary: "资料摘要", purpose: memory.conclusion, coverage: "仅临时测试，截至本次", bodyMarkdown: "## 自然章节\n\n资料正文" },
    ]) {
      const result = await prepareStructuredCandidate(input, f.service, f.capabilities);
      const markdown = await readFile(result.path, "utf8");
      assert.ok(markdown.includes(`type: "${input.type}"`));
      assert.ok(markdown.includes(input.type === "SKILL" ? "## 步骤" : "## 自然章节"));
      const field = input.type === "SKILL" ? "steps" : "purpose";
      await assert.rejects(prepareStructuredCandidate({ ...input, [field]: field === "steps" ? ["见 /repo/steps.md:20"] : "见 https://example.com/purpose" }, f.service, f.capabilities), { code: "CONTENT_DEPENDS_ON_LINKS", field });
      await assert.rejects(prepareStructuredCandidate({ ...input, summary: "token=abcd-1234-efgh-5678" }, f.service, f.capabilities), { code: "CONTENT_CONTAINS_SECRET", field: "summary" });
    }
  } finally { await f.close(); }
});

for (const notification of ["absent", "success", "throws"] as const) test(`MCP candidates preserve results, display and notification counts (${notification})`, async () => {
  const f = await fixture();
  const search = new AssetSearchService({ ...f.options, refreshIndex: async () => {} });
  const knowledgeService = new KnowledgeService(f.repository, f.capabilities, search, () => {});
  let notifications = 0;
  const notificationError = new Error("notification failed");
  const logged: unknown[] = [];
  const server = createAssetMcpServer({ knowledgeService, candidateService: f.service, capabilities: f.capabilities,
    onInternalError: error => { logged.push(error); },
    ...(notification === "absent" ? {} : { onCandidateWritten: () => { notifications++; if (notification === "throws") throw notificationError; } }),
  });
  const assertNotifications = (count: number): void => {
    assert.equal(notifications, notification === "absent" ? 0 : count);
    assert.deepEqual(logged, notification === "throws" ? Array.from({ length: count }, () => notificationError) : []);
  };
  const client = new Client({ name: "structured-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const definitions = (await client.listTools()).tools;
    assert.deepEqual(definitions.find(tool => tool.name === "knowledge_recall")!._meta, { "anthropic/alwaysLoad": true });
    const schema = definitions.find(tool => tool.name === "candidate_prepare")!.inputSchema;
    const description = definitions.find(tool => tool.name === "candidate_prepare")!.description!;
    for (const rule of ["PENDING 与 DEFERRED", "NEW 与 REVISION", "不分范围", "REVIEW_REQUIRED 是正常结果", "NO_INCREMENT", "candidate_update", "reviewedCandidateIds", "缺少正文", "不要在聊天中询问用户"]) assert.ok(description.includes(rule), rule);
    for (const rule of ["写明候选编号", "同一主题", "补充、更正或推翻", "范围须与那条候选相符", "problem: true"]) assert.ok(description.includes(rule), rule);
    assert.doesNotMatch(description, /当前尚未接入/);
    const update = definitions.find(tool => tool.name === "candidate_update")!;
    for (const rule of ["同一主题", "仍然成立的结论、条件和依据要保留", "不要只在末尾追加", "类型或范围需要改变时", "candidate_prepare 写新候选", "candidateId、candidateHash", "capabilityIds", "不含 Frontmatter", "缺少正文", "problem: true", "回到待审", "原来暂存的也一样", "不要在聊天中询问用户"]) assert.ok(update.description!.includes(rule), rule);
    for (const field of Object.values(update.inputSchema.properties!)) assert.equal(typeof (field as { description?: string }).description, "string");
    const scopeDescription = (schema.properties!.capabilityIds as { description: string }).description;
    for (const rule of ["换一个业务不同的项目仍能直接使用", "不提本项目的名称、路径、业务术语也能完整表述", "拿不准就用工作区", "两边都沾时拆成两条候选"]) assert.ok(scopeDescription.includes(rule), rule);
    assert.equal(schema.type, "object");
    for (const field of Object.values(schema.properties!)) assert.equal(typeof (field as { description?: string }).description, "string");
    const prepareInput = { ...memory, title: "请在 Hub 候选管理中审核（接受入库｜修改｜暂存｜拒绝）", requestId: "mcp-prepare-notify" };
    const success = await client.callTool({ name: "candidate_prepare", arguments: prepareInput });
    assert.notEqual(success.isError, true); assert.match(JSON.stringify(success), /display/);
    const preparedData = JSON.parse((success.content as Array<{ text: string }>)[0]!.text) as { display: string };
    assert.ok(preparedData.display.includes(`**【标题】** ${prepareInput.title}`));
    assert.equal(preparedData.display.split("\n").at(-1), notification === "absent"
      ? "请在 Hub 候选管理中审核（接受入库｜修改｜暂存｜拒绝）" : "已在 Precedent Loop 中打开候选页，请审核（接受入库｜修改｜暂存｜拒绝）");
    assertNotifications(1);
    assert.deepEqual(await client.callTool({ name: "candidate_prepare", arguments: prepareInput }), success);
    assertNotifications(2);
    const review = await client.callTool({ name: "candidate_prepare", arguments: memory });
    assert.notEqual(review.isError, true);
    const reviewData = JSON.parse((review.content as Array<{ text: string }>)[0]!.text) as { status: string; pendingCandidates: Array<{ candidateId: string; candidateHash: string; bodyMarkdown: string }> };
    assert.equal(reviewData.status, "REVIEW_REQUIRED"); assert.equal(reviewData.pendingCandidates.length, 1);
    assertNotifications(2);
    const item = reviewData.pendingCandidates[0]!;
    const updateInput = { capabilityIds: [], candidateId: item.candidateId, candidateHash: item.candidateHash, title: memory.title, summary: memory.summary,
      bodyMarkdown: item.bodyMarkdown + "\n\n补充：此项协议行为已经通过隔离测试验证，真实会话仍须人工核实。", requestId: "mcp-update" };
    const updated = await client.callTool({ name: "candidate_update", arguments: updateInput });
    assert.notEqual(updated.isError, true); assert.match(JSON.stringify(updated), /已回到待审/);
    const updatedData = JSON.parse((updated.content as Array<{ text: string }>)[0]!.text) as { display: string };
    assert.equal(updatedData.display, `已修改候选 #${item.candidateId}，已回到待审，${notification === "absent" ? "请在 Hub 候选管理中审核" : "已在 Precedent Loop 中打开候选页"}`);
    assertNotifications(3);
    assert.deepEqual(await client.callTool({ name: "candidate_update", arguments: updateInput }), updated);
    assertNotifications(4);
    const unsafe = await client.callTool({ name: "candidate_update", arguments: { ...updateInput, requestId: "unsafe-update", bodyMarkdown: 'password="DO_NOT_ECHO"' } });
    assert.equal(unsafe.isError, true); assert.match(JSON.stringify(unsafe), /CONTENT_CONTAINS_SECRET/);
    assert.match(JSON.stringify(unsafe), /bodyMarkdown/); assert.doesNotMatch(JSON.stringify(unsafe), /DO_NOT_ECHO|stack/);
    assertNotifications(4);
    const independent = await client.callTool({ name: "candidate_prepare", arguments: { ...memory, reviewedCandidateIds: reviewData.pendingCandidates.map(item => item.candidateId) } });
    assert.notEqual(independent.isError, true); assert.match(JSON.stringify(independent), /display/);
    assertNotifications(5);
    const failure = await client.callTool({ name: "candidate_prepare", arguments: { ...memory, title: 'password="DO_NOT_ECHO"' } });
    assert.equal(failure.isError, true); assert.match(JSON.stringify(failure), /CONTENT_CONTAINS_SECRET/); assert.match(JSON.stringify(failure), /title/); assert.doesNotMatch(JSON.stringify(failure), /DO_NOT_ECHO|stack/);
    assertNotifications(5);
  } finally { await client.close(); await server.close(); search.close(); await f.close(); }
});
