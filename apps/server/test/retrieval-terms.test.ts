import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { retrievalTermsSchema, storedRetrievalTermsSchema } from "../src/asset/schema.js";
import { checkStructuredContent } from "../src/asset/structured-candidate-checks.js";
import { candidatePrepareInputSchema, candidateUpdateInputSchema, prepareStructuredCandidate, updateStructuredCandidate } from "../src/asset/structured-candidate.js";
import { AssetRepository } from "../src/asset/asset-repository.js";
import { CandidateService } from "../src/asset/candidate-service.js";
import { AssetDiffService } from "../src/asset/content-diff.js";
import { AssetSearchService } from "../src/asset/search.js";
import { BASELINE_SCHEMA_SQL, openDatabase } from "../src/storage/schema.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { candidateFixture, selection } from "../test-support/candidate-fixture.js";

const terms = ["RetrievalTerms", "检索词校验", "asset_fts"];
test("retrieval terms reject sentence punctuation but allow spaces and internal dots", () => {
  for (const punctuation of ["。", "！", "？", "；", "，", "、", ";", "!", "?"]) {
    const result = retrievalTermsSchema.safeParse([`word${punctuation}word`, "中文", "接口"]);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /整句/);
  }
  assert.equal(storedRetrievalTermsSchema.safeParse(["file.ts. "]).success, false);
  assert.deepEqual(retrievalTermsSchema.parse(["Native Memories", "file.ts", "中文检索词"]), ["Native Memories", "file.ts", "中文检索词"]);
});
const memory = { capabilityIds: [], type: "MEMORY", title: "检索词校验边界", summary: "写入时校验完整检索词",
  retrievalTerms: terms, conclusion: "新增和修订候选必须提交完整检索词，正式知识由人工接受候选后更新。",
  conditions: "临时隔离数据库", verified: "隔离数据库中的自动化验证" };
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
