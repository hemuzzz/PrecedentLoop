import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { candidateFixture, content, selection } from "../test-support/candidate-fixture.js";
import { BASELINE_SCHEMA_SQL, openDatabase, PERSISTENT_TABLES } from "../src/storage/schema.js";
import { AssetRepository } from "../src/asset/asset-repository.js";
import { IssueRepository } from "../src/asset/issue-repository.js";
import { IssueService } from "../src/asset/issue-service.js";
import { knowledgeIssueSchema } from "../src/asset/issue-schema.js";
import { assessmentDirectory, assessmentSchema, handleCaptureHook, recordAssessment } from "../src/hook/capture-assessment.js";
import { AiService } from "../src/ai/service.js";

const turn = { sessionId: "issue-session", turnId: "issue-turn", outcome: "NO_INCREMENT", reason: "isolated feedback" };
const issue = (assetId: string) => ({ assetId, kind: "OUTDATED" as const, detail: "当前实现已变化", evidence: "src/example.ts:12" });
async function fixture() {
  const f = await candidateFixture();
  const db = openDatabase(f.options.databasePath), records = new AssetRepository(db), issues = new IssueRepository(db);
  const service = new IssueService(f.options.databasePath);
  async function seed(requestId = "seed") {
    const row = (await f.prepare(requestId, [content()])).candidates[0]!;
    await f.service.accept(selection(row, `${requestId}-accept`));
    return records.get(row.assetId)!;
  }
  const report = (assetId: string, turnId = turn.turnId) => service.record({ ...turn, turnId, knowledgeIssues: [issue(assetId)] }, "CODEX");
  return { ...f, db, records, issues, issueService: service, seed, report, close: async () => { db.close(); await f.cleanup(); } };
}
async function finished(ai: AiService, requestId: string) {
  for (let n = 0; n < 200; n++) {
    const status = await ai.status(requestId);
    if (status?.state !== "RUNNING") { assert.ok(status); return status; }
    await delay(10);
  }
  throw new Error("AI operation did not finish");
}
const output = { schemaVersion: 1, content: { title: "修订标题", summary: "修订后的摘要", retrievalTerms: content().retrievalTerms, bodyMarkdown: "修订以当前正式知识版本为基线，提交时重新检查版本和待处理问题，冲突时整体回滚并提示重新起草。" }, explanation: "依据已报告的现状修订" };

test("P2 database automatically gains issue and check tables without changing any existing rows; readonly never repairs", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const path = join(f.root, "p2.sqlite"), db = new Database(path); t.after(() => db.close());
  const p2 = BASELINE_SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS (?:asset_issue|retrieval_check) \([\s\S]*?\n\);/gu, "");
  db.exec(p2);
  db.exec(`INSERT INTO asset(asset_id,asset_type,asset_scope,title,summary,body_markdown) VALUES ('ast1','MEMORY','GLOBAL','kept','summary','body');
    INSERT INTO asset_candidate(candidate_id,asset_id,intent,asset_type,asset_scope,title,summary,body_markdown,status)
      VALUES ('cnd1','ast2','NEW','MEMORY','GLOBAL','pending','summary','body','PENDING');
    INSERT INTO recall_operation(recall_id,authorized_workspaces_json,queries_json,diagnostics_json,budget_json) VALUES ('usg1','[]','[]','[]','{}');`);
  const tables = PERSISTENT_TABLES.filter(name => name !== "asset_issue");
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  assert.throws(() => openDatabase(path, { readonly: true }), { code: "DATABASE_SCHEMA_INVALID" });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='asset_issue'").get(), undefined);
  openDatabase(path).close(); openDatabase(path).close();
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
  for (const table of ["asset_issue", "retrieval_check"]) assert.deepEqual(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), { n: 0 });
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('asset_issue','retrieval_check') AND sql IS NOT NULL").all(), []);
});

test("retired check table is optional for reads and still restored by additive completion", async t => {
  const f = await fixture(); t.after(() => f.close());
  const asset = await f.seed(); f.report(asset.assetId);
  const before = f.issues.active();
  f.db.exec("DROP TABLE retrieval_check");
  const readOnly = openDatabase(f.options.databasePath, { readonly: true });
  try {
    assert.deepEqual(new IssueRepository(readOnly).active(), before);
    assert.equal(readOnly.prepare("SELECT name FROM sqlite_master WHERE name='retrieval_check'").get(), undefined);
  } finally { readOnly.close(); }
  assert.deepEqual((await f.service.list()).issueCards[0]!.issues, before);
  openDatabase(f.options.databasePath).close();
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM retrieval_check").get(), { n: 0 });
  assert.deepEqual(f.issues.active(), before);
});

test("issue and retired check table CHECK constraints reject invalid enums, source identities, JSON and drafted links", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed();
  const insert = f.db.prepare(`INSERT INTO asset_issue(issue_id,asset_id,asset_version,kind,detail,queries,source,session_id,turn_id,check_id,status,candidate_id,is_deleted)
    VALUES (@issueId,@assetId,@version,@kind,@detail,@queries,@source,@sessionId,@turnId,@checkId,@status,@candidateId,@deleted)`);
  const base = { issueId: "isu1", assetId: asset.assetId, version: 0, kind: "OUTDATED", detail: "problem", queries: null, source: "CODEX", sessionId: "s", turnId: "t", checkId: null, status: "OPEN", candidateId: null, deleted: 0 };
  for (const extra of [{ version: -1 }, { kind: "OTHER" }, { detail: " " }, { queries: "{" }, { source: "OTHER" }, { sessionId: null },
    { source: "REFERENCE_CHECK" }, { source: "RETRIEVAL_CHECK", sessionId: null, turnId: null }, { status: "OTHER" }, { status: "DRAFTED" }, { deleted: 2 }])
    assert.throws(() => insert.run({ ...base, ...extra }), /CHECK/);
  const check = f.db.prepare(`INSERT INTO retrieval_check(check_id,target_kind,target_id,target_version,result,passed,is_deleted) VALUES ('chk1',?,'ast1',?,?,?,?)`);
  for (const values of [["OTHER", 0, "[]", 1, 0], ["ASSET", -1, "[]", 1, 0], ["ASSET", 0, "{", 1, 0], ["ASSET", 0, "[]", 2, 0], ["ASSET", 0, "[]", 1, 2]])
    assert.throws(() => check.run(...values), /CHECK/);
  // Only historical-data fixtures write the retired table; production paths no longer do.
  check.run("ASSET", 0, "[]", 1, 0);
  assert.throws(() => insert.run({ ...base, checkId: "chk1" }), /CHECK/);
  insert.run({ ...base, kind: "UNREACHABLE", source: "RETRIEVAL_CHECK", sessionId: null, turnId: null, checkId: "chk1" });
  assert.throws(() => insert.run({ ...base, issueId: "isu2", source: "REFERENCE_CHECK", sessionId: null, turnId: null, checkId: "chk1" }), /CHECK/);
  insert.run({ ...base, issueId: "isu2", kind: "BROKEN_REFERENCE", source: "REFERENCE_CHECK", sessionId: null, turnId: null });
  assert.deepEqual(new Set((await f.service.list()).issueCards[0]!.issues.map(row => row.kind)), new Set(["UNREACHABLE", "BROKEN_REFERENCE"]));
  f.issueService.dismiss({ issueId: "isu1" }); f.issueService.dismiss({ issueId: "isu2" });
  assert.deepEqual(f.issues.active(), []);
  assert.deepEqual(f.db.prepare("SELECT check_id FROM retrieval_check").all(), [{ check_id: "chk1" }]);
});

test("assessment records valid issues with current version, skips invalid or deleted assets and leaves the cache and Stop unchanged", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(), deleted = await f.seed("deleted");
  f.db.transaction(() => { f.records.revise(asset.assetId, 0, { ...asset, title: "current" }); f.records.delete(deleted.assetId); }).immediate();
  const cache = join(f.root, "cache");
  const result = await recordAssessment(cache, { ...turn, knowledgeIssues: [issue(asset.assetId), issue("invalid"), issue("ast999"), issue(deleted.assetId)] }, "claude", f.options.databasePath);
  assert.deepEqual(result, { recorded: true, issues: { recorded: 1, skipped: [{ index: 1, code: "ASSET_ID_INVALID" }, { index: 2, code: "ASSET_NOT_FOUND" }, { index: 3, code: "ASSET_NOT_FOUND" }] } });
  const row = f.issues.active()[0]!;
  assert.equal(row.assetVersion, 1); assert.equal(row.source, "CLAUDE"); assert.match(row.issueId, /^isu[0-9]+$/);
  assert.deepEqual(JSON.parse(await readFile(join(assessmentDirectory(cache, turn, "claude"), "assessment.json"), "utf8")), turn);
  assert.deepEqual(await handleCaptureHook({ session_id: turn.sessionId, prompt_id: turn.turnId, hook_event_name: "Stop" }, cache, "claude"), {});
  assert.deepEqual(f.db.prepare("SELECT session_id,turn_id FROM asset_issue").get(), { session_id: turn.sessionId, turn_id: turn.turnId });
});

test("issue schema bounds individual issues while assessment accepts arbitrary issue payloads", () => {
  const valid = issue("ast1");
  for (const knowledgeIssues of [Array.from({ length: 5 }, () => valid), [{ ...valid, detail: "" }], [{ ...valid, detail: "中".repeat(501) }],
    [{ ...valid, evidence: "中".repeat(501) }], [{ ...valid, missedQueries: ["needle"] }], [{ ...valid, kind: "MISSED" }],
    [{ ...valid, kind: "MISSED", missedQueries: [] }], [{ ...valid, kind: "MISSED", missedQueries: Array(9).fill("q") }],
    [{ ...valid, kind: "MISSED", missedQueries: [""] }], [{ ...valid, kind: "MISSED", missedQueries: ["q".repeat(257)] }],
    [{ ...valid, kind: "UNREACHABLE" }], [{ ...valid, kind: "BROKEN_REFERENCE" }], [{ ...valid, unknown: true }]])
    {
      assert.equal(assessmentSchema.safeParse({ ...turn, knowledgeIssues }).success, true);
      if (knowledgeIssues.length === 1) assert.equal(knowledgeIssueSchema.safeParse(knowledgeIssues[0]).success, false);
    }
  assert.equal(assessmentSchema.safeParse({ ...turn, unknown: true }).success, false);
  assert.equal(assessmentSchema.safeParse({ ...turn, knowledgeIssues: [{ ...valid, kind: "MISSED", detail: "😀".repeat(500), evidence: "中".repeat(500), missedQueries: Array(8).fill("q".repeat(256)) }] }).success, true);
});

test("malformed issues never reject valid assessments; only arrays replace OPEN issues, including empty arrays", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed();
  const cache = join(f.root, "partial-cache");
  const record = (knowledgeIssues: unknown, reason = "saved") => recordAssessment(cache, { ...turn, reason, knowledgeIssues }, "codex", f.options.databasePath);
  await record([issue(asset.assetId)]);
  const old = f.issues.active()[0]!;
  for (const value of [null, {}, "bad", 42]) {
    assert.deepEqual(await record(value), { recorded: true, issues: { recorded: 0, error: "ISSUES_INVALID" } });
    assert.equal(f.issues.active()[0]!.issueId, old.issueId);
  }
  await recordAssessment(cache, { ...turn, reason: "without issues" }, "codex", f.options.databasePath);
  assert.equal(f.issues.active()[0]!.issueId, old.issueId);
  assert.deepEqual(await record([null, issue(asset.assetId), { ...issue(asset.assetId), detail: "" }, issue("invalid"), issue(asset.assetId)]), {
    recorded: true, issues: { recorded: 1, skipped: [{ index: 0, code: "ISSUE_INVALID" }, { index: 2, code: "ISSUE_INVALID" },
      { index: 3, code: "ASSET_ID_INVALID" }, { index: 4, code: "TOO_MANY_ISSUES" }] },
  });
  assert.notEqual(f.issues.active()[0]!.issueId, old.issueId);
  assert.deepEqual(JSON.parse(await readFile(join(assessmentDirectory(cache, turn), "assessment.json"), "utf8")), { ...turn, reason: "saved" });
  for (const invalid of [{ outcome: "bad" }, { reason: "" }, { sessionId: "" }, { turnId: null }, { references: 1 }, { unknown: true }])
    await assert.rejects(recordAssessment(cache, { ...turn, ...invalid, knowledgeIssues: [] }, "codex", f.options.databasePath));
  assert.equal(f.issues.active().length, 1);
  await record([]); assert.equal(f.issues.active().length, 0);
  await record([issue(asset.assetId)]);
  await record([null]); assert.equal(f.issues.active().length, 0);
});

test("same-turn feedback replaces only OPEN issues, absent field preserves them, and an empty array clears them atomically", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); const cache = join(f.root, "cache");
  const record = (knowledgeIssues?: unknown[]) => recordAssessment(cache, { ...turn, ...(knowledgeIssues === undefined ? {} : { knowledgeIssues }) }, "codex", f.options.databasePath);
  await record([issue(asset.assetId)]); const original = f.issues.active()[0]!;
  await record(); assert.deepEqual(f.issues.active(), [original]);
  await record([{ ...issue(asset.assetId), kind: "MISSED", missedQueries: ["earlier wording"] }]);
  const replacement = f.issues.active()[0]!; assert.notEqual(replacement.issueId, original.issueId);
  assert.deepEqual(replacement.queries, ["earlier wording"]);
  assert.deepEqual(f.db.prepare("SELECT is_deleted FROM asset_issue WHERE issue_id=?").get(original.issueId), { is_deleted: 1 });
  const candidate = (await f.prepare("revision", [{ ...content("revision"), existingAssetId: asset.assetId, baseVersion: 0 }])).candidates[0]!;
  f.db.transaction(() => f.issues.draft(asset.assetId, [replacement.issueId], candidate.candidateId)).immediate();
  await record([issue(asset.assetId)]); assert.equal(f.issues.active().length, 2);
  await record([]); assert.deepEqual(f.issues.active().map(row => row.status), ["DRAFTED"]);
  assert.deepEqual(f.db.prepare("SELECT DISTINCT operation FROM write_operation ORDER BY operation").all(), [{ operation: "accept" }, { operation: "prepare" }]);
});

test("failed issue writes roll back replacement while assessment stays recorded and Stop succeeds", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId);
  const before = f.issues.active(); const cache = join(f.root, "cache");
  // Force failure after replacement and before INSERT; all fixture data must survive.
  const mocked = t.mock.method(IssueRepository.prototype, "insert", () => { throw new Error("injected failure"); });
  assert.deepEqual(await recordAssessment(cache, { ...turn, knowledgeIssues: [issue(asset.assetId)] }, "codex", f.options.databasePath),
    { recorded: true, issues: { recorded: 0, error: "ISSUES_NOT_RECORDED" } });
  mocked.mock.restore(); assert.deepEqual(f.issues.active(), before);
  assert.deepEqual(await handleCaptureHook({ session_id: turn.sessionId, turn_id: turn.turnId, hook_event_name: "Stop" }, cache), {});
  assert.deepEqual(await recordAssessment(cache, { ...turn, knowledgeIssues: [] }, "codex", join(f.root, "missing.sqlite")),
    { recorded: true, issues: { recorded: 0, error: "ISSUES_NOT_RECORDED" } });
  assert.deepEqual(JSON.parse(await readFile(join(assessmentDirectory(cache, turn), "assessment.json"), "utf8")), turn);
});

test("issue cards group, attach to deferred candidates, sort by Used then newest issue and hide deleted knowledge", async t => {
  const f = await fixture(); t.after(() => f.close()); const a = await f.seed("a"), b = await f.seed("b"), c = await f.seed("c");
  f.report(a.assetId, "a1"); f.report(a.assetId, "a2"); f.report(b.assetId, "b"); f.report(c.assetId, "c");
  f.db.prepare("UPDATE asset_issue SET created_at=?,updated_at=? WHERE asset_id=?").run("2000", "2000", a.assetId);
  f.db.prepare("UPDATE asset_issue SET created_at=?,updated_at=? WHERE asset_id=?").run("2001", "2001", b.assetId);
  f.db.prepare("UPDATE asset_issue SET created_at=?,updated_at=? WHERE asset_id=?").run("2002", "2002", c.assetId);
  f.db.prepare("INSERT INTO read_operation(read_ref,authorized_workspaces_json,asset_id,asset_version,asset_scope) VALUES ('usg1','[]',?,0,'GLOBAL')").run(a.assetId);
  f.db.prepare("INSERT INTO used_event(used_id,authorized_workspaces_json,direct_read_ref,asset_id) VALUES ('usg2','[]','usg1',?)").run(a.assetId);
  let inbox = await f.service.list();
  assert.deepEqual(inbox.issueCards.map(card => card.assetId), [a.assetId, c.assetId, b.assetId]);
  assert.equal(inbox.issueCards[0]!.issues.length, 2); assert.equal(inbox.issueCards[0]!.totalUsedCount, 1);
  const candidate = (await f.prepare("revision", [{ ...content(), existingAssetId: a.assetId, baseVersion: 0 }])).candidates[0]!;
  await f.service.defer({ ...selection(candidate, "defer"), deferred: true });
  inbox = await f.service.list(); assert.deepEqual(inbox.issueCards.map(card => card.assetId), [c.assetId, b.assetId]); assert.equal(inbox.items[0]!.issues.length, 2);
  f.db.transaction(() => f.records.delete(c.assetId)).immediate();
  assert.deepEqual((await f.service.list()).issueCards.map(card => card.assetId), [b.assetId]);
  assert.equal(f.issues.active(c.assetId).length, 0);
  assert.deepEqual(f.db.prepare("SELECT status,is_deleted FROM asset_issue WHERE asset_id=?").get(c.assetId), { status: "OPEN", is_deleted: 0 });
});

test("dismiss supports OPEN and DRAFTED, conflicts on repeat and does not create receipts", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId, "open");
  const before = f.db.prepare("SELECT count(*) AS n FROM write_operation").get();
  const open = f.issues.active()[0]!;
  assert.deepEqual(f.issueService.dismiss({ issueId: open.issueId }), { dismissed: true, issueId: open.issueId });
  assert.throws(() => f.issueService.dismiss({ issueId: open.issueId }), { code: "VERSION_CONFLICT" });
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM write_operation").get(), before);
  f.report(asset.assetId, "drafted");
  const candidate = (await f.prepare("revision", [{ ...content(), existingAssetId: asset.assetId, baseVersion: 0 }])).candidates[0]!;
  const drafted = f.issues.active()[0]!;
  f.db.transaction(() => f.issues.draft(asset.assetId, [drafted.issueId], candidate.candidateId)).immediate();
  f.issueService.dismiss({ issueId: drafted.issueId });
  await f.service.reject(selection(candidate, "reject"));
  assert.deepEqual(f.db.prepare("SELECT DISTINCT status FROM asset_issue").all(), [{ status: "DISMISSED" }]);
});

for (const existing of [false, true]) test(`draft revision ${existing ? "rewrites an existing" : "prepares a new"} candidate atomically, with durable replay and accept/reject linkage`, async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId, "first");
  const candidate = existing ? (await f.prepare("existing", [{ ...content(), existingAssetId: asset.assetId, baseVersion: 0 }])).candidates[0] : undefined;
  let calls = 0;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async request => {
    calls++; const input = JSON.parse(await readFile(join(request.directory, "input.json"), "utf8")) as { operation: string; baseline: string; instructions: string; candidate?: string };
    assert.equal(input.operation, existing && calls === 1 ? "rewrite" : "draft-revision"); assert.equal(!!input.candidate, existing && calls === 1);
    assert.match(input.baseline, /候选写入/); assert.match(input.instructions, /OUTDATED/); assert.match(input.instructions, /src\/example.ts/); assert.match(request.prompt, /读不到源码/);
    return output;
  } }); t.after(() => ai.close());
  const input = { requestId: "draft", assetId: asset.assetId, provider: "codex" };
  await ai.draftRevision(input); const status = await finished(ai, "draft"); assert.equal(status.state, "SUCCEEDED", JSON.stringify(status)); assert.equal(status.operation, "draft-revision");
  const row = (await f.service.list()).items[0]!;
  if (candidate) assert.equal(row.candidateId, candidate.candidateId);
  assert.equal(row.title, output.content.title); assert.equal(row.issues[0]!.status, "DRAFTED"); assert.equal(row.issues[0]!.candidateId, row.candidateId);
  assert.equal((await f.service.receipt("draft"))?.operation, existing ? "rewrite" : "prepare");
  await ai.draftRevision(input); assert.equal(calls, 1);
  await assert.rejects(ai.draftRevision({ ...input, provider: "claude" }), { code: "REQUEST_ID_CONFLICT" });
  await f.service.reject(selection(row, "reject"));
  assert.equal(f.issues.active()[0]!.status, "OPEN"); assert.equal(f.issues.active()[0]!.candidateId, null);
  await ai.draftRevision({ ...input, requestId: "redraft" }); assert.equal((await finished(ai, "redraft")).state, "SUCCEEDED");
  f.report(asset.assetId, "late");
  const updated = (await f.service.list()).items[0]!;
  assert.deepEqual(new Set(updated.issues.map(issue => issue.status)), new Set(["OPEN", "DRAFTED"]));
  await f.service.accept({ ...selection(updated, "accept-revision"), baseVersion: 0 });
  assert.deepEqual(f.db.prepare("SELECT DISTINCT status FROM asset_issue").all(), [{ status: "RESOLVED" }]);
  assert.equal(f.issues.active().length, 0); assert.equal(f.records.get(asset.assetId)!.version, 1);
});

for (const race of ["asset", "candidate", "issue", "existing-candidate", "existing-asset", "existing-issue"] as const) test(`draft revision rolls back on concurrent ${race} change`, async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId);
  const candidate = race.startsWith("existing") ? (await f.prepare("existing", [{ ...content(), existingAssetId: asset.assetId, baseVersion: 0 }])).candidates[0]! : undefined;
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => {
    if (race === "asset" || race === "existing-asset") f.db.transaction(() => f.records.revise(asset.assetId, 0, { ...asset, title: "concurrent" })).immediate();
    else if (race === "candidate") await f.prepare("concurrent", [{ ...content("concurrent"), existingAssetId: asset.assetId, baseVersion: 0 }]);
    else if (race === "existing-candidate") await f.service.rewrite(selection(candidate!, "concurrent"), { ...output.content, title: "concurrent" });
    else f.issueService.dismiss({ issueId: f.issues.active()[0]!.issueId });
    return output;
  } }); t.after(() => ai.close());
  await ai.draftRevision({ requestId: "raced", provider: "codex", assetId: asset.assetId });
  const status = await finished(ai, "raced"); assert.equal(status.state, "FAILED"); assert.equal(status.error?.code, "VERSION_CONFLICT", JSON.stringify(status));
  assert.equal(await f.service.receipt("raced"), undefined);
  assert.equal(f.issues.active().some(row => row.status === "DRAFTED"), false);
  if (race === "existing-issue") assert.equal((await f.service.list()).items[0]!.bodyMarkdown, content().bodyMarkdown);
  if (!candidate && race !== "candidate") assert.equal((await f.service.list()).items.length, 0);
});

test("draft revision holds the shared AI slot, rejects invalid output", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId);
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ai = new AiService(f.service, { configPath: f.configPath, runner: async () => { enter(); await gate; return { ...output, content: { ...output.content, retrievalTerms: ["非法整句。", "候选版本", "事务回滚"] } }; } });
  t.after(() => ai.close());
  await ai.draftRevision({ requestId: "invalid", assetId: asset.assetId, provider: "codex" }); await ready;
  try {
    await assert.rejects(ai.import({ requestId: "busy", provider: "codex", sources: [{ name: "input.md", content: "隔离输入" }] }), { code: "AI_BUSY" });
    await assert.rejects(ai.draftRevision({ requestId: "busy-draft", assetId: asset.assetId, provider: "codex" }), { code: "AI_BUSY" });
  } finally { release(); }
  const status = await finished(ai, "invalid"); assert.equal(status.state, "FAILED"); assert.equal(status.error?.code, "AI_OUTPUT_INVALID");
  assert.equal((await f.service.list()).items.length, 0); assert.equal(f.issues.active()[0]!.status, "OPEN");
  assert.equal(await f.service.receipt("invalid"), undefined);
});

test("issue linkage failures roll back candidate acceptance, rejection and receipts", async t => {
  const f = await fixture(); t.after(() => f.close()); const asset = await f.seed(); f.report(asset.assetId);
  const row = (await f.prepare("revision", [{ ...content("changed"), existingAssetId: asset.assetId, baseVersion: 0 }])).candidates[0]!;
  f.db.transaction(() => f.issues.draft(asset.assetId, [f.issues.active()[0]!.issueId], row.candidateId)).immediate();
  const mock = t.mock.method(IssueRepository.prototype, "transition", () => { throw new Error("injected issue failure"); });
  await assert.rejects(f.service.accept({ ...selection(row, "failed-accept"), baseVersion: 0 }), /injected/);
  await assert.rejects(f.service.reject(selection(row, "failed-reject")), /injected/);
  mock.mock.restore();
  assert.equal(f.records.get(asset.assetId)!.version, 0); assert.equal((await f.service.list()).items[0]!.status, "PENDING");
  assert.equal(f.issues.active()[0]!.status, "DRAFTED");
  assert.equal(await f.service.receipt("failed-accept"), undefined); assert.equal(await f.service.receipt("failed-reject"), undefined);
});
