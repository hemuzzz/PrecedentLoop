import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { candidateFixture } from "../test-support/candidate-fixture.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { openDatabase } from "../src/storage/schema.js";
import { AssetRepository, type NewAsset } from "../src/asset/asset-repository.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { IssueRepository } from "../src/asset/issue-repository.js";
import { RetrievalCheckRepository, type CheckTarget, type RetrievalCheckResult } from "../src/asset/retrieval-check-repository.js";
import { AssetSearchService } from "../src/asset/search.js";
import { extractReferencePaths, ReferenceChecker } from "../src/asset/reference-check.js";
import { AiService } from "../src/ai/service.js";
import type { CliRunner } from "../src/ai/cli.js";
import { recallRanking } from "../src/knowledge/ranking.js";
import { KNOWLEDGE_RECALL_DESCRIPTION } from "../src/knowledge/recall-rules.js";

interface Payload { step: string; rules?: string; items: Array<{ targetRef: string; questionRef: string; question: string;
  title: string; summary: string; bodyMarkdown: string; retrievalTerms: string[]; workspace: string | null; description: string }> }
const payload = async (directory: string) => JSON.parse(await readFile(join(directory, "input.json"), "utf8")) as Payload;
const defaultRunner: CliRunner = async input => {
  const data = await payload(input.directory);
  return data.step === "questions" ? { items: data.items.map(item => ({ targetRef: item.targetRef, questions: ["如何执行？", "失败怎么办？", "有哪些前提？"] })) }
    : { items: data.items.map(item => ({ questionRef: item.questionRef, queries: ["needle"] })) };
};
async function finished(ai: AiService, requestId: string) {
  for (let i = 0; i < 300; i++) { const status = await ai.status(requestId); if (status?.state !== "RUNNING") { assert.ok(status); return status; } await delay(10); }
  throw new Error("self check timed out");
}
async function fixture() {
  const f = await candidateFixture(), db = openDatabase(f.options.databasePath), assets = new AssetRepository(db), candidates = new CandidateRepository(db);
  const issues = new IssueRepository(db), checks = new RetrievalCheckRepository(db);
  const services: AiService[] = [];
  function ai(runner = defaultRunner) { const service = new AiService(f.service, { configPath: f.configPath, runner }); services.push(service); return service; }
  function seed(id: number, extra: Partial<NewAsset> = {}) { return db.transaction(() => assets.insert({ assetId: `ast${id}`, type: "MEMORY", scope: "GLOBAL", workspace: null,
    title: `needle ${id}`, summary: "summary sentinel", bodyMarkdown: "body sentinel", retrievalTerms: [], ...extra })).immediate(); }
  async function run(service: AiService, requestId: string, target?: CheckTarget) {
    await service.retrievalCheck({ requestId, provider: "codex", ...(target ? { target } : {}) });
    return finished(service, requestId);
  }
  return { ...f, db, assets, candidates, issues, checks, ai, seed, run,
    close: async () => { for (const service of services) await service.close(); db.close(); await f.cleanup(); } };
}

test("shared ordering matches recall with merged synonyms and scope, and ranking itself writes no facts", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  await f.asset({ title: "needle title", workspace: "alpha" });
  await f.asset({ title: "global", summary: "needle alternate" });
  await f.asset({ title: "forbidden needle", workspace: "beta" });
  await f.asset({ title: "body", workspace: "alpha", body: "alternate needle" });
  const queries = ["needle", "alternate", "NEEDLE"];
  const before = f.rows();
  const ranks = f.search.readTransaction(() => recallRanking(f.search, { authorizedWorkspaces: ["alpha"] }, queries));
  assert.deepEqual(f.rows(), before);
  assert.deepEqual((await f.service.recall({ capabilityIds: [f.alpha], queries })).items.map(row => row.assetId), ranks.slice(0, 8).map(row => row.assetId));
});

test("two calls isolate query generation, truncate by code points, record ranks including ninth, require three hits and write no usage or receipts", async t => {
  const f = await fixture(); t.after(() => f.close());
  for (let i = 1; i <= 9; i++) f.seed(i);
  f.seed(10, { title: "unique sentinel title", summary: "unique sentinel summary", retrievalTerms: ["private sentinel", "secretphrase", "exclusivewords"], bodyMarkdown: "😀".repeat(4001) });
  let calls = 0;
  const ai = f.ai(async input => {
    const data = await payload(input.directory); calls++;
    if (data.step === "questions") {
      assert.equal(data.items.length, 10);
      assert.equal([...data.items.find(item => item.title === "unique sentinel title")!.bodyMarkdown].length, 4000);
      return { items: data.items.map(item => ({ targetRef: item.targetRef, questions: ["问题甲", "问题乙", "问题丙"] })) };
    }
    assert.equal(data.rules, KNOWLEDGE_RECALL_DESCRIPTION);
    for (const text of ["unique sentinel", "summary sentinel", "body sentinel", "private sentinel", "secretphrase", "exclusivewords", "😀"])
      assert.equal(input.prompt.includes(text), false, text);
    assert.equal(data.items.length, 30);
    for (const item of data.items) assert.deepEqual(Object.keys(item).sort(), ["questionRef", "question", "workspace", "description"].sort());
    return { items: data.items.map(item => ({ questionRef: item.questionRef, queries: [item.question === "问题丙" ? "absent" : "needle"] })) };
  });
  const status = await f.run(ai, "ranks"); assert.equal(status.state, "SUCCEEDED", JSON.stringify(status));
  assert.equal(calls, 2);
  const result = status.result as RetrievalCheckResult;
  assert.equal(result.done, 10); assert.equal(result.total, 10);
  const ninth = result.items.find(item => item.id === "ast9")!;
  assert.deepEqual(ninth.result.map(row => [row.hit, row.rank]), [[false, 9], [false, 9], [false, null]]);
  assert.ok(result.items.every(item => !item.passed));
  assert.deepEqual(result.items.find(item => item.id === "ast1")!.result.map(row => row.hit), [true, true, false]);
  assert.equal(f.issues.active().length, 10);
  assert.match(f.issues.active("ast9")[0]!.detail, /3 个问法中 3 个未进入前 8\n问题甲\n问题乙\n问题丙/u);
  assert.deepEqual(f.issues.active("ast9")[0]!.queries, ["needle", "absent"]);
  for (const table of ["recall_operation", "recall_item", "read_operation", "used_event", "write_operation"])
    assert.deepEqual(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), { n: 0 });
  assert.match(result.items[0]!.checkId, /^chk\d+$/u);
});

test("virtual candidates use field tiers, workspace priority, null bm25 and replace their formal asset", async t => {
  const f = await fixture(); t.after(() => f.close());
  f.seed(1, { title: "oldphrase", scope: "WORKSPACE", workspace: "alpha" });
  f.seed(2, { title: "needle" });
  f.db.transaction(() => f.candidates.insert({ ...f.assets.get("ast1")!, candidateId: "cnd1", intent: "REVISION", baseVersion: 0,
    title: "needle", summary: "replacement", bodyMarkdown: "replacement" })).immediate();
  const search = new AssetSearchService(f.options); t.after(() => search.close());
  const virtual = f.candidates.get("cnd1")!, context = { authorizedWorkspaces: ["alpha"] };
  assert.deepEqual(recallRanking(search, context, ["oldphrase"], virtual), []);
  assert.equal(recallRanking(search, context, ["needle"], virtual)[0]!.assetId, "ast1");
  f.seed(3, { title: "needle", scope: "WORKSPACE", workspace: "alpha" });
  assert.deepEqual(recallRanking(search, context, ["needle"], virtual).map(row => row.assetId), ["ast3", "ast1", "ast2"]);
  assert.equal(recallRanking(search, context, ["ne"], virtual).find(row => row.assetId === "ast1")!.fieldTier, 5);
  const status = await f.run(f.ai(), "candidate", { kind: "CANDIDATE", id: "cnd1" });
  assert.equal(status.state, "SUCCEEDED");
  const check = f.checks.latest({ kind: "CANDIDATE", id: "cnd1" }, 0)!;
  assert.equal(check.passed, true); assert.ok(check.result.every(row => row.rank === 2));
  assert.equal(f.issues.active().length, 0);
  assert.deepEqual((await f.service.list()).items[0]!.retrievalCheck, check);
  f.db.transaction(() => f.candidates.updateContent("cnd1", 0, { ...virtual, summary: "new content" })).immediate();
  assert.equal((await f.service.list()).items[0]!.retrievalCheck, null);
});

test("default targets skip tested versions and unregistered/deleted/handled records; explicit targets retest; issue states deduplicate by version", async t => {
  const f = await fixture(); t.after(() => f.close());
  f.seed(1, { title: "miss" }); f.seed(2, { workspace: "gone", scope: "WORKSPACE" }); f.seed(3);
  f.db.transaction(() => {
    f.assets.delete("ast3");
    for (let id = 4; id <= 6; id++) f.candidates.insert({ assetId: `ast${id}`, candidateId: `cnd${id}`, intent: "NEW", baseVersion: null,
      type: "MEMORY", scope: "GLOBAL", workspace: null, title: "needle", summary: "summary", bodyMarkdown: "body", retrievalTerms: [] });
    f.candidates.setStatus("cnd5", 0, "DEFERRED"); f.candidates.setStatus("cnd6", 0, "REJECTED");
  }).immediate();
  assert.equal((await f.service.list()).pendingRetrievalCheckCount, 3);
  const ai = f.ai(); await f.run(ai, "all");
  assert.equal((await f.service.list()).pendingRetrievalCheckCount, 0);
  assert.equal(((await f.run(ai, "empty")).result as RetrievalCheckResult).total, 0);
  const first = f.issues.active("ast1")[0]!;
  const previousCheck = f.db.prepare("SELECT check_id FROM asset_issue WHERE issue_id=?").get(first.issueId);
  await f.run(ai, "repeat", { kind: "ASSET", id: "ast1" });
  assert.equal(f.issues.active("ast1")[0]!.issueId, first.issueId);
  assert.notDeepEqual(f.db.prepare("SELECT check_id FROM asset_issue WHERE issue_id=?").get(first.issueId), previousCheck);
  f.db.transaction(() => f.issues.transition(first, "DISMISSED", null)).immediate();
  await f.run(ai, "dismissed", { kind: "ASSET", id: "ast1" });
  assert.equal(f.issues.active().length, 0);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM asset_issue").get(), { n: 1 });
  f.db.transaction(() => f.assets.revise("ast1", 0, { ...f.assets.get("ast1")!, summary: "version changed" })).immediate();
  assert.equal(((await f.run(ai, "changed")).result as RetrievalCheckResult).total, 1);
  assert.equal(f.issues.active()[0]!.assetVersion, 1);
  const open = f.issues.active()[0]!;
  f.db.transaction(() => f.issues.transition(open, "DRAFTED", "cnd4")).immediate();
  const before = f.db.prepare("SELECT * FROM asset_issue WHERE issue_id=?").get(open.issueId);
  await f.run(ai, "drafted", { kind: "ASSET", id: "ast1" });
  assert.deepEqual(f.db.prepare("SELECT * FROM asset_issue WHERE issue_id=?").get(open.issueId), before);
  f.db.transaction(() => f.issues.transition(f.issues.active()[0]!, "RESOLVED", "cnd4")).immediate();
  await f.run(ai, "resolved", { kind: "ASSET", id: "ast1" });
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM asset_issue").get(), { n: 2 });
  assert.equal((await f.run(ai, "unknown", { kind: "ASSET", id: "ast2" })).state, "FAILED");
});

test("self checks commit in tens, retain completed batches when interrupted, resume remaining targets and share the single slot", async t => {
  const f = await fixture(); t.after(() => f.close()); for (let i = 1; i <= 23; i++) f.seed(i);
  let calls = 0, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const ai = f.ai(async input => {
    calls++;
    if (calls === 3) { entered(); await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true })); }
    return defaultRunner(input);
  });
  await ai.retrievalCheck({ requestId: "interrupt", provider: "codex" }); await ready;
  assert.equal(((await ai.status())!.result as RetrievalCheckResult).done, 10);
  await assert.rejects(ai.backfillTerms({ requestId: "busy", provider: "codex" }), { code: "AI_BUSY" });
  await ai.close();
  const stopped = (await ai.status("interrupt"))!; assert.equal(stopped.error?.code, "AI_INTERRUPTED");
  assert.equal((stopped.result as RetrievalCheckResult).done, 10);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM retrieval_check").get(), { n: 10 });
  const sizes: number[] = [], resumed = f.ai(async input => { const data = await payload(input.directory); sizes.push(data.items.length); return defaultRunner(input); });
  const status = await f.run(resumed, "resume"); assert.equal(status.state, "SUCCEEDED");
  assert.deepEqual(sizes, [10, 30, 3, 9]); assert.equal((status.result as RetrievalCheckResult).done, 13);
  assert.deepEqual(await resumed.retrievalCheck({ requestId: "resume", provider: "codex" }), status);
  await assert.rejects(resumed.retrievalCheck({ requestId: "resume", provider: "claude" }), { code: "REQUEST_ID_CONFLICT" });
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM write_operation").get(), { n: 0 });
});

test("invalid AI schemas or missing, forged and duplicate refs commit none of the affected batch", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(1); f.seed(2);
  const variants = ["missing", "forged", "duplicate", "invalid"];
  for (const stage of ["questions", "queries"]) for (const variant of variants) {
    const ai = f.ai(async input => {
      const data = await payload(input.directory), normal = await defaultRunner(input);
      if (data.step !== stage) return normal;
      const items = stage === "questions" ? data.items.map(item => ({ targetRef: item.targetRef, questions: ["a", "b", "c"] }))
        : data.items.map(item => ({ questionRef: item.questionRef, queries: ["needle"] }));
      if (variant === "missing") items.pop();
      if (variant === "duplicate") items[1] = items[0]!;
      if (variant === "forged") items[0] = stage === "questions" ? { targetRef: "forged", questions: ["a", "b", "c"] } : { questionRef: "forged", queries: ["needle"] };
      if (variant === "invalid") items[0] = stage === "questions" ? { targetRef: "0", questions: ["one"] } : { questionRef: "0:0", queries: ["x".repeat(257)] };
      return { items };
    });
    const status = await f.run(ai, `${stage}-${variant}`); assert.equal(status.error?.code, "AI_OUTPUT_INVALID", JSON.stringify(status));
    assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM retrieval_check").get(), { n: 0 });
    assert.equal(f.issues.active().length, 0);
  }
});

test("commit rechecks versions and candidate state, and batch records roll back together on a late conflict", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(1); f.seed(2);
  const ai = f.ai(async input => {
    const data = await payload(input.directory);
    if (data.step === "queries") f.db.transaction(() => f.assets.revise("ast2", 0, { ...f.assets.get("ast2")!, summary: "concurrent edit" })).immediate();
    return defaultRunner(input);
  });
  assert.equal((await f.run(ai, "race")).error?.code, "VERSION_CONFLICT");
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM retrieval_check").get(), { n: 0 });
  assert.equal(f.issues.active().length, 0);
  f.db.transaction(() => f.candidates.insert({ ...f.assets.get("ast1")!, assetId: "ast3", candidateId: "cnd3", intent: "NEW", baseVersion: null })).immediate();
  const candidateRace = f.ai(async input => {
    if ((await payload(input.directory)).step === "queries") f.db.transaction(() => f.candidates.setStatus("cnd3", 0, "REJECTED")).immediate();
    return defaultRunner(input);
  });
  assert.equal((await f.run(candidateRace, "candidate-race", { kind: "CANDIDATE", id: "cnd3" })).error?.code, "VERSION_CONFLICT");
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM retrieval_check").get(), { n: 0 });
});

test("reference extraction checks current sections and known extensions, consumes URL/absolute tokens and skips old formats", () => {
  const paths = "`knowledge/model.ts` scanner.ts src/View.vue:12 claude.ai 3.54 Recall/Read/Used /abs/file.ts ~/file.ts https://example.com/link.ts C:\\code\\file.ts [link](https://host/file.ts)";
  const markdown = `## 结论与适用条件\n${paths}\n## 依据与验证边界\nhistory.ts\n## 再次使用时的核验点\n./next.md\n## 历史依据\ngone.ts`;
  assert.deepEqual(extractReferencePaths("MEMORY", markdown), ["knowledge/model.ts", "scanner.ts", "src/View.vue", "next.md"]);
  assert.deepEqual(extractReferencePaths("MEMORY", "旧格式 src/old.ts"), []);
  assert.deepEqual(extractReferencePaths("SKILL", "## 触发条件\nignore.ts\n## 输入与前置条件\na.java\n## 步骤\nb.py\n### 子步骤\nc.go\n## 验证\nd.sql\n## 历史依据\nold.md"), ["a.java", "b.py", "c.go", "d.sql"]);
  assert.deepEqual(extractReferencePaths("DOCUMENT", "now.ts\n## 历史依据\nold.ts\n### 子节\nolder.ts\n## 用法\nnext.ts"), ["now.ts", "next.ts"]);
  assert.deepEqual(extractReferencePaths("SKILL", "old.ts"), []);
  assert.deepEqual(extractReferencePaths("DOCUMENT", "../outside.ts ./local.ts"), ["../outside.ts", "local.ts"]);
});

for (const git of [false, true]) test(`reference matching ${git ? "Git" : "directory traversal"}: exact paths, segment boundaries and leading dot`, async t => {
  const f = await fixture(); t.after(() => f.close());
  const cases = [
    { reference: "model.ts", file: "xmodel.ts", broken: ["model.ts"] },
    { reference: "knowledge/model.ts", file: "foo-knowledge/model.ts", broken: ["knowledge/model.ts"] },
    { reference: "knowledge/model.ts", file: "apps/server/src/knowledge/model.ts", broken: [] },
    { reference: "knowledge/model.ts", file: "knowledge/model.ts", broken: [] },
    { reference: "./x.ts", file: "x.ts", broken: [] },
  ];
  for (const [index, entry] of cases.entries()) {
    const root = join(f.root, `workspace-${index}`), file = join(root, entry.file);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, "");
    if (git) {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "add", entry.file]);
    }
    const checker = new ReferenceChecker({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [root], aliases: [], description: "test" }] });
    assert.deepEqual(await checker.broken({ type: "MEMORY", scope: "WORKSPACE", workspace: "alpha",
      bodyMarkdown: `## 结论与适用条件\n${entry.reference}` }), entry.broken, `${entry.reference} against ${entry.file}`);
  }
});

for (const git of [false, true]) test(`reference inventory ${git ? "Git tracked/untracked" : "directory traversal"}: suffixes, exclusions, caching, missing paths and issue dedup`, async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = join(f.root, "workspace"); await mkdir(join(root, "src/deep"), { recursive: true });
  await writeFile(join(root, "src/deep/exists.ts"), ""); await writeFile(join(root, "new.vue"), "");
  await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules/ignored.ts"), "");
  if (git) {
    execFileSync("git", ["init", "-q", root]); await writeFile(join(root, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["-C", root, "add", "src/deep/exists.ts"]);
    await writeFile(join(root, "deleted.ts"), ""); execFileSync("git", ["-C", root, "add", "deleted.ts"]); await rm(join(root, "deleted.ts"));
  }
  const config = { schemaVersion: 1 as const, workspaces: [{ name: "alpha", paths: [root], aliases: [], description: "test" }] };
  await writeFile(f.options.workspaceConfigPath, JSON.stringify(config));
  const asset = f.seed(1, { scope: "WORKSPACE", workspace: "alpha", bodyMarkdown: "## 结论与适用条件\nexists.ts new.vue missing.ts ignored.ts deleted.ts\n## 历史依据\nhistorical.ts" });
  const checker = new ReferenceChecker(config);
  assert.deepEqual(await checker.broken(asset), ["missing.ts", "ignored.ts", "deleted.ts"]);
  await writeFile(join(root, "missing.ts"), "");
  assert.deepEqual(await checker.broken(asset), ["missing.ts", "ignored.ts", "deleted.ts"]); assert.equal(checker.files.size, 1);
  assert.deepEqual(await new ReferenceChecker({ ...config, workspaces: [{ ...config.workspaces[0]!, paths: [join(root, "absent")] }] }).broken(asset), []);
  assert.deepEqual(await checker.broken({ ...asset, scope: "GLOBAL", workspace: null }), []);
  const secondRoot = join(f.root, "second-workspace"); await mkdir(secondRoot); await writeFile(join(secondRoot, "ignored.ts"), "");
  const multi = new ReferenceChecker({ ...config, workspaces: [{ ...config.workspaces[0]!, paths: [root, secondRoot] }] });
  assert.deepEqual(await multi.broken(asset), ["deleted.ts"]);
  const ai = f.ai(); await f.run(ai, "refs");
  let problem = f.issues.active().find(row => row.kind === "BROKEN_REFERENCE")!;
  assert.equal(problem.source, "REFERENCE_CHECK"); assert.match(problem.detail, /ignored.ts\ndeleted.ts/u); assert.equal(problem.queries, null);
  assert.deepEqual(f.db.prepare("SELECT check_id FROM asset_issue WHERE issue_id=?").get(problem.issueId), { check_id: null });
  await rm(join(root, "missing.ts")); await f.run(ai, "refs-update", { kind: "ASSET", id: "ast1" });
  assert.equal(f.issues.active().find(row => row.kind === "BROKEN_REFERENCE")!.issueId, problem.issueId);
  problem = f.issues.active().find(row => row.kind === "BROKEN_REFERENCE")!; assert.match(problem.detail, /missing.ts/u);
  f.db.transaction(() => f.issues.transition(problem, "DISMISSED", null)).immediate();
  await f.run(ai, "refs-dismissed", { kind: "ASSET", id: "ast1" });
  assert.equal(f.issues.active().filter(row => row.kind === "BROKEN_REFERENCE").length, 0);
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM asset_issue WHERE kind='BROKEN_REFERENCE'").get(), { n: 1 });
});
