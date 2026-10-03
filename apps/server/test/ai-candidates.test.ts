import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AiService, importOutputSchema, type AiOperationStatus } from "../src/ai/service.js";
import { allowed, candidatePrepareInputSchema, prepareStructuredCandidate } from "../src/asset/structured-candidate.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { providerAvailability, runAiCli, runProcess } from "../src/ai/cli.js";
import { candidateFixture, content, selection } from "../test-support/candidate-fixture.js";

const batch = (requestId: string) => ({ requestId, provider: "codex", sources: [{ name: "one.md", content: "第一份资料" }, { name: "two.md", content: "第二份资料" }], targets: [{ scope: "GLOBAL" }], instructions: "保留有依据的结论" });
const conclusion = "候选提交前必须核对正式基线和适用范围，只有内容完整且经过检查时才允许写入。";
const output = (count = 1) => ({ schemaVersion: 1, candidates: Array.from({ length: count }, (_, i) => ({ title: `结论${i}`, summary: "摘要", retrievalTerms: content().retrievalTerms, conclusion, conditions: "适用于本地候选导入", verified: "已在隔离目录核对写入结果", reasons: null, unverified: null, recheckPoints: null, evidence: null, related: null, type: "MEMORY", targetKey: "0", existingAssetRef: null, sourceKeys: ["0", "1"] })), sourceResults: [{ sourceKey: "0", explanation: "共同支持结论", pendingRef: null }, { sourceKey: "1", explanation: "补充必要条件", pendingRef: null }], warnings: [] });
async function finished(service: AiService, id: string): Promise<AiOperationStatus> {
  for (let i = 0; i < 200; i++) {
    const result = await service.status(id);
    if (result?.state !== "RUNNING") { assert.ok(result); return result; }
    await delay(10);
  }
  throw new Error("operation did not finish");
}

test("AI import references and rewrite candidate/baseline display their heading once", async () => {
  const f = await candidateFixture();
  const original = content(`# 候选知识\n\n${conclusion}`);
  const revised = content(`# 候选知识\n\n修订：${conclusion}`);
  const expected = `# 候选知识\n\n可核实的摘要\n\n检索词：${JSON.stringify(original.retrievalTerms)}\n\n${conclusion}`;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8")) as {
      operation: string; existingAssets: Array<{ content: string }>; candidate: string; baseline: string;
    };
    if (payload.operation === "import") {
      assert.deepEqual(payload.existingAssets.map(asset => asset.content), [expected]);
      return output(0);
    }
    assert.equal(payload.baseline, expected);
    assert.equal(payload.candidate, `# 候选知识\n\n可核实的摘要\n\n检索词：${JSON.stringify(revised.retrievalTerms)}\n\n修订：${conclusion}`);
    return { schemaVersion: 1, content: { title: revised.title, summary: revised.summary, retrievalTerms: revised.retrievalTerms, bodyMarkdown: revised.bodyMarkdown }, explanation: "保持内容" };
  } });
  try {
    const item = (await f.prepare("display-formal", [original])).candidates[0]!;
    await f.service.accept(selection(item, "display-accept"));
    await ai.import(batch("display-import"));
    assert.equal((await finished(ai, "display-import")).state, "SUCCEEDED");
    const revision = (await f.prepare("display-revision", [{ ...revised, existingAssetId: item.assetId, baseVersion: 0 }])).candidates[0]!;
    await ai.rewrite({ ...selection(revision, "display-rewrite"), provider: "codex", instructions: "检查正文" });
    assert.equal((await finished(ai, "display-rewrite")).state, "SUCCEEDED");
    assert.deepEqual((await f.service.list()).items[0]!.retrievalTerms, revised.retrievalTerms);
  } finally { await ai.close(); await f.cleanup(); }
});

test("AI import and rewrite require valid terms and persist normalized output", async () => {
  const f = await candidateFixture(); let valid = false;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8")) as { operation: string };
    const retrievalTerms = valid ? ["  CandidateTerms  ", "candidateterms", "候选检索", "完整列表"] : ["invalid"];
    return payload.operation === "import" ? { ...output(), candidates: [{ ...output().candidates[0], retrievalTerms }] }
      : { schemaVersion: 1, content: { title: "改稿", summary: "摘要", bodyMarkdown: conclusion, retrievalTerms }, explanation: "更新检索词" };
  } });
  try {
    await ai.import(batch("invalid-terms"));
    assert.equal((await finished(ai, "invalid-terms")).error?.code, "AI_OUTPUT_INVALID");
    assert.equal((await f.service.list()).items.length, 0);
    valid = true; await ai.import(batch("valid-terms"));
    assert.equal((await finished(ai, "valid-terms")).state, "SUCCEEDED");
    const item = (await f.service.list()).items[0]!;
    assert.deepEqual(item.retrievalTerms, ["CandidateTerms", "候选检索", "完整列表"]);
    valid = false;
    await ai.rewrite({ ...selection(item, "invalid-rewrite-terms"), provider: "codex", instructions: "修改" });
    assert.equal((await finished(ai, "invalid-rewrite-terms")).error?.code, "AI_OUTPUT_INVALID");
    assert.equal((await f.service.list()).items[0]!.version, item.version);
    valid = true;
    await ai.rewrite({ ...selection(item, "valid-rewrite-terms"), provider: "codex", instructions: "修改" });
    assert.equal((await finished(ai, "valid-rewrite-terms")).state, "SUCCEEDED");
    assert.deepEqual((await f.service.list()).items[0]!.retrievalTerms, ["CandidateTerms", "候选检索", "完整列表"]);
  } finally { await ai.close(); await f.cleanup(); }
});

test("import JSON Schema has strict objects with every property required", () => {
  let objects = 0;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "object") {
      objects++;
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(new Set(node.required as string[]), new Set(Object.keys(node.properties as object)));
    }
    Object.values(node).forEach(inspect);
  };
  const schema = z.toJSONSchema(importOutputSchema);
  inspect(schema);
  assert.ok(objects >= 8);
  const candidates = schema.properties!.candidates!;
  assert.equal(typeof candidates, "object");
  assert.ok(typeof candidates === "object" && candidates.items && !Array.isArray(candidates.items) && typeof candidates.items === "object");
  assert.equal(candidates.items.anyOf!.length, 3);
  const candidate = output().candidates[0]!;
  for (const invalid of [
    { ...output(), schemaVersion: 2 },
    { ...output(), candidates: [{ ...candidate, reasons: undefined }] },
    { ...output(), candidates: [{ ...candidate, evidence: [{ supports: "判断", kind: "EXCERPT", content: "摘录", processing: null, sourceHint: null, sourceTime: null }] }] },
    { ...output(), candidates: [{ type: "DOCUMENT", title: "手册", summary: "范围", purpose: conclusion, coverage: "本地", bodyMarkdown: "---\nid: ast1\n---\n正文", targetKey: "0", existingAssetRef: null, sourceKeys: ["0"], evidence: null, related: null }] },
  ]) assert.equal(importOutputSchema.safeParse(invalid).success, false);
});

test("all import types produce the same candidate body as MCP apart from retention origin", async () => {
  const f = await candidateFixture();
  const repository = new KnowledgeRepository(f.options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, f.options.workspaceConfigPath);
  const common = { capabilityIds: [], title: "可复用的知识", summary: "候选内容保持完整", retrievalTerms: content().retrievalTerms,
    evidence: [{ supports: "边界", kind: "EXCERPT", processing: "PARTIAL", content: "核对内容与范围", sourceHint: "one.md", sourceTime: "2026-09" },
      { supports: "结论", kind: "EXPLANATION", content: "本地核查记录" }] };
  const inputs = [
    { ...common, type: "MEMORY", conclusion, conditions: "本地使用", reasons: conclusion, verified: "临时目录验证", unverified: "生产未验证", recheckPoints: "检查基线" },
    { ...common, type: "SKILL", trigger: "提交候选时", prerequisites: "隔离目录", steps: [conclusion, "检查回执"], verification: "读取回执", stopConditions: "基线不符", recheckPoints: "确认范围" },
    { ...common, type: "DOCUMENT", purpose: conclusion, coverage: "本地参考手册", bodyMarkdown: "## 完整参考\n\n" + conclusion },
  ].map(input => candidatePrepareInputSchema.parse(input));
  const generated = inputs.map(input => ({ type: input.type, title: input.title, summary: input.summary, retrievalTerms: input.retrievalTerms,
    ...Object.fromEntries(allowed[input.type].map(name => [name, input[name] ?? null])),
    evidence: input.evidence!.map(item => ({ ...item, processing: item.processing ?? null, sourceHint: item.sourceHint ?? null, sourceTime: item.sourceTime ?? null })),
    related: null, targetKey: "0", existingAssetRef: null, sourceKeys: ["0", "1"] }));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ ...output(), candidates: generated }) });
  try {
    await ai.import(batch("three-types"));
    assert.equal((await finished(ai, "three-types")).state, "SUCCEEDED");
    const imported = await f.service.pendingCandidates();
    for (const input of inputs) {
      const result = await prepareStructuredCandidate({ ...input, reviewedCandidateIds: (await f.service.pendingCandidates()).map(item => item.record.candidateId) }, f.service, capabilities);
      assert.ok(!("status" in result));
      const mcp = (await f.service.pendingCandidates()).find(item => item.record.candidateId === result.candidateId)!.record;
      const actual = imported.find(item => item.record.type === input.type)!.record.bodyMarkdown;
      assert.match(actual, /留存：\d{4}-.*，本次导入提交/u);
      const canonical = (body: string) => body.replace(/留存：[^\n]+，本次(?:会话|导入)提交/gu, "留存：服务端时间，提交");
      assert.equal(canonical(actual), canonical(mcp.bodyMarkdown));
    }
  } finally { await ai.close(); repository.close(); await f.cleanup(); }
});

test("import filters unsafe candidates individually and commits a durable zero-item receipt when all fail", async () => {
  const f = await candidateFixture(); let calls = 0;
  const bad = [{ ...output().candidates[0]!, title: "凭据", conclusion: 'password="DO_NOT_ECHO"' },
    { ...output().candidates[0]!, title: "链接", conclusion: "参见 https://example.com/guide.md" }];
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ ...output(), candidates: ++calls === 1 ? [...bad, output().candidates[0]!] : bad }) });
  try {
    for (const requestId of ["partial-safe", "all-unsafe"]) {
      await ai.import(batch(requestId));
      assert.equal((await finished(ai, requestId)).state, "SUCCEEDED");
      const receipt = await f.service.receipt(requestId);
      const result = receipt!.result as { candidates: unknown[]; warnings: string[] };
      assert.equal(result.candidates.length, requestId === "partial-safe" ? 1 : 0);
      assert.deepEqual(result.warnings, ["候选《凭据》未写入：CONTENT_CONTAINS_SECRET（conclusion）", "候选《链接》未写入：CONTENT_DEPENDS_ON_LINKS（conclusion）"]);
      assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO|example\.com/u);
      await ai.import(batch(requestId));
    }
    assert.equal(calls, 2);
    assert.equal((await f.service.list()).items.length, 1);
  } finally { await ai.close(); await f.cleanup(); }
});

test("related references are validated before filtering, while scope violations only remove that candidate", async () => {
  const f = await candidateFixture(); let forged = true;
  const formal = (await f.prepare("formal", [{ ...content(conclusion), target: { scope: "WORKSPACE", workspace: "alpha" } }])).candidates[0]!;
  await f.service.accept(selection(formal, "accept"));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ ...output(), candidates: [
    { ...output().candidates[0]!, title: "相关知识", related: [{ existingAssetRef: forged ? "invented" : "0", relation: "相关参考" }], ...(forged ? { conclusion: "https://example.com" } : {}) },
    { ...output().candidates[0]!, title: "允许相关知识", targetKey: "1", related: [{ existingAssetRef: "0", relation: "相关参考" }] },
    output().candidates[0]!,
  ] }) });
  try {
    for (const requestId of ["forged-related", "scope-related"]) {
      await ai.import({ ...batch(requestId), targets: [{ scope: "GLOBAL" }, { scope: "WORKSPACE", workspace: "alpha" }] });
      const status = await finished(ai, requestId);
      if (forged) {
        assert.equal(status.error?.code, "AI_OUTPUT_INVALID");
        assert.equal(await f.service.receipt(requestId), undefined);
      } else {
        assert.equal(status.state, "SUCCEEDED");
        const result = status.result as { candidates: unknown[]; warnings: string[] };
        assert.equal(result.candidates.length, 2);
        assert.deepEqual(result.warnings, ["候选《相关知识》未写入：RELATED_ASSET_INVALID（related.0.assetId）"]);
        const related = (await f.service.pendingCandidates()).find(item => item.record.title === "允许相关知识")!.record;
        assert.ok(related.bodyMarkdown.includes(`候选知识（${formal.assetId}）：相关参考`));
      }
      forged = false;
    }
  } finally { await ai.close(); await f.cleanup(); }
});

test("revision conflicts include pending and deferred records and do not roll back independent candidates", async () => {
  const f = await candidateFixture();
  const formal = (await f.prepare("formal", [content(conclusion)])).candidates[0]!;
  await f.service.accept(selection(formal, "accept"));
  await f.prepare("revision", [{ ...content(conclusion), existingAssetId: formal.assetId, baseVersion: formal.version }]);
  const pending = (await f.service.pendingCandidates())[0]!;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ ...output(), candidates: [{ ...output().candidates[0]!, title: "修订", existingAssetRef: "0" }, output().candidates[0]!] }) });
  try {
    for (const requestId of ["healthy-conflict", "abnormal-conflict"]) {
      if (requestId === "abnormal-conflict") await f.service.defer({ ...selection(pending.record, "defer-revision"), deferred: true });
      await ai.import(batch(requestId));
      const status = await finished(ai, requestId);
      assert.equal(status.state, "SUCCEEDED");
      const result = status.result as { candidates: unknown[]; warnings: string[] };
      assert.equal(result.candidates.length, 1);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0], `候选《修订》未写入：已有未处理的候选 #${pending.record.number}（${requestId === "abnormal-conflict" ? "暂存" : "待审"}）。`);
    }
  } finally { await ai.close(); await f.cleanup(); }
});

test("AI import skips a revision whose formal version changed during inference and commits independent candidates", async () => {
  const f = await candidateFixture();
  const formal = (await f.prepare("stale-formal", [content(conclusion)])).candidates[0]!;
  await f.service.accept(selection(formal, "stale-accept"));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => {
    const revision = (await f.prepare("concurrent-revision", [{ ...content("另一条已审核修订"), existingAssetId: formal.assetId, baseVersion: 0 }])).candidates[0]!;
    await f.service.accept({ ...selection(revision, "concurrent-accept"), baseVersion: 0 });
    return { ...output(), candidates: [{ ...output().candidates[0]!, title: "过时修订", existingAssetRef: "0" }, output().candidates[0]!] };
  } });
  try {
    await ai.import(batch("stale-import"));
    const status = await finished(ai, "stale-import"); assert.equal(status.state, "SUCCEEDED");
    const result = status.result as { count: number; warnings: string[] };
    assert.equal(result.count, 1); assert.equal(result.warnings.length, 1); assert.match(result.warnings[0]!, /版本或范围已变化/);
    const current = (await f.service.formalAssets())[0]!;
    assert.equal(current.version, 1); assert.equal(current.bodyMarkdown, "另一条已审核修订");
    assert.equal((await f.service.list()).items.length, 1); assert.ok(await f.service.receipt("stale-import"));
  } finally { await ai.close(); await f.cleanup(); }
});

test("AI import rechecks related knowledge inside the commit after concurrent deletion", async () => {
  const f = await candidateFixture();
  const formal = (await f.prepare("related-formal", [content(conclusion)])).candidates[0]!;
  await f.service.accept(selection(formal, "related-accept"));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => {
    await f.service.delete({ requestId: "related-delete", assetId: formal.assetId });
    return { ...output(), candidates: [{ ...output().candidates[0]!, title: "引用已删除知识", related: [{ existingAssetRef: "0", relation: "提供适用前提" }] }, output().candidates[0]!] };
  } });
  try {
    await ai.import(batch("related-import"));
    const status = await finished(ai, "related-import"); assert.equal(status.state, "SUCCEEDED");
    const result = status.result as { count: number; warnings: string[] };
    assert.equal(result.count, 1); assert.deepEqual(result.warnings, ["候选《引用已删除知识》未写入：RELATED_ASSET_INVALID"]);
    assert.equal((await f.service.list()).items.length, 1);
  } finally { await ai.close(); await f.cleanup(); }
});

test("pending comparisons filter SELECTED targets, omit processed rows and private identifiers, and resolve source pendingRef", async () => {
  const f = await candidateFixture(); let automatic = false, forged = false;
  let runnerError: unknown;
  await f.prepare("global", [content(conclusion)]);
  await f.prepare("workspace", [{ ...content(conclusion), title: "工作区", target: { scope: "WORKSPACE", workspace: "alpha" } }]);
  await f.prepare("problem", [content(conclusion)]);
  const before = await f.service.pendingCandidates();
  const problem = before[0]!;
  await f.service.reject(selection(problem.record, "reject-problem"));
  const global = before.find(item => item.record.candidateId !== problem.record.candidateId && item.record.scope === "GLOBAL")!;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    try {
      const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8")) as { pendingCandidates: Array<{ pendingRef: string; scope: string; title: string; bodyMarkdown: string }>; pendingComparisonLimited: boolean };
      assert.equal(payload.pendingCandidates.length, automatic ? 2 : 1);
      assert.equal(payload.pendingComparisonLimited, false);
      assert.doesNotMatch(JSON.stringify(payload.pendingCandidates), /candidateId|candidateVersion|version|assetId/u);
      for (const item of before) {
        assert.ok(!JSON.stringify(payload.pendingCandidates).includes(item.record.assetId));
      }
      const item = payload.pendingCandidates.find(item => item.scope === "GLOBAL")!;
      assert.equal(item.bodyMarkdown, global.record.bodyMarkdown);
      assert.equal((await f.service.list()).items.every(item => !("frozen" in item) || !item.frozen), true);
      return { ...output(0), sourceResults: output().sourceResults.map(source => ({ ...source, explanation: "建议补充到该候选", pendingRef: forged ? "invented" : item.pendingRef })) };
    } catch (error) { runnerError = error; throw error; }
  } });
  try {
    for (const requestId of ["selected-pending", "auto-pending", "forged-pending"]) {
      automatic = requestId === "auto-pending"; forged = requestId === "forged-pending";
      await ai.import({ ...batch(requestId), targets: automatic ? [] : batch(requestId).targets });
      const status = await finished(ai, requestId);
      assert.ifError(runnerError);
      if (forged) { assert.equal(status.error?.code, "AI_OUTPUT_INVALID"); assert.equal(await f.service.receipt(requestId), undefined); }
      else {
        assert.equal(status.state, "SUCCEEDED");
        const result = status.result as { sourceResults: Array<{ name: string; explanation: string }> };
        assert.equal(result.sourceResults[0]!.name, "one.md");
        assert.equal(result.sourceResults[0]!.explanation, `建议补充到该候选（待审候选 #${global.record.number}）`);
      }
    }
    assert.deepEqual(await f.service.pendingCandidates(), before.filter(item => item.record.candidateId !== problem.record.candidateId));
  } finally { await ai.close(); await f.cleanup(); }
});

test("pending comparison budget emits omission markers and a durable limited warning", async () => {
  const f = await candidateFixture();
  await f.prepare("large-pending", [content("文".repeat(30_001))]);
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8"));
    assert.equal(payload.pendingComparisonLimited, true);
    assert.equal(payload.pendingCandidates[0].bodyOmitted, true);
    assert.equal("bodyMarkdown" in payload.pendingCandidates[0], false);
    assert.doesNotMatch(JSON.stringify(payload.pendingCandidates), /candidateId|Hash|assetId/u);
    return output(0);
  } });
  try {
    await ai.import(batch("limited-pending"));
    const status = await finished(ai, "limited-pending");
    assert.equal(status.state, "SUCCEEDED");
    assert.match((status.result as { warnings: string[] }).warnings.join(""), /不能据此认定没有重复的待审候选/u);
  } finally { await ai.close(); await f.cleanup(); }
});

test("AI rewrite rejects credentials and link-only bodies without changing candidate bytes or writing a receipt", async () => {
  const f = await candidateFixture(); let bodyMarkdown = 'password="DO_NOT_ECHO"';
  const candidate = (await f.prepare("original", [content(conclusion)])).candidates[0]!;
  const before = (await f.service.list()).items[0]!;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ schemaVersion: 1, content: { title: "改稿", summary: "摘要", retrievalTerms: content().retrievalTerms, bodyMarkdown }, explanation: "修改" }) });
  try {
    for (const code of ["CONTENT_CONTAINS_SECRET", "CONTENT_DEPENDS_ON_LINKS"]) {
      await ai.rewrite({ ...selection(candidate, code), provider: "codex", instructions: "修改" });
      const status = await finished(ai, code);
      assert.equal(status.state, "FAILED"); assert.equal(status.error?.code, code);
      assert.doesNotMatch(JSON.stringify(status), /DO_NOT_ECHO/u);
      assert.equal(await f.service.receipt(code), undefined);
      assert.equal((await f.service.list()).items[0]!.bodyMarkdown, before.bodyMarkdown);
      assert.equal("frozen" in (await f.service.list()).items[0]!, false);
      bodyMarkdown = "参见 https://example.com/guide.md";
    }
  } finally { await ai.close(); await f.cleanup(); }
});

test("a publicly SUCCEEDED import immediately permits the next operation", async t => {
  const f = await candidateFixture();
  let release!: () => void, committed!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const receiptVisible = new Promise<void>(resolve => { committed = resolve; });
  const prepare = f.service.prepare.bind(f.service);
  t.mock.method(f.service, "prepare", async (...args: Parameters<typeof prepare>) => {
    const result = await prepare(...args);
    if (args[0] === "receipt-visible") { committed(); await paused; }
    return result;
  });
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => output() });
  try {
    await ai.import(batch("receipt-visible"));
    await receiptVisible;
    // Committed but not yet released: still RUNNING, never a SUCCEEDED that would reject the next import.
    assert.ok(await f.service.receipt("receipt-visible"));
    assert.equal((await ai.status("receipt-visible"))?.state, "RUNNING");
    assert.equal((await ai.import(batch("receipt-visible"))).state, "RUNNING");
    await assert.rejects(ai.import(batch("blocked-while-releasing")), { code: "AI_BUSY" });
    release();
    assert.equal((await finished(ai, "receipt-visible")).state, "SUCCEEDED");
    await assert.doesNotReject(ai.import(batch("next-after-success")));
    assert.equal((await finished(ai, "next-after-success")).state, "SUCCEEDED");
  } finally { release(); await ai.close(); await f.cleanup(); }
});

test("one batch invokes AI once, commits all candidates, and duplicate requests do not rerun; zero result survives restart", async () => {
  const f = await candidateFixture(); let calls = 0;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => { calls++; assert.match(input.prompt, /有增量/); assert.match(input.prompt, /知识内容模型/); assert.doesNotMatch(input.prompt, /knowledge-capture|KNOWLEDGE\.md|候选与确认/); assert.match(input.prompt, /第一份资料/u); assert.match(input.prompt, /第二份资料/u); return output(calls === 1 ? 2 : 0); } });
  try {
    assert.equal((await ai.import(batch("many"))).state, "RUNNING");
    assert.equal((await finished(ai, "many")).state, "SUCCEEDED");
    assert.equal((await f.service.list()).items.length, 2);
    assert.equal((await ai.import(batch("many"))).state, "SUCCEEDED"); assert.equal(calls, 1);
    await assert.rejects(ai.import({ ...batch("many"), instructions: "different" }), { code: "REQUEST_ID_CONFLICT" });
    await ai.import(batch("zero")); assert.equal((await finished(ai, "zero")).state, "SUCCEEDED");
    const restart = new AiService(f.service, { configPath: f.configPath, runner: async () => { throw new Error("must not run"); } });
    assert.deepEqual(await restart.status("zero"), await ai.status("zero"));
    assert.equal((await restart.status("uncommitted"))?.state, "NOT_COMMITTED");
    await restart.close();
  } finally { await ai.close(); await f.cleanup(); }
});

test("import preserves more than 32 sources and large Unicode content, while requiring complete source coverage", async () => {
  const f = await candidateFixture();
  const sources = Array.from({ length: 65 }, (_, index) => ({ name: `${index}.md`, content: index === 0 ? "资料".repeat(600_000) : `文件 ${index} 的资料` }));
  let calls = 0, omitLastSource = false;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    calls++;
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8")) as { sources: Array<{ content: string; sourceKey: string }> };
    assert.equal(payload.sources.length, sources.length);
    assert.equal(payload.sources[0]?.content, sources[0]?.content);
    assert.equal(payload.sources.at(-1)?.content, sources.at(-1)?.content);
    return { ...output(), candidates: [{ ...output().candidates[0], sourceKeys: payload.sources.map(source => source.sourceKey) }],
      sourceResults: payload.sources.slice(0, omitLastSource ? -1 : undefined).map(source => ({ sourceKey: source.sourceKey, explanation: "共同形成一条知识", pendingRef: null })) };
  } });
  try {
    const input = { ...batch("large-import"), sources };
    await ai.import(input);
    assert.equal((await finished(ai, input.requestId)).state, "SUCCEEDED");
    assert.equal((await f.service.list()).items.length, 1);
    const receipt = await f.service.receipt(input.requestId);
    assert.equal((receipt?.result as { sourceResults: unknown[] }).sourceResults.length, sources.length);
    assert.equal((await ai.import(input)).state, "SUCCEEDED"); assert.equal(calls, 1);
    omitLastSource = true;
    await ai.import({ ...input, requestId: "missing-large-source" });
    assert.equal((await finished(ai, "missing-large-source")).error?.code, "AI_OUTPUT_INVALID");
    assert.equal(await f.service.receipt("missing-large-source"), undefined);
    assert.equal((await f.service.list()).items.length, 1);
  } finally { await ai.close(); await f.cleanup(); }
});

test("empty or omitted targets auto-classify within known workspaces and accept Markdown extensions", async () => {
  const f = await candidateFixture(); let calls = 0;
  const before = await readFile(f.options.workspaceConfigPath);
  const ai = new AiService(f.service, { configPath: f.configPath, codexStatePath: "/must-not-read", runner: async input => {
    calls++;
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8"));
    assert.equal(payload.classification, "AUTO");
    assert.deepEqual(payload.targets.map((target: { scope: string; workspace?: string }) => [target.scope, target.workspace]), [["GLOBAL", undefined], ["WORKSPACE", "alpha"]]);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(f.root));
    return { ...output(), candidates: [{ ...output().candidates[0], targetKey: "1" }] };
  } });
  try {
    for (const [index, extension] of ["md", "markdown", "mdx"].entries()) {
      const input = { ...batch(`auto-${index}`), targets: index ? undefined : [], sources: batch("x").sources.map((source, position) => ({ ...source, name: `${position}.${extension}` })) };
      await ai.import(input); assert.equal((await finished(ai, input.requestId)).state, "SUCCEEDED");
      assert.equal((await ai.import(input)).state, "SUCCEEDED");
    }
    assert.equal(calls, 3);
    assert.equal((await f.service.list()).items.every(item => item.workspace === "alpha"), true);
    assert.deepEqual(await readFile(f.options.workspaceConfigPath), before);
  } finally { await ai.close(); await f.cleanup(); }
});

test("first import discovers Codex projects, preserves setup on failed generation and never commits invalid candidates", async () => {
  const f = await candidateFixture(); const statePath = join(f.root, "codex-state.json");
  await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  await writeFile(statePath, JSON.stringify({ "local-projects": { a: { name: "new-project", rootPaths: [f.root] } } }));
  let invalid = true;
  const ai = new AiService(f.service, { configPath: f.configPath, codexStatePath: statePath, runner: async input => {
    const payload = JSON.parse(await readFile(join(input.directory, "input.json"), "utf8"));
    assert.equal(payload.targets[1].workspace, "new-project");
    return { ...output(), candidates: [{ ...output().candidates[0], targetKey: invalid ? "invented-workspace" : "1" }] };
  } });
  try {
    await ai.import({ ...batch("invalid-auto"), targets: [] });
    assert.equal((await finished(ai, "invalid-auto")).state, "FAILED");
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.receipt("invalid-auto"), undefined);
    const config = JSON.parse(await readFile(f.options.workspaceConfigPath, "utf8"));
    assert.equal(config.workspaces[0].knowledgeAccess, undefined);
    invalid = false;
    await ai.import({ ...batch("valid-auto"), targets: [] });
    assert.equal((await finished(ai, "valid-auto")).state, "SUCCEEDED");
    assert.equal((await f.service.list()).items[0]?.workspace, "new-project");
  } finally { await ai.close(); await f.cleanup(); }
});

test("no saved projects stops automatic classification before AI, while explicit global remains usable", async () => {
  const f = await candidateFixture(); const statePath = join(f.root, "codex-state.json"); let calls = 0;
  await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  await writeFile(statePath, JSON.stringify({ "local-projects": {} }));
  const ai = new AiService(f.service, { configPath: f.configPath, codexStatePath: statePath, runner: async () => { calls++; return output(); } });
  try {
    await ai.import({ ...batch("no-project"), targets: [] });
    assert.equal((await finished(ai, "no-project")).error?.code, "CODEX_PROJECTS_EMPTY");
    assert.equal(calls, 0); assert.equal(await f.service.receipt("no-project"), undefined);
    await ai.import(batch("explicit-global"));
    assert.equal((await finished(ai, "explicit-global")).state, "SUCCEEDED");
    assert.equal(calls, 1);
  } finally { await ai.close(); await f.cleanup(); }
});

test("invalid coverage, unauthorized target, forged reference, extra field and truncated result commit nothing", async () => {
  const f = await candidateFixture();
  const bad = [ { ...output(), sourceResults: [] }, { ...output(), candidates: [{ ...output().candidates[0], targetKey: "9" }] },
    { ...output(), candidates: [{ ...output().candidates[0], existingAssetRef: "invented" }] }, { ...output(), approved: true }, "{truncated" ];
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => bad.shift() });
  try {
    for (let i = 0; i < 5; i++) { await ai.import(batch(`invalid-${i}`)); assert.equal((await finished(ai, `invalid-${i}`)).state, "FAILED"); assert.equal(await f.service.operation(`invalid-${i}`), undefined); }
    assert.equal((await f.service.list()).items.length, 0);
    await assert.rejects(ai.import({ ...batch("binary"), sources: [{ name: "a.md", content: "\0" }] }));
    await assert.rejects(ai.import({ ...batch("scope"), targets: [{ scope: "invented" }] }));
  } finally { await ai.close(); await f.cleanup(); }
});

test("rewrite runs without a database lock, preserves identity and returns changed content to pending", async () => {
  const f = await candidateFixture(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => { assert.match(input.prompt, /原文/u); entered(); await wait; return { schemaVersion: 1, content: { title: "改稿", summary: "修正摘要", retrievalTerms: content().retrievalTerms, bodyMarkdown: conclusion }, explanation: "补充条件" }; } });
  try {
    const candidate = (await f.prepare("prepare", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(candidate, "defer"), deferred: true });
    await ai.rewrite({ ...selection(candidate, "rewrite"), provider: "codex", instructions: "修正" }); await ready;
    assert.equal("frozen" in (await f.service.list()).items[0]!, false);
    await f.service.defer({ ...selection(candidate, "during-ai-defer"), deferred: false });
    await assert.rejects(ai.import(batch("busy")), { code: "AI_BUSY" });
    release(); assert.equal((await finished(ai, "rewrite")).state, "SUCCEEDED");
    await ai.close();
    const updated = (await f.service.list()).items[0]!;
    assert.equal(updated.candidateId, candidate.candidateId); assert.equal(updated.assetId, candidate.assetId);
    assert.equal(updated.status, "PENDING"); assert.equal("frozen" in updated, false);
    await assert.rejects(f.service.accept(selection(candidate, "stale-accept")), { code: "VERSION_CONFLICT" });
  } finally { release(); await ai.close(); await f.cleanup(); }
});

test("external edit during rewrite is preserved and no operation receipt is fabricated", async () => {
  const f = await candidateFixture();
  const candidate = (await f.prepare("prepare", [content()])).candidates[0]!;
  const item = (await f.service.list()).items[0]!;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => {
    await f.service.rewrite(selection(candidate, "concurrent-edit"), { title: item.title, summary: item.summary, retrievalTerms: item.retrievalTerms, bodyMarkdown: `${item.bodyMarkdown}\n外部编辑` });
    return { schemaVersion: 1, content: { title: "改稿", summary: "摘要", retrievalTerms: content().retrievalTerms, bodyMarkdown: conclusion }, explanation: "修改" };
  } });
  try {
    await ai.rewrite({ ...selection(candidate, "rewrite"), provider: "codex", instructions: "修改" });
    assert.equal((await finished(ai, "rewrite")).error?.code, "VERSION_CONFLICT");
    assert.equal(await f.service.operation("rewrite"), undefined);
    assert.match((await f.service.list()).items[0]!.bodyMarkdown, /外部编辑/u);
  } finally { await ai.close(); await f.cleanup(); }
});

test("import compares only allowed formal versions and revisions keep their exact identity and baseline", async () => {
  const f = await candidateFixture(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const a = (await f.prepare("formal-a", [content("GLOBAL_BASELINE")])).candidates[0]!;
  await f.service.accept(selection(a, "accept-a"));
  const privateAsset = (await f.prepare("formal-private", [{ ...content("PRIVATE_SCOPE_MUST_NOT_LEAK"), target: { scope: "WORKSPACE", workspace: "alpha" } }])).candidates[0]!;
  await f.service.accept(selection(privateAsset, "accept-private"));
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    assert.match(input.prompt, /GLOBAL_BASELINE/u); assert.doesNotMatch(input.prompt, /PRIVATE_SCOPE_MUST_NOT_LEAK/u);
    entered(); await wait;
    return { ...output(), candidates: [{ ...output().candidates[0], existingAssetRef: "0" }] };
  } });
  try {
    await ai.import(batch("revision")); await ready;
    const unrelated = (await f.prepare("unrelated", [{ ...content("another scope"), existingAssetId: privateAsset.assetId, baseVersion: privateAsset.version, target: { scope: "WORKSPACE", workspace: "alpha" } }])).candidates[0]!;
    await f.service.accept({ ...selection(unrelated, "unrelated-accept"), baseVersion: privateAsset.version });
    release(); assert.equal((await finished(ai, "revision")).state, "SUCCEEDED"); await ai.close();
    const revision = (await f.service.list()).items[0]!;
    assert.equal(revision.assetId, a.assetId); assert.notEqual(revision.candidateId, a.candidateId);
    assert.equal(revision.intent, "REVISION"); assert.equal(revision.baseVersion, a.version);
  } finally { release(); await ai.close(); await f.cleanup(); }
});

test("shutdown aborts generation, drops late output, preserves candidates and refuses new operations", async () => {
  const f = await candidateFixture(); let ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const candidate = (await f.prepare("prepare", [content()])).candidates[0]!;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => { ready(); await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true })); return { schemaVersion: 1, content: { title: "迟到", summary: "摘要", bodyMarkdown: "迟到结果" }, explanation: "修改" }; } });
  try {
    await ai.rewrite({ ...selection(candidate, "stopped"), provider: "codex", instructions: "修改" }); await entered; await ai.close();
    assert.equal((await ai.status("stopped"))?.state, "FAILED");
    assert.equal(await f.service.operation("stopped"), undefined);
    assert.equal((await f.service.list()).items[0]?.version, candidate.version);
    await f.service.reject(selection(candidate, "after-stop"));
    await assert.rejects(ai.import(batch("new")), { code: "AI_SHUTTING_DOWN" });
  } finally { await ai.close(); await f.cleanup(); }
});

test("Codex adapter verifies effective MCP disabling and passes only restricted invocation flags", async () => {
  const f = await candidateFixture();
  const executable = join(f.root, "mock-codex");
  const log = join(f.root, "args.jsonl");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
    if(a.includes('--help')) console.log('--ignore-rules --output-schema --output-last-message --ephemeral --sandbox');
    else if(a.includes('features')) console.log('hooks stable true\\nshell_tool stable true\\nplugins stable true');
    else {
      const servers=new Map([['write-server',{name:'write-server',enabled:true}]]);
      if(!a.includes('plugins')) servers.set('plugin-server',{name:'plugin-server',enabled:true});
      for(const arg of a.filter(value=>value.startsWith('mcp_servers.'))) {
        const [root,name,setting]=arg.split('.');
        if(!servers.has(name)||setting!=='enabled=false') { console.error('invalid transport'); process.exit(1); }
        servers.get(name).enabled=false;
      }
      if(a.includes('mcp')) console.log(JSON.stringify([...servers.values()]));
      else {
        if([...servers.values()].some(server=>server.enabled)) { console.error('MCP still enabled'); process.exit(1); }
        for await(const chunk of process.stdin){};
        fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({done:true}));
      }
    }
  `, { mode: 0o700 });
  try {
    assert.deepEqual(await runAiCli({ provider: { id: "codex", executable, timeoutMs: 2000 }, directory: f.root, signal: new AbortController().signal, schema: { type: "object" }, prompt: "资料" }), { done: true });
    const entries = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    const invocation = entries.at(-1)!;
    for (const flag of ["read-only", "--ignore-rules", "--ephemeral", "hooks", "shell_tool", "plugins", "notify=[]", 'web_search="disabled"', "mcp_servers.write-server.enabled=false"]) assert.ok(invocation.includes(flag), flag);
    const discoveries = entries.filter(args => args.includes("mcp"));
    assert.equal(discoveries.length, 2);
    assert.equal(discoveries.every(args => args.includes("plugins")), true);
    assert.equal(invocation.some(arg => arg.includes("plugin-server")), false);
    assert.equal(entries.filter(args => args.includes("exec") && !args.includes("--help")).length, 1);
    assert.equal(invocation.some(arg => arg.startsWith("model_reasoning_effort")), false);
    await mkdir(join(f.root, "effort"));
    assert.deepEqual(await runAiCli({ provider: { id: "codex", executable, model: "gpt-test", effort: "high", timeoutMs: 2000 }, directory: join(f.root, "effort"), signal: new AbortController().signal, schema: { type: "object" }, prompt: "资料" }), { done: true });
    const withEffort = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]).at(-1)!;
    assert.ok(withEffort.indexOf('model_reasoning_effort="high"') > -1 && withEffort.indexOf('model_reasoning_effort="high"') < withEffort.indexOf("exec"));
    assert.equal(withEffort[withEffort.indexOf("--model") + 1], "gpt-test");
  } finally { await f.cleanup(); }
});

test("Codex adapter stops before generation for unsupported MCP keys or ineffective disabling", async () => {
  const f = await candidateFixture();
  const executable = join(f.root, "mock-codex"), marker = join(f.root, "generated");
  try {
    for (const [name, code] of [["nested.server", "AI_CLI_UNSUPPORTED"], ["write-server", "AI_CLI_UNSAFE_CONFIG"]]) {
      await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';
        const a=process.argv.slice(2);
        if(a.includes('--help')) console.log('--ignore-rules --output-schema --output-last-message --ephemeral --sandbox');
        else if(a.includes('features')) console.log('hooks stable true\\nshell_tool stable true');
        else if(a.includes('mcp')) console.log(JSON.stringify([{name:${JSON.stringify(name)},enabled:true}]));
        else fs.writeFileSync(${JSON.stringify(marker)},'must not generate');
      `, { mode: 0o700 });
      await assert.rejects(runAiCli({ provider: { id: "codex", executable, timeoutMs: 2000 }, directory: f.root, signal: new AbortController().signal, schema: { type: "object" }, prompt: "资料" }), { code });
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  } finally { await f.cleanup(); }
});

test("CLI configuration failure exposes only a safe stage and reason, preserves candidate and leaves it editable", async () => {
  const f = await candidateFixture();
  const executable = join(f.root, "mock-codex");
  await writeFile(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);
    if(a.includes('--help')) console.log('--ignore-rules --output-schema --output-last-message --ephemeral --sandbox');
    else if(a.includes('features')) console.log('hooks stable true\\nshell_tool stable true');
    else if(a.includes('mcp')) { console.error('Error: failed to load bootstrap configuration\\ninvalid transport\\nSECRET_MUST_NOT_LEAK'); process.exit(1); }
    else process.exit(2);
  `, { mode: 0o700 });
  await writeFile(f.configPath, JSON.stringify({ providers: [{ id: "codex", executable, timeoutMs: 2000 }] }));
  const ai = new AiService(f.service, { configPath: f.configPath });
  try {
    const candidate = (await f.prepare("prepare", [content()])).candidates[0]!;
    await ai.rewrite({ ...selection(candidate, "cli-failure"), provider: "codex", instructions: "修改" });
    const status = await finished(ai, "cli-failure");
    assert.equal(status.state, "FAILED");
    assert.equal(status.error?.code, "AI_CLI_CONFIGURATION_INVALID");
    assert.match(status.error!.message, /MCP 服务发现/u);
    assert.match(status.error!.message, /传输配置无效/u);
    assert.doesNotMatch(JSON.stringify(status), /SECRET_MUST_NOT_LEAK/u);
    assert.equal(await f.service.receipt("cli-failure"), undefined);
    const current = (await f.service.list()).items[0]!;
    assert.equal(current.version, candidate.version);
    assert.equal("frozen" in current, false);
  } finally { await ai.close(); await f.cleanup(); }
});

test("owned process group is killed on timeout including a child that ignores SIGTERM", async () => {
  const f = await candidateFixture();
  const marker = join(f.root, "heartbeat");
  try {
    await assert.rejects(runProcess({ executable: process.execPath, directory: f.root, signal: new AbortController().signal, timeoutMs: 250,
      args: ["--input-type=module", "-e", `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),30);`)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`] }), { code: "AI_TIMEOUT" });
    const before = await readFile(marker, "utf8"); assert.ok(before.length > 0);
    await delay(100); assert.equal(await readFile(marker, "utf8"), before);
  } finally { await f.cleanup(); }
});

test("Claude adapter restricts tools, hooks and skills and rejects managed or unprovable authentication", { skip: process.platform !== "darwin" }, async () => {
  const f = await candidateFixture();
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.root;
  const executable = join(f.root, "mock-claude"), log = join(f.root, "claude-args.jsonl"), authPath = join(f.root, "auth.json");
  await writeFile(authPath, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }));
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';
    const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
    if(a.includes('--help')) console.log('--tools --strict-mcp-config --settings --json-schema --no-session-persistence --disallowedTools --disable-slash-commands'+(process.env.MOCK_EFFORT_HELP?' --effort':''));
    else if(a.includes('auth')) console.log(fs.readFileSync(${JSON.stringify(authPath)},'utf8'));
    else {for await(const chunk of process.stdin){};console.log(JSON.stringify({structured_output:{done:true}}));}
  `, { mode: 0o700 });
  let policyChecks = 0;
  const claudePolicy = { managedDirectory: join(f.root, "managed"), claudeDirectory: f.root, checkSystemPolicy: async () => { policyChecks++; } };
  const input = { provider: { id: "claude" as const, executable, timeoutMs: 2000 }, directory: f.root, signal: new AbortController().signal, schema: { type: "object" }, prompt: "资料", claudePolicy };
  try {
    assert.deepEqual(await runAiCli(input), { done: true });
    const entries = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    const invocation = entries.at(-1)!;
    for (const flag of ["--tools", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "mcp__*"]) assert.ok(invocation.includes(flag), flag);
    assert.equal(invocation[invocation.indexOf("--tools") + 1], "");
    assert.deepEqual(JSON.parse(invocation[invocation.indexOf("--settings") + 1]!), { disableAllHooks: true, autoMemoryEnabled: false });
    assert.equal(invocation[invocation.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.ok(policyChecks >= 2);
    assert.equal(invocation.includes("--effort"), false);
    // A requested effort is passed only when the CLI advertises the flag.
    const effortInput = { ...input, provider: { ...input.provider, effort: "max" } };
    await assert.rejects(runAiCli(effortInput), { code: "AI_CLI_UNSUPPORTED" });
    process.env.MOCK_EFFORT_HELP = "1";
    try { assert.deepEqual(await runAiCli(effortInput), { done: true }); } finally { delete process.env.MOCK_EFFORT_HELP; }
    const effortCall = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]).at(-1)!;
    assert.equal(effortCall[effortCall.indexOf("--effort") + 1], "max");
    for (const auth of [{ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" }, { loggedIn: true, authMethod: "oauth_token", subscriptionType: "pro" }]) {
      await writeFile(authPath, JSON.stringify(auth));
      await assert.rejects(runAiCli(input), { code: "AI_CLI_UNSAFE_CONFIG" });
    }
    await writeFile(join(f.root, "remote-settings.json"), "{}");
    assert.equal((await providerAvailability(input.provider, claudePolicy)).available, false);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(calls.filter(args => args.includes("-p")).length, 2);
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await f.cleanup();
  }
});
