import { createHash } from "node:crypto";
import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { compareRankedItems, type RankedSearchItem } from "../src/asset/search.js";
import { KnowledgeError, type RecallResult } from "../src/knowledge/model.js";
import { KnowledgeProjection } from "../src/knowledge/projection.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { CandidateService } from "../src/asset/candidate-service.js";
import { createAssetMcpServer } from "../src/mcp/tools.js";
import { handleCodexHook } from "../src/hook/user-prompt-submit.js";

const ids = new SnowflakeIdGenerator();
const rejectsWith = (code: string) => (error: unknown) => error instanceof KnowledgeError && error.code === code;
function assertBudget(result: RecallResult): void {
  assert.equal(result.budget.modelVisibleCharacters, Array.from(JSON.stringify(result)).length);
  assert.equal(result.budget.metadataCharacters + result.budget.knowledgeContentCharacters, result.budget.modelVisibleCharacters);
  assert.ok(result.budget.modelVisibleCharacters <= 5000);
  assert.ok(result.items.length <= 8);
}

async function fixture(t: TestContext) {
  const f = await knowledgeFixture();
  t.after(() => f.close());
  const seed = f.asset;
  async function asset(title: string, workspace: string | null = "alpha", body = "正文", summary = "摘要") {
    return seed({ title, workspace, body, summary });
  }
  return { ...f, ...f.options, asset };
}

test("usage and recall projections resolve current titles without dropping unavailable assets or changing historical facts", async t => {
  const f = await fixture(t);
  const asset = await f.asset("使用记录标题");

  const recall = await f.service.recall({ capabilityIds: [f.alpha], queries: ["使用记录标题"] });
  const initialRecall = (await f.projection.recall(recall.recallId!))!;
  assert.equal(initialRecall.items.length, 1);
  assert.equal(initialRecall.items[0]!.assetTitle, "使用记录标题");
  const read = await f.service.read({ capabilityIds: [f.alpha], assetId: asset.assetId });
  await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef });
  const initial = await f.projection.usage();
  assert.equal(initial.total, 2);
  assert.deepEqual(new Set(initial.items.map(item => item.kind)), new Set(["READ", "USED"]));
  assert.ok(initial.items.every(item => item.assetTitle === "使用记录标题" && item.assetWorkspace === "alpha"));
  assert.equal((await f.projection.usage(1, 1)).items[0]!.id, initial.items[1]!.id);
  assert.equal((await f.projection.usage(2, 1)).items.length, 0);
  f.revise(asset.assetId, { title: "更新后的标题" });
  const renamed = await f.projection.usage(0, 20, asset.assetId);
  const renamedRecall = (await f.projection.recall(recall.recallId!))!;
  assert.equal(renamedRecall.items[0]!.assetTitle, "更新后的标题");
  assert.deepEqual({ ...renamedRecall.items[0], assetTitle: "使用记录标题" }, initialRecall.items[0]);
  assert.ok(renamed.items.every(item => item.assetTitle === "更新后的标题"));
  assert.deepEqual(renamed.items.map(item => item.version), initial.items.map(item => item.version));
  f.remove(asset.assetId);
  const invalidRecall = (await f.projection.recall(recall.recallId!))!;
  assert.equal(invalidRecall.items[0]!.assetTitle, null);
  const removed = await f.projection.usage();
  assert.equal(removed.total, 2);
  assert.ok(removed.items.every(item => item.assetTitle === null));
  assert.deepEqual(removed.items.map(item => item.id), initial.items.map(item => item.id));
  const removedRecall = (await f.projection.recall(recall.recallId!))!;
  assert.deepEqual({ ...removedRecall.items[0], assetTitle: "使用记录标题" }, initialRecall.items[0]);
  assert.equal(removedRecall.items[0]!.assetTitle, null);
  assert.deepEqual(removedRecall.operation, initialRecall.operation);
});

test("OR expressions expand aliases while literal phrases, scope, and exact Chinese matching remain intact", async t => {
  const f = await fixture(t);
  const dict = await f.asset("业务字典");
  const config = await f.asset("DictConfig 字典配置");
  const table = await f.asset("sys_dict", null);
  await f.asset("业务字段新增规则");
  await f.asset("业务字典 字典配置 DictConfig sys_dict", "beta");

  const input = { capabilityIds: [f.alpha], queries: ["业务字典", "  DictConfig  ", "dictconfig", "字典配置", "sys_dict"] };
  const result = await f.service.recall(input);
  assert.deepEqual(result.queries, ["业务字典", "DictConfig", "字典配置", "sys_dict"]);
  assert.deepEqual(new Set(result.items.map(i => i.assetId)), new Set([dict.assetId, config.assetId, table.assetId]));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(f.projection.totals().recallOperations, 1);
  assert.equal(f.projection.totals().recallItems, 3);
  assert.deepEqual((await f.projection.recall(result.recallId!))!.operation.queries, result.queries);
  const row = f.projection.recalls().items[0]!;
  assert.deepEqual(row.queries, result.queries);
  assert.equal("query" in row || "queriesJson" in row, false);
  assertBudget(result);
  const global = await f.service.recall({ ...input, capabilityIds: [] });
  assert.deepEqual(global.items.map(i => i.assetId), [table.assetId]);
  const phrases = await f.service.recall({ capabilityIds: [f.alpha], queries: ["业务字典 DictConfig", "DictConfig   字典配置", "dictconfig 字典配置"] });
  assert.deepEqual(phrases.queries, ["业务字典 DictConfig", "DictConfig   字典配置", "dictconfig 字典配置"]);
  assert.deepEqual(phrases.items.map(i => i.assetId), [config.assetId]);
  assert.equal((await f.service.recall({ capabilityIds: [f.alpha], queries: ["业务字典|sys_dict"] })).items.length, 0);
});

test("Recall keeps spaces, punctuation and short expressions literal, even alongside successful long expressions", async t => {
  const f = await fixture(t);
  const phrase = await f.asset("Native Memories");
  const spaced = await f.asset("Native  Memories");
  const filename = await f.asset("KNOWLEDGE.md");
  const short = await f.asset("个人");
  const identifier = await f.asset("customer_fund_order", null);
  await f.asset("Native tools and shared Memories");
  await f.asset("Native", "alpha", "other topic", "Memories");
  await f.asset("KNOWLEDGEXmd customerXfundXorder");
  await f.asset("Native Memories KNOWLEDGE.md 个人", "beta");

  for (const [query, expected] of [
    ["Native Memories", phrase.assetId], ["Native  Memories", spaced.assetId],
    ["KNOWLEDGE.md", filename.assetId], ["个人", short.assetId],
    ["customer_fund_order", identifier.assetId],
  ]) {
    const result = await f.service.recall({ capabilityIds: [f.alpha], queries: [query!] });
    assert.deepEqual(result.items.map(i => i.assetId), [expected]);
    assertBudget(result);
  }
  const result = await f.service.recall({ capabilityIds: [f.alpha], queries: ["Native Memories", "个人", "KNOWLEDGE.md", "customer_fund_order"] });
  assert.deepEqual(new Set(result.items.map(i => i.assetId)), new Set([phrase.assetId, short.assetId, filename.assetId, identifier.assetId]));
  assertBudget(result);
  const normalized = await f.service.recall({ capabilityIds: [f.alpha], queries: [" Native Memories ", "native memories", "Native  Memories"] });
  assert.deepEqual(normalized.queries, ["Native Memories", "Native  Memories"]);
  assert.deepEqual((await f.projection.recall(normalized.recallId!))!.operation.queries, normalized.queries);
  // The human library's existing word search is a separate contract.
  assert.ok((await f.search.listLibrary({ query: "Native Memories", workspace: "alpha" })).items.length > normalized.items.length);
});

test("query operators and wildcard characters are literal data, never a Recall language", async t => {
  const f = await fixture(t);
  for (const query of ['a|b', 'a AND b', 'a OR b', 'a NOT b', '"quoted"', 'asset*read', 'a_b', 'a%b', '(a)', '[a]', 'a\\b']) {
    const exact = await f.asset(query);
    await f.asset("a b AND OR NOT quoted assetZZread aXb", "beta");

    const result = await f.service.recall({ capabilityIds: [f.alpha], queries: [query] });
    assert.deepEqual(result.items.map(i => i.assetId), [exact.assetId], query);
    assertBudget(result);
  }
});

test("fixed-corpus ablation separates query rewriting, literal phrases, and split-OR noise", async t => {
  const f = await fixture(t);
  const file = await f.asset("KNOWLEDGE.md");
  const native = await f.asset("Native Memories");
  const protocol = await f.asset("接入协议");
  const rules = await f.asset("全局规则");
  const person = await f.asset("个人", "alpha", "工作准则");
  const scattered = await f.asset("Native tools with independent Memories");
  const fragment = await f.asset("Native unrelated tooling");
  const irrelevant = await f.asset("园艺记录", "alpha", "个人种花经历");
  await f.asset("KNOWLEDGE.md Native Memories 接入协议 全局规则 个人", "beta");

  const original = ["个人", "接入协议", "KNOWLEDGE.md", "Native Memories", "全局规则"];
  // search() intentionally retains the pre-change AND semantics for human
  // search. Compare complete eligible candidate sets here, without truncation.
  async function oldCandidates(queries: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    for (const query of queries) for (const item of await f.search.search({ context: { authorizedWorkspaces: ["alpha"] }, query, limit: 100 })) result.add(item.assetId);
    return result;
  }
  const a = await oldCandidates(["个人 工作准则", "接入 协议", "AGENTS KNOWLEDGE", "接入 验收"]);
  const b = await oldCandidates(original);
  const c = await f.service.recall({ capabilityIds: [f.alpha], queries: original });
  const d = await f.service.recall({ capabilityIds: [f.alpha], queries: original.flatMap(q => q.split(" ")) });
  assert.deepEqual(a, new Set([person.assetId, protocol.assetId]));
  assert.deepEqual(b, new Set([file.assetId, native.assetId, protocol.assetId, rules.assetId, person.assetId, irrelevant.assetId, scattered.assetId]));
  const required = [file.assetId, native.assetId, protocol.assetId, rules.assetId, person.assetId];
  assert.deepEqual(new Set(c.items.map(i => i.assetId)), new Set([...required, irrelevant.assetId]));
  assert.deepEqual(new Set(d.items.map(i => i.assetId)), new Set([...required, irrelevant.assetId, scattered.assetId, fragment.assetId]));
  assertBudget(c); assertBudget(d);
  assert.ok(c.items.findIndex(i => i.assetId === file.assetId) < c.items.findIndex(i => i.assetId === irrelevant.assetId));
  t.diagnostic("Isolated fixture: A rewritten/AND candidates 2 (required 2/5); B original/AND candidates 7 (5/5); C original/literal delivered 6 (5/5); D split-OR delivered 8 (5/5). C/D share the real 8-item/5000-character budget; A/B compare untruncated candidates only.");
});

test("one asset uses its best existing rank, with no synonym score accumulation or expression-order bias", async t => {
  const f = await fixture(t);
  const strong = await f.asset("DictConfig");
  const weak = await f.asset("普通说明", "alpha", "业务字典 字典配置 DictConfig sys_dict");
  await f.asset("字典配置");

  const queries = ["业务字典", "dictconfig", "字典配置", "sys_dict"];
  const ranks = new Map<string, RankedSearchItem>();
  for (const query of queries) for (const rank of await f.search.rankedCandidates({ authorizedWorkspaces: ["alpha"] }, query)) {
    if (!ranks.has(rank.assetId) || compareRankedItems(rank, ranks.get(rank.assetId)!) < 0) ranks.set(rank.assetId, rank);
  }
  const expected = [...ranks.values()].sort(compareRankedItems).map(i => i.assetId);
  assert.ok(expected.indexOf(strong.assetId) < expected.indexOf(weak.assetId));
  for (const expressions of [queries, [...queries].reverse(), [...queries, "DICTCONFIG"]]) {
    const result = await f.service.recall({ capabilityIds: [f.alpha], queries: expressions });
    assert.deepEqual(result.items.map(i => i.assetId), expected);
    assertBudget(result);
  }
});

test("single-expression Recall uses short literal or whole-expression FTS routes", async t => {
  const f = await fixture(t);
  const a = await f.asset("Spring 事务", "alpha", 'ID 锁 "quoted" asset*read');
  await f.asset("业务字典", null);

  for (const query of ["ID", "锁", "Spring 事务", '"quoted"', "asset*read"]) {
    const expected = await f.search.rankedCandidates({ authorizedWorkspaces: ["alpha"] }, query);
    const result = await f.service.recall({ capabilityIds: [f.alpha], queries: [query] });
    assert.deepEqual(result.items.map(i => i.assetId), expected.map(i => i.assetId));
    assert.deepEqual(result.items.map(i => i.assetId), [a.assetId]);
  }
});

test("strict input rejects old query, empty/oversized arrays, control characters, and authority overrides before usage", async t => {
  const f = await fixture(t);
  const base = { capabilityIds: [], queries: ["业务字典"] };
  for (const input of [
    { capabilityIds: [], query: "业务字典" }, { ...base, query: "旧字段" }, { ...base, queries: [] },
    { ...base, queries: [""] }, { ...base, queries: ["   "] }, { ...base, queries: "业务字典" },
    { ...base, queries: ["x".repeat(257)] }, { ...base, queries: Array(9).fill("x") },
    { ...base, queries: ["a\nb"] }, { ...base, queries: ["a\u0000b"] }, { ...base, workspace: "alpha" },
  ]) await assert.rejects(f.service.recall(input), rejectsWith("INPUT_INVALID"));
  assert.equal(f.projection.totals().recallOperations, 0);
  const result = await f.service.recall({ ...base, queries: Array.from({ length: 8 }, (_, i) => `${i}${'"'.repeat(255)}`) });
  assert.equal(result.queries.length, 8);
  assertBudget(result);
});

test("all submitted capabilities must remain valid; configuration changes and revocation still reject the whole request", async t => {
  const f = await fixture(t);
  await f.asset("业务字典"); await f.asset("sys_dict", "beta");
  const input = { capabilityIds: [f.alpha, f.beta], queries: ["业务字典", "sys_dict"] };
  const result = await f.service.recall(input);
  assert.deepEqual(result.authorizedWorkspaces, ["alpha", "beta"]);
  assert.equal(result.items.length, 2);
  await writeFile(f.workspaceConfigPath, JSON.stringify({ ...f.config, workspaces: [f.config.workspaces[0], { name: "beta", paths: ["/changed/beta"] }] }));
  await assert.rejects(f.service.recall(input), rejectsWith("CAPABILITY_INVALID"));
  await writeFile(f.workspaceConfigPath, JSON.stringify(f.config));
  f.repository.revokeCapability(createHash("sha256").update(f.beta).digest("hex"));
  await assert.rejects(f.service.recall(input), rejectsWith("CAPABILITY_INVALID"));
  assert.equal(f.projection.totals().recallOperations, 1);
});

test("all expressions share eight ranked slots, deduplication and one response budget", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) await f.asset(`检索 ${i}`, "alpha", i % 2 ? "alphaquery betaquery" : "betaquery");

  const result = await f.service.recall({ capabilityIds: [f.alpha], queries: ["alphaquery", "betaquery"] });
  assert.equal(result.items.length, 8);
  assert.equal(result.budget.omittedCount, 3);
  assert.equal(new Set(result.items.map(i => i.assetId)).size, 8);
  assert.ok(result.diagnostics.includes("ASSET_LIMIT"));
  assertBudget(result);
});

test("large expression metadata and summaries stay within the shared budget, including write-failure delivery", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) await f.asset(`dictionary ${i}`, "alpha", "内容", "长摘要😀".repeat(300));

  const input = { capabilityIds: [f.alpha], queries: ["dictionary", ...Array.from({ length: 7 }, (_, i) => `${i}${'"'.repeat(255)}`)] };
  const result = await f.service.recall(input);
  assertBudget(result);
  assert.ok(result.diagnostics.includes("CHARACTER_LIMIT"));
  assert.ok(result.diagnostics.includes("BUDGET_DOWNGRADED"));
  assert.ok(result.items.length > 0 && result.items.length < 8);
  const totals = f.projection.totals();
  f.repository.db.exec("CREATE TRIGGER fail_recall_item BEFORE INSERT ON recall_item BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const failed = await f.service.recall(input);
  assertBudget(failed);
  assert.equal(failed.usageRecorded, false); assert.equal(failed.recallId, null);
  assert.ok(failed.items.every(i => i.recallItemId === null && i.reference.includes("expectedVersion")));
  assert.ok(failed.diagnostics.includes("USAGE_WRITE_FAILED"));
  assert.deepEqual(f.projection.totals(), totals);
  f.repository.db.exec("DROP TRIGGER fail_recall_item");
  assert.equal((await f.service.recall(input)).usageRecorded, true);
});

test("current database qualification, version-bound Read, and idempotent Used survive multi-expression delivery", async t => {
  const f = await fixture(t);
  const asset = await f.asset("业务字典 DictConfig");
  const removed = await f.asset("sys_dict");
  const linked = await f.asset("字典配置");

  f.remove(removed.assetId); f.remove(linked.assetId);
  const result = await f.service.recall({ capabilityIds: [f.alpha], queries: ["业务字典", "dictconfig", "sys_dict", "字典配置"] });
  assert.deepEqual(result.items.map(i => i.assetId), [asset.assetId]);
  const recallItemId = result.items[0]!.recallItemId!;
  const read = await f.service.read({ capabilityIds: [f.alpha], recallItemId });
  f.revise(asset.assetId, { bodyMarkdown: "更新正文\n" });
  await assert.rejects(f.service.read({ capabilityIds: [f.alpha], recallItemId }), rejectsWith("CONTENT_CHANGED"));
  assert.equal((await f.service.used({ capabilityIds: [f.alpha], recallItemId })).created, true);
  assert.equal((await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef })).created, false);
  assert.deepEqual(f.repository.summarizeByAsset(asset.assetId), { recallCount: 1, readCount: 1, totalUsedCount: 1 });
});

test("MCP publishes an object-root queries array and returns one serialized result; Hook delegates parameter semantics to MCP", async t => {
  const f = await fixture(t);
  const asset = await f.asset("Native Memories");
  await f.asset("Native tooling and unrelated Memories");

  const server = createAssetMcpServer({ knowledgeService: f.service, candidateService: new CandidateService(f), capabilities: f.capabilities });
  const client = new Client({ name: "multi-expression-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const definitions = (await client.listTools()).tools;
  assert.deepEqual(definitions.map(tool => tool.name).sort(), ["asset_mark_used", "asset_read", "candidate_prepare", "candidate_update", "knowledge_recall"]);
  const definition = definitions.find(tool => tool.name === "knowledge_recall")!;
  assert.deepEqual(Object.keys(definition.inputSchema.properties!).sort(), ["capabilityIds", "queries"]);
  assert.equal(definition.inputSchema.type, "object");
  assert.ok(definition.inputSchema.required!.includes("queries"));
  assert.equal("query" in definition.inputSchema.properties!, false);
  const schema = definition.inputSchema.properties!.queries as { type: string; minItems: number; maxItems: number };
  assert.deepEqual([schema.type, schema.minItems, schema.maxItems], ["array", 1, 8]);
  const response = await client.callTool({ name: "knowledge_recall", arguments: { capabilityIds: [f.alpha], queries: ["业务字典", "Native Memories"] } });
  assert.equal(response.isError, undefined); assert.equal(response.structuredContent, undefined);
  assert.ok(Array.isArray(response.content)); assert.equal(response.content.length, 1);
  const block = response.content[0] as { type: string; text: string };
  assert.equal(block.type, "text");
  const result = JSON.parse(block.text) as RecallResult;
  assert.deepEqual(result.items.map(i => i.assetId), [asset.assetId]); assertBudget(result);
  const rejected = await client.callTool({ name: "knowledge_recall", arguments: { capabilityIds: [f.alpha], query: "dictconfig" } });
  assert.equal(rejected.isError, true);
  assert.equal(f.projection.totals().recallOperations, 1);
  const hook = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: join(f.root, "alpha") }, f);
  assert.ok(hook?.includes("knowledge_recall")); assert.ok(!hook?.includes("queries"));
  const captureHook = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: join(f.root, "alpha"), session_id: "synthetic-session", turn_id: "synthetic-turn" }, { ...f, captureCommand: "/synthetic/capture --record" });
  const context = JSON.parse(captureHook!).hookSpecificOutput.additionalContext as string;
  assert.ok(context.includes('"sessionId":"synthetic-session"'));
  assert.ok(context.includes('"turnId":"synthetic-turn"'));
  assert.ok(context.includes("cat <<'EOF' | /synthetic/capture --record"));
  const missingIdentity = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: join(f.root, "alpha") }, { ...f, captureCommand: "/synthetic/capture --record" });
  assert.match(missingIdentity!, /评估标识或命令缺失/);
});
