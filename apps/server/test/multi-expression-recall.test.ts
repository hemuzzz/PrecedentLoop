import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { AssetCatalog, AssetIndexManager, AssetSearchService } from "../src/asset/index.js";
import { AssetContentVersionRepository } from "../src/asset/content-version.js";
import { compareRankedItems, type RankedSearchItem } from "../src/asset/search.js";
import { KnowledgeError, type RecallResult } from "../src/knowledge/model.js";
import { KnowledgeProjection } from "../src/knowledge/projection.js";
import { KnowledgeRepository, migrateKnowledge, migrateRecallStorage } from "../src/knowledge/repository.js";
import { createLegacyRecallDatabase } from "../test-support/legacy-recall-fixture.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { CandidateService } from "../src/asset/candidate-service.js";
import { createAssetMcpServer } from "../src/mcp/tools.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
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
  const root = await mkdtemp(join(tmpdir(), "codex-multi-recall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, "data", "knowledge.sqlite"), repositoryPath: join(root, "repository"), workspaceConfigPath: join(root, "workspaces.json") };
  await mkdir(join(options.repositoryPath, "assets"), { recursive: true });
  const config = { schemaVersion: 1, workspaces: [
    { name: "alpha", paths: ["/workspace/alpha"] }, { name: "beta", paths: ["/workspace/beta"] },
  ] };
  await writeFile(options.workspaceConfigPath, JSON.stringify(config));
  const content = new AssetContentVersionRepository(options.databasePath); content.close();
  const manager = await AssetIndexManager.create(options);
  migrateKnowledge(options.databasePath);
  migrateRecallStorage(options.databasePath);
  const repository = new KnowledgeRepository(options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, options.workspaceConfigPath);
  // Synthetic host input in an isolated fixture; not evidence of Desktop issuance.
  const alpha = (await capabilities.issueFromTrustedHost("/workspace/alpha"))[0]!.capabilityId;
  const beta = (await capabilities.issueFromTrustedHost("/workspace/beta"))[0]!.capabilityId;
  const search = new AssetSearchService({ ...options, refreshIndex: async () => { await manager.synchronize(); } });
  const service = new KnowledgeService(repository, capabilities, search, () => {});
  const projection = new KnowledgeProjection(repository, capabilities, options);
  t.after(async () => { search.close(); repository.close(); await manager.close(); });
  async function asset(title: string, workspace: string | null = "alpha", body = "正文", summary = "摘要") {
    const assetId = ids.next("ast");
    const path = join(options.repositoryPath, "assets", workspace ? `workspaces/${workspace}` : "global", "memories", `${assetId}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, ["---", `id: ${assetId}`, "type: MEMORY", `scope: ${workspace ? "WORKSPACE" : "GLOBAL"}`,
      ...(workspace ? [`workspace: ${workspace}`] : []), `title: ${JSON.stringify(title)}`, `summary: ${JSON.stringify(summary)}`, "---", body, ""].join("\n"));
    return { assetId, path };
  }
  return { ...options, config, root, manager, repository, capabilities, search, service, projection, alpha, beta, asset };
}

test("usage and recall projections resolve current titles without dropping unavailable assets or changing historical facts", async t => {
  const f = await fixture(t);
  const asset = await f.asset("使用记录标题");
  await f.manager.synchronize();
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
  await writeFile(asset.path, (await readFile(asset.path, "utf8")).replace("使用记录标题", "更新后的标题"));
  const renamed = await f.projection.usage(0, 20, asset.assetId);
  const renamedRecall = (await f.projection.recall(recall.recallId!))!;
  assert.equal(renamedRecall.items[0]!.assetTitle, "更新后的标题");
  assert.deepEqual({ ...renamedRecall.items[0], assetTitle: "使用记录标题" }, initialRecall.items[0]);
  assert.ok(renamed.items.every(item => item.assetTitle === "更新后的标题"));
  assert.deepEqual(renamed.items.map(item => item.contentHash), initial.items.map(item => item.contentHash));
  await writeFile(asset.path, (await readFile(asset.path, "utf8")).replace("更新后的标题", ""));
  const invalidRecall = (await f.projection.recall(recall.recallId!))!;
  assert.equal(invalidRecall.items[0]!.assetTitle, null);
  await rm(asset.path);
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
  await f.manager.synchronize();
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
  await f.manager.synchronize();
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
    await f.manager.synchronize();
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
  await f.manager.synchronize();
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
  await f.manager.synchronize();
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
  await f.manager.synchronize();
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
  await f.asset("业务字典"); await f.asset("sys_dict", "beta"); await f.manager.synchronize();
  const input = { capabilityIds: [f.alpha, f.beta], queries: ["业务字典", "sys_dict"] };
  const result = await f.service.recall(input);
  assert.deepEqual(result.authorizedWorkspaces, ["alpha", "beta"]);
  assert.equal(result.items.length, 2);
  await writeFile(f.workspaceConfigPath, JSON.stringify({ ...f.config, workspaces: [f.config.workspaces[0], { name: "beta", paths: ["/changed/beta"] }] }));
  await assert.rejects(f.service.recall(input), rejectsWith("CAPABILITY_INVALID"));
  await writeFile(f.workspaceConfigPath, JSON.stringify(f.config));
  f.repository.db.prepare("DELETE FROM workspace_capability WHERE capability_key_hash=?").run(createHash("sha256").update(f.beta).digest("hex"));
  await assert.rejects(f.service.recall(input), rejectsWith("CAPABILITY_INVALID"));
  assert.equal(f.projection.totals().recallOperations, 1);
});

test("all expressions share eight ranked slots, deduplication and one response budget", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) await f.asset(`检索 ${i}`, "alpha", i % 2 ? "alphaquery betaquery" : "betaquery");
  await f.manager.synchronize();
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
  await f.manager.synchronize();
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
  assert.ok(failed.items.every(i => i.recallItemId === null && i.reference.includes("expectedContentHash")));
  assert.ok(failed.diagnostics.includes("USAGE_WRITE_FAILED"));
  assert.deepEqual(f.projection.totals(), totals);
  f.repository.db.exec("DROP TRIGGER fail_recall_item");
  assert.equal((await f.service.recall(input)).usageRecorded, true);
});

test("current file qualification, hash-bound Read, and idempotent Used survive multi-expression delivery", async t => {
  const f = await fixture(t);
  const asset = await f.asset("业务字典 DictConfig");
  const removed = await f.asset("sys_dict");
  const linked = await f.asset("字典配置");
  await f.manager.synchronize();
  const raw = await readFile(linked.path);
  await rm(removed.path); await rm(linked.path);
  const outside = join(f.root, "outside.md"); await writeFile(outside, raw); await symlink(outside, linked.path);
  const result = await f.service.recall({ capabilityIds: [f.alpha], queries: ["业务字典", "dictconfig", "sys_dict", "字典配置"] });
  assert.deepEqual(result.items.map(i => i.assetId), [asset.assetId]);
  const recallItemId = result.items[0]!.recallItemId!;
  const read = await f.service.read({ capabilityIds: [f.alpha], recallItemId });
  await writeFile(asset.path, (await readFile(asset.path, "utf8")) + "更新正文\n");
  await assert.rejects(f.service.read({ capabilityIds: [f.alpha], recallItemId }), rejectsWith("CONTENT_CHANGED"));
  assert.equal((await f.service.used({ capabilityIds: [f.alpha], recallItemId })).created, true);
  assert.equal((await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef })).created, false);
  assert.deepEqual(f.repository.summarizeByAsset(asset.assetId), { recallCount: 1, readCount: 1, totalUsedCount: 1 });
});

test("MCP publishes an object-root queries array and returns one serialized result; Hook delegates parameter semantics to MCP", async t => {
  const f = await fixture(t);
  const asset = await f.asset("Native Memories");
  await f.asset("Native tooling and unrelated Memories");
  await f.manager.synchronize();
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
  const hook = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: "/workspace/alpha" }, f);
  assert.ok(hook?.includes("knowledge_recall")); assert.ok(!hook?.includes("queries"));
  const captureHook = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: "/workspace/alpha", session_id: "synthetic-session", turn_id: "synthetic-turn" }, { ...f, captureCommand: "/synthetic/capture --record" });
  const context = JSON.parse(captureHook!).hookSpecificOutput.additionalContext as string;
  assert.ok(context.includes('"sessionId":"synthetic-session"'));
  assert.ok(context.includes('"turnId":"synthetic-turn"'));
  assert.ok(context.includes("cat <<'EOF' | /synthetic/capture --record"));
  const missingIdentity = await handleCodexHook({ hook_event_name: "UserPromptSubmit", cwd: "/workspace/alpha" }, { ...f, captureCommand: "/synthetic/capture --record" });
  assert.match(missingIdentity!, /评估标识或命令缺失/);
});

test("offline schema 2/3/4 upgrade preserves queries, operation identities, content and references", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-query-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of [2, 3, 4] as const) {
    const path = join(root, `${version}.sqlite`);
    createLegacyRecallDatabase(path, version);
    const catalog = new AssetCatalog(path); catalog.close();
    const db = new Database(path); t.after(() => db.close());
    db.exec("INSERT INTO asset_catalog VALUES ('ast1','MEMORY','GLOBAL',NULL,'DictConfig','summary','assets/global/memories/ast1.md','hash',12,'2026-09-08','2026-09-08'); INSERT INTO asset_fts(rowid,title,summary,body) VALUES (1,'DictConfig','summary','preserved body')");
    const originals = ['业务字典|DictConfig', '["a","b"]', 'a"b\\c', "  历史\n表达😀  "];
    originals.forEach((query, i) => db.prepare("INSERT INTO recall_operation VALUES (?, '[]', ?, '[]', NULL, '2026-09-08', '[]', '{}')").run(`usg${i + 1}`, version === 4 ? JSON.stringify([query]) : query));
    const expressions = originals.map(query => [query]);
    if (version === 4) {
      expressions[0] = [originals[0]!, "DictConfig", "业务字典"];
      db.prepare("UPDATE recall_operation SET queries_json=? WHERE recall_id='usg1'").run(JSON.stringify(expressions[0]));
    }
    db.prepare("UPDATE recall_operation SET diagnostics_json=?, budget_json=? WHERE recall_id='usg1'").run(
      JSON.stringify(["CHARACTER_LIMIT", "POLICY_UNAVAILABLE", "SCENARIO_SKIPPED", "POLICYX_RESERVED"]),
      JSON.stringify({ deliveredAssets: 1, modelVisibleCharacters: 4321, directBucketAssets: 0, queryBucketAssets: 1 }));
    db.exec("INSERT INTO workspace_capability VALUES ('digest','alpha','2026-09-08','mapping'); INSERT INTO recall_item VALUES ('usg10','usg1','ast1','hash','GLOBAL',NULL,'[\"QUERY_MATCH\"]','QUERY',NULL,'ON_DEMAND','[]',0); INSERT INTO read_operation VALUES ('usg11','[]','ast1','hash','GLOBAL',NULL,'usg10','2026-09-08'); INSERT INTO used_event VALUES ('usg12','[]','usg10',NULL,'ast1','2026-09-08')");
    for (const status of ["CURRENT", "PREVIOUS"]) db.prepare("INSERT INTO asset_content_version VALUES ('ast1',?,?,?,'2026-09-08')").run(status, Buffer.from(status), createHash("sha256").update(status).digest("hex"));
    const tables = ["workspace_capability", "read_operation", "used_event", "asset_content_version", "asset_catalog"];
    const preserved = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const preservedFts = db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH 'DictConfig'").all();
    const itemColumns = "recall_item_id,recall_id,asset_id,content_hash,asset_scope,asset_workspace,delivered_mode,delivery_reasons_json,ordinal";
    const preservedItems = db.prepare(`SELECT ${itemColumns} FROM recall_item`).all();
    const operationColumns = "recall_id,authorized_workspaces_json,occurred_at";
    const preservedOperations = db.prepare(`SELECT ${operationColumns} FROM recall_operation ORDER BY recall_id`).all();
    assert.throws(() => new KnowledgeRepository(path), rejectsWith("KNOWLEDGE_MIGRATION_REQUIRED"));
    assert.equal(db.pragma("user_version", { simple: true }), version);
    migrateRecallStorage(path); migrateRecallStorage(path);
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    const rows = db.prepare<[], { queries_json: string }>("SELECT queries_json FROM recall_operation ORDER BY recall_id").all();
    assert.deepEqual(rows.map(row => JSON.parse(row.queries_json) as string[]), expressions);
    assert.deepEqual(db.prepare(`SELECT ${operationColumns} FROM recall_operation ORDER BY recall_id`).all(), preservedOperations);
    const metadata = db.prepare<[], { diagnostics_json: string; budget_json: string }>(
      "SELECT diagnostics_json,budget_json FROM recall_operation WHERE recall_id='usg1'").get()!;
    assert.deepEqual(JSON.parse(metadata.diagnostics_json), ["CHARACTER_LIMIT", "POLICYX_RESERVED"]);
    assert.deepEqual(JSON.parse(metadata.budget_json), { deliveredAssets: 1, modelVisibleCharacters: 4321 });
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), preserved);
    assert.deepEqual(db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH 'DictConfig'").all(), preservedFts);
    assert.equal(preservedFts.length, 1);
    assert.deepEqual(db.prepare(`SELECT ${itemColumns} FROM recall_item`).all(), preservedItems);
    assert.deepEqual(db.prepare("PRAGMA table_info(recall_item)").all().map(row => (row as { name: string }).name), itemColumns.split(","));
    assert.deepEqual(db.prepare("PRAGMA table_info(recall_operation)").all().map(row => (row as { name: string }).name),
      ["recall_id", "authorized_workspaces_json", "queries_json", "occurred_at", "diagnostics_json", "budget_json"]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const repository = new KnowledgeRepository(path); repository.close();
    const content = new AssetContentVersionRepository(path); content.close();
    assert.equal(migrateKnowledge(path), 5); assert.equal(migrateKnowledge(path, true), 5);
  }
});

test("migration failure rolls back schema and data; CLI requires explicit offline mode and can retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-query-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "knowledge.sqlite"); createLegacyRecallDatabase(path, 2);
  const db = new Database(path); t.after(() => db.close());
  db.pragma("foreign_keys=OFF");
  db.exec("INSERT INTO read_operation VALUES ('usg1','[]','ast1','hash','GLOBAL',NULL,'usg404','2026-09-08')");
  assert.throws(() => migrateRecallStorage(path), rejectsWith("KNOWLEDGE_SCHEMA_INVALID"));
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  assert.doesNotThrow(() => db.prepare("SELECT query FROM recall_operation").all());
  assert.throws(() => db.prepare("SELECT queries_json FROM recall_operation").all());
  db.exec("DELETE FROM read_operation");
  const stdout = new PassThrough(), stderr = new PassThrough();
  let output = "", errors = ""; stdout.on("data", chunk => { output += String(chunk); }); stderr.on("data", chunk => { errors += String(chunk); });
  const env = { PRECEDENT_LOOP_DATABASE_PATH: path };
  assert.equal(await runMaintenanceCli(["migrate-recall"], env, stdout, stderr), 1);
  assert.ok(errors.includes("--offline")); assert.equal(db.pragma("user_version", { simple: true }), 2);
  assert.equal(await runMaintenanceCli(["migrate-recall", "--offline"], env, stdout, stderr), 0);
  assert.deepEqual(JSON.parse(output), { ok: true, schemaVersion: 5 });
  db.pragma("user_version=99");
  assert.throws(() => migrateRecallStorage(path), rejectsWith("KNOWLEDGE_SCHEMA_UNSUPPORTED"));
  assert.equal(db.pragma("user_version", { simple: true }), 99);
});
