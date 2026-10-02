import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import { retrievalTermsSchema, storedRetrievalTermsSchema } from "../src/asset/schema.js";
import { checkStructuredContent } from "../src/asset/structured-candidate-checks.js";
import { candidatePrepareInputSchema, candidateUpdateInputSchema, prepareStructuredCandidate, updateStructuredCandidate } from "../src/asset/structured-candidate.js";
import { AssetRepository, type NewAsset } from "../src/asset/asset-repository.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { CandidateService } from "../src/asset/candidate-service.js";
import { AssetDiffService } from "../src/asset/content-diff.js";
import { AssetSearchService } from "../src/asset/search.js";
import { AiService, type BackfillTermsResult } from "../src/ai/service.js";
import { BASELINE_SCHEMA_SQL, openDatabase } from "../src/storage/schema.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { candidateFixture, selection } from "../test-support/candidate-fixture.js";

const terms = ["RetrievalTerms", "检索词补齐", "asset_fts"];
test("retrieval terms reject sentence punctuation but allow spaces and internal dots", () => {
  for (const punctuation of ["。", "！", "？", "；", "，", "、", ";", "!", "?"]) {
    const result = retrievalTermsSchema.safeParse([`word${punctuation}word`, "中文", "接口"]);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /整句/);
  }
  assert.equal(storedRetrievalTermsSchema.safeParse(["file.ts. "]).success, false);
  assert.deepEqual(retrievalTermsSchema.parse(["Native Memories", "file.ts", "中文检索词"]), ["Native Memories", "file.ts", "中文检索词"]);
});
const memory = { capabilityIds: [], type: "MEMORY", title: "检索词补齐边界", summary: "仅填补空检索词",
  retrievalTerms: terms, conclusion: "存量检索词补齐只能更新空列表，并保持正文、版本和上一版内容不变。",
  conditions: "临时隔离数据库", verified: "隔离数据库中的自动化验证" };
async function finished(ai: AiService, requestId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = await ai.status(requestId);
    if (status?.state !== "RUNNING") { assert.ok(status); return status; }
    await delay(10);
  }
  throw new Error("AI operation did not finish");
}
async function payload(directory: string): Promise<{ items: Array<{ assetRef: string; title: string; summary: string; bodyMarkdown: string; workspace: string | null }> }> {
  return JSON.parse(await readFile(join(directory, "input.json"), "utf8")) as Awaited<ReturnType<typeof payload>>;
}

test("retrieval terms share Unicode limits, normalization, count checks and credential scanning", () => {
  assert.deepEqual(retrievalTermsSchema.parse(["  FooBar  ", "foobar", "中文", "😀".repeat(64)]), ["FooBar", "中文", "😀".repeat(64)]);
  assert.equal(retrievalTermsSchema.parse(Array.from({ length: 16 }, (_, i) => `term${i}`)).length, 16);
  for (const values of [[], ["ab", "cd"], ["AA", "aa", "bb"], Array.from({ length: 17 }, (_, i) => `term${i}`),
    ["a", "中文", "接口"], ["😀".repeat(65), "中文", "接口"], ["ab\ncd", "中文", "接口"], ["\nab", "中文", "接口"],
    ["ab\u0085cd", "中文", "接口"], ["ab\u2028cd", "中文", "接口"]]) assert.equal(retrievalTermsSchema.safeParse(values).success, false);
  assert.deepEqual(storedRetrievalTermsSchema.parse([]), []);
  assert.equal(candidatePrepareInputSchema.safeParse({ ...memory, retrievalTerms: undefined }).success, false);
  assert.equal(candidateUpdateInputSchema.safeParse({ capabilityIds: [], candidateId: "cnd123", candidateVersion: 0,
    title: "title", summary: "summary", bodyMarkdown: memory.conclusion }).success, false);
  assert.throws(() => checkStructuredContent({ retrievalTerms: ["ghp_syntheticToken", "中文", "接口"] }),
    { code: "CONTENT_CONTAINS_SECRET", field: "retrievalTerms.0" });
  assert.doesNotThrow(() => z.toJSONSchema(retrievalTermsSchema));
});

test("terms match at summary tier below title and above body for short and FTS recall; deleted knowledge stays hidden", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  for (const query of ["检索", "retrievalneedle"]) {
    const title = await f.asset({ title: query });
    const summary = await f.asset({ title: "ordinary", summary: query });
    const term = await f.asset({ title: "ordinary", retrievalTerms: [query, "另一词", "第三词"] });
    const body = await f.asset({ title: "ordinary", body: query });
    const deleted = await f.asset({ title: "ordinary", retrievalTerms: [query, "另一词", "第三词"] }); f.remove(deleted.assetId);
    const ranked = f.search.rankedCandidates({ authorizedWorkspaces: [] }, query);
    const tier = (assetId: string) => ranked.find(item => item.assetId === assetId)!.fieldTier;
    assert.equal(tier(term.assetId), tier(summary.assetId));
    assert.ok(tier(title.assetId) > tier(term.assetId)); assert.ok(tier(term.assetId) > tier(body.assetId));
    assert.match(ranked.find(item => item.assetId === term.assetId)!.item.matchedSnippet, new RegExp(query));
    assert.equal(ranked.some(item => item.assetId === deleted.assetId), false);
    const recalled = await f.service.recall({ capabilityIds: [], queries: [query] });
    assert.equal(recalled.items[0]!.assetId, title.assetId);
    assert.equal(recalled.items.some(item => "retrievalTerms" in item), false);
    const read = await f.service.read({ capabilityIds: [], assetId: term.assetId });
    assert.deepEqual(read.retrievalTerms, [query, "另一词", "第三词"]);
    const library = await f.search.listLibrary({ query });
    assert.equal(library.items[0]!.assetId, title.assetId);
    assert.ok(library.items.some(item => item.assetId === term.assetId));
  }
});

test("prepare, review, update and acceptance retain terms; terms-only revisions produce a real previous version and diff", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  const candidates = new CandidateService(f.options);
  const first = await prepareStructuredCandidate(memory, candidates, f.capabilities);
  assert.ok(!("status" in first));
  const review = await prepareStructuredCandidate({ ...memory, title: "另一判断" }, candidates, f.capabilities);
  assert.ok("pendingCandidates" in review);
  assert.deepEqual(review.pendingCandidates[0]!.retrievalTerms, terms);
  const nextTerms = ["RevisedTerms", "修订检索词", "VERSION_CONFLICT"];
  const pending = (await candidates.list()).items[0]!;
  const updated = await updateStructuredCandidate({ capabilityIds: [], candidateId: first.candidateId, candidateVersion: 0,
    title: pending.title, summary: pending.summary, bodyMarkdown: pending.bodyMarkdown, retrievalTerms: nextTerms }, candidates, f.capabilities);
  assert.equal(updated.version, 1);
  await candidates.accept(selection(updated, "accept-terms"));
  const original = f.records.get(first.assetId)!;
  assert.deepEqual(original.retrievalTerms, nextTerms);
  const revision = await prepareStructuredCandidate({ ...memory, retrievalTerms: terms, revision: { assetId: first.assetId, baseVersion: 0 } }, candidates, f.capabilities);
  assert.ok(!("status" in revision));
  // Keep every other content field byte-identical to isolate the terms-only change.
  const revisedCandidate = await candidates.rewrite(selection(revision, "terms-only"), {
    title: original.title, summary: original.summary, bodyMarkdown: original.bodyMarkdown, retrievalTerms: terms });
  await candidates.accept({ ...selection(revisedCandidate, "accept-revision"), baseVersion: 0 });
  const current = f.records.get(first.assetId)!;
  assert.equal(current.version, 1); assert.deepEqual(current.previousContent?.retrievalTerms, nextTerms);
  assert.deepEqual(current.retrievalTerms, terms);
  assert.deepEqual(f.repository.db.prepare("SELECT retrieval_terms FROM asset_fts WHERE asset_id=?").get(first.assetId), { retrieval_terms: JSON.stringify(terms) });
  const diff = await new AssetDiffService(f.search).get(first.assetId);
  assert.equal(diff.status, "AVAILABLE");
  if (diff.status === "AVAILABLE") assert.ok(diff.hunks.flatMap(hunk => hunk.lines).some(line => line.kind === "add" && line.text.includes("RetrievalTerms")));
});

test("batch-one database gains terms columns and FTS without losing content, candidates, facts or old query results", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const path = join(f.root, "legacy.sqlite"), old = new Database(path);
  const legacySchema = BASELINE_SCHEMA_SQL.replace(/^.*retrieval_terms TEXT.*\n/gmu, "").replace("title, summary, retrieval_terms, body_markdown", "title, summary, body_markdown");
  old.exec(legacySchema);
  old.exec(`INSERT INTO asset(asset_id,asset_type,asset_scope,title,summary,body_markdown,previous_content)
    VALUES ('ast1','MEMORY','GLOBAL','legacyneedle','旧摘要','正文','{"title":"旧","summary":"旧","bodyMarkdown":"旧","updatedAt":"old"}');
    INSERT INTO asset_fts(asset_id,title,summary,body_markdown) SELECT asset_id,title,summary,body_markdown FROM asset;
    INSERT INTO asset_candidate(candidate_id,asset_id,intent,asset_type,asset_scope,title,summary,body_markdown,status)
    VALUES ('cnd1','ast2','NEW','MEMORY','GLOBAL','候选','摘要','正文','PENDING');
    INSERT INTO recall_operation(recall_id,authorized_workspaces_json,queries_json,diagnostics_json,budget_json) VALUES ('usg1','[]','[]','[]','{}');`);
  const beforeAssets = old.prepare("SELECT * FROM asset").all(), beforeCandidates = old.prepare("SELECT * FROM asset_candidate").all();
  const beforeFacts = old.prepare("SELECT * FROM recall_operation").all();
  const oldHits = old.prepare("SELECT asset_id FROM asset_fts WHERE asset_fts MATCH 'legacyneedle'").all();
  old.close();
  const db = openDatabase(path); t.after(() => db.close());
  for (const [table, before] of [["asset", beforeAssets], ["asset_candidate", beforeCandidates]] as const) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    assert.ok(rows.every(row => row.retrieval_terms === "[]"));
    assert.deepEqual(rows.map(({ retrieval_terms: _terms, ...row }) => row), before);
  }
  assert.deepEqual(db.prepare("SELECT * FROM recall_operation").all(), beforeFacts);
  assert.deepEqual(db.prepare("SELECT asset_id FROM asset_fts WHERE asset_fts MATCH 'legacyneedle'").all(), oldHits);
  assert.deepEqual(new AssetRepository(db).get("ast1")!.previousContent!.retrievalTerms, []);
  const search = new AssetSearchService({ databasePath: path, workspaceConfigPath: f.options.workspaceConfigPath }); t.after(() => search.close());
  assert.deepEqual((await search.search({ context: { authorizedWorkspaces: [] }, query: "legacyneedle" })).map(item => [item.assetId, item.summary]), [["ast1", "旧摘要"]]);
  openDatabase(path).close();
  assert.deepEqual(db.prepare("SELECT * FROM recall_operation").all(), beforeFacts);
});

test("backfill writes only empty live terms, keeps versions and previous content, skips invalid and raced items and has no receipts", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const db = openDatabase(f.options.databasePath); t.after(() => db.close());
  const assets = new AssetRepository(db), writes = new CandidateRepository(db);
  const seed = (id: number, extra: Partial<NewAsset> = {}) => assets.insert({ assetId: `ast${id}`, type: "MEMORY", scope: "GLOBAL", workspace: null,
    title: `item${id}`, summary: "摘要", bodyMarkdown: "😀".repeat(2001), retrievalTerms: [], ...extra });
  db.transaction(() => {
    for (let id = 1; id <= 8; id++) seed(id);
    seed(9, { retrievalTerms: terms }); seed(10); assets.delete("ast10");
    seed(11, { scope: "WORKSPACE", workspace: "unregistered" });
    assets.revise("ast1", 0, { ...assets.get("ast1")!, title: "retained previous" });
  }).immediate();
  const before = assets.get("ast1")!, receiptCount = db.prepare("SELECT count(*) AS n FROM write_operation").get();
  const rawPrevious = db.prepare("SELECT previous_content FROM asset WHERE asset_id='ast1'").get();
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const data = await payload(input.directory);
    assert.equal(data.items.length, 9);
    assert.ok(data.items.every(item => [...item.bodyMarkdown].length === 2000));
    assert.ok(data.items.some(item => item.workspace === "unregistered"));
    assert.equal(data.items.some(item => item.title === "item9" || item.title === "item10"), false);
    writes.write("raced-revision", "accept", "raced", () => assets.revise("ast2", 0, { ...assets.get("ast2")!, summary: "concurrent" }));
    assets.backfillTerms([{ assetId: "ast3", version: 0, retrievalTerms: ["concurrent", "并发补齐", "已有词语"] }]);
    db.transaction(() => assets.delete("ast4")).immediate();
    return { items: data.items.filter(item => item.title !== "item8").map(item => ({ assetRef: item.assetRef,
      retrievalTerms: item.title === "item5" ? ["x"] : item.title === "item6" ? ["ghp_syntheticToken", "中文", "接口"] : terms })) };
  } }); t.after(() => ai.close());
  await ai.backfillTerms({ requestId: "backfill", provider: "codex" });
  const status = await finished(ai, "backfill"); assert.equal(status.state, "SUCCEEDED", JSON.stringify(status));
  const result = status.result as BackfillTermsResult;
  assert.equal(result.processed, 9); assert.equal(result.written, 3);
  assert.deepEqual(new Set(result.items.filter(item => item.retrievalTerms).map(item => item.assetId)), new Set(["ast1", "ast7", "ast11"]));
  assert.ok(result.items.filter(item => !item.retrievalTerms).every(item => item.skippedReason));
  assert.equal(assets.get("ast1")!.version, before.version); assert.deepEqual(assets.get("ast1")!.previousContent, before.previousContent);
  assert.deepEqual(db.prepare("SELECT previous_content FROM asset WHERE asset_id='ast1'").get(), rawPrevious);
  const { retrievalTerms: _oldTerms, updatedAt: _oldTime, ...oldContent } = before;
  const { retrievalTerms: _newTerms, updatedAt: _newTime, ...newContent } = assets.get("ast1")!;
  assert.deepEqual(newContent, oldContent);
  assert.deepEqual(assets.get("ast9")!.retrievalTerms, terms);
  assert.deepEqual(assets.get("ast3")!.retrievalTerms, ["concurrent", "并发补齐", "已有词语"]);
  assert.equal(await f.service.receipt("backfill"), undefined);
  assert.deepEqual(receiptCount, { n: 0 });
  assert.deepEqual(db.prepare("SELECT request_id FROM write_operation").all(), [{ request_id: "raced-revision" }]);
  const search = new AssetSearchService(f.options); t.after(() => search.close());
  assert.ok((await search.search({ context: { authorizedWorkspaces: [] }, query: "RetrievalTerms" })).some(item => item.assetId === "ast1"));
});

test("backfill commits whole batches, preserves completed batches on shutdown and resumes only remaining empty terms", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const db = openDatabase(f.options.databasePath); t.after(() => db.close()); const assets = new AssetRepository(db);
  db.transaction(() => { for (let i = 1; i <= 43; i++) assets.insert({ assetId: `ast${i}`, type: "MEMORY", scope: "GLOBAL", workspace: null,
    title: `item${i}`, summary: "summary", bodyMarkdown: "body", retrievalTerms: [] }); }).immediate();
  let calls = 0, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const data = await payload(input.directory); calls++;
    if (calls === 2) {
      entered(); await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { items: data.items.map(item => ({ assetRef: item.assetRef, retrievalTerms: terms })) };
  } }); t.after(() => ai.close());
  await ai.backfillTerms({ requestId: "interrupted", provider: "codex" }); await ready;
  assert.equal((await ai.status("interrupted"))?.state, "RUNNING");
  assert.equal(((await ai.status("interrupted"))?.result as BackfillTermsResult).written, 20);
  await assert.rejects(ai.backfillTerms({ requestId: "busy", provider: "codex" }), { code: "AI_BUSY" });
  await ai.close();
  const stopped = await ai.status("interrupted"); assert.equal(stopped?.error?.code, "AI_INTERRUPTED");
  assert.equal((stopped?.result as BackfillTermsResult).written, 20);
  assert.equal(assets.missingRetrievalTerms().length, 23);
  const sizes: number[] = [];
  const resumed = new AiService(f.service, { configPath: f.configPath, runner: async input => {
    const data = await payload(input.directory); sizes.push(data.items.length);
    return { items: data.items.map(item => ({ assetRef: item.assetRef, retrievalTerms: terms })) };
  } }); t.after(() => resumed.close());
  await resumed.backfillTerms({ requestId: "resume", provider: "codex" });
  const status = await finished(resumed, "resume"); assert.equal(status.state, "SUCCEEDED");
  assert.deepEqual(sizes, [20, 3]); assert.equal(assets.missingRetrievalTerms().length, 0);
  assert.deepEqual(await resumed.backfillTerms({ requestId: "resume", provider: "codex" }), status);
  await assert.rejects(resumed.backfillTerms({ requestId: "resume", provider: "claude" }), { code: "REQUEST_ID_CONFLICT" });
  await resumed.backfillTerms({ requestId: "again", provider: "codex" });
  assert.equal(((await finished(resumed, "again")).result as BackfillTermsResult).total, 0);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM write_operation").get(), { n: 0 });
  assert.deepEqual(db.prepare("SELECT DISTINCT version,previous_content FROM asset").all(), [{ version: 0, previous_content: null }]);
});

test("backfill rejects forged references before writing the batch and rolls back FTS failures", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const db = openDatabase(f.options.databasePath); t.after(() => db.close()); const assets = new AssetRepository(db);
  db.transaction(() => assets.insert({ assetId: "ast1", type: "MEMORY", scope: "GLOBAL", workspace: null,
    title: "item", summary: "summary", bodyMarkdown: "body", retrievalTerms: [] })).immediate();
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => ({ items: [{ assetRef: "forged", retrievalTerms: terms }] }) }); t.after(() => ai.close());
  await ai.backfillTerms({ requestId: "forged", provider: "codex" });
  assert.equal((await finished(ai, "forged")).error?.code, "AI_OUTPUT_INVALID");
  assert.deepEqual(assets.get("ast1")!.retrievalTerms, []);
  db.exec("DROP TABLE asset_fts");
  assert.throws(() => assets.backfillTerms([{ assetId: "ast1", version: 0, retrievalTerms: terms }]));
  assert.deepEqual(assets.get("ast1")!.retrievalTerms, []);
});
