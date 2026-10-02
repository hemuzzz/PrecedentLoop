import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { CandidateService } from "../src/asset/candidate-service.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { AssetRepository } from "../src/asset/asset-repository.js";
import { candidateFixture as fixture, content, selection } from "../test-support/candidate-fixture.js";

const exec = promisify(execFile);

test("prepare, defer, accept and reject share durable identity and never reuse candidate numbers", async () => {
  const f = await fixture();
  try {
    const first = (await f.prepare("prepare-a", [content()])).candidates[0]!;
    assert.match(first.candidateId, /^cnd\d+$/); assert.equal(first.number, 1);
    await f.service.defer({ ...selection(first, "defer-a"), deferred: true });
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, first.candidateId);
    const accepted = await f.service.accept(selection(first, "accept-a"));
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal((await f.service.formalAssets())[0]?.version, 0);
    assert.deepEqual(await f.service.accept(selection(first, "accept-a")), accepted);
    const next = (await f.prepare("prepare-b", [content("另一条")])).candidates[0]!;
    await f.service.reject(selection(next, "reject-b"));
    assert.deepEqual(await new CandidateService(f.options).operation("reject-b"), { rejected: true, candidateId: next.candidateId });
    const last = (await f.prepare("prepare-c", [content("第三条")])).candidates[0]!;
    assert.ok(last.number > next.number); assert.notEqual(last.candidateId, next.candidateId);
    assert.equal((await f.service.formalAssets()).length, 1);
  } finally { await f.cleanup(); }
});

test("zero-result imports commit a queryable receipt and reused requests cannot change input", async () => {
  const f = await fixture();
  try {
    const result = await f.prepare("empty", [], { operation: "import", warnings: ["没有独立增量"] });
    assert.equal(result.count, 0);
    assert.deepEqual(await new CandidateService(f.options).operation("empty"), result);
    await assert.rejects(f.prepare("empty", [content()]), { code: "REQUEST_ID_CONFLICT" });
    assert.equal((await f.service.list()).items.length, 0);
  } finally { await f.cleanup(); }
});

test("receipt failure rolls back a whole batch; retry creates all candidates", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON write_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.prepare("failed-batch", [content("A"), content("B")]), /injected/);
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.operation("failed-batch"), undefined);
    db.exec("DROP TRIGGER reject_receipt");
    assert.equal((await f.prepare("failed-batch", [content("A"), content("B")])).count, 2);
  } finally { db.close(); await f.cleanup(); }
});

test("failed formal acceptance restores candidate, current content, previous content and FTS", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    const a = (await f.prepare("a", [content("A")])).candidates[0]!;
    await f.service.accept(selection(a, "accept-a"));
    const b = (await f.prepare("b", [{ ...content("B"), existingAssetId: a.assetId, baseVersion: 0 }])).candidates[0]!;
    const before = new AssetRepository(db).get(a.assetId);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON write_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.service.accept({ ...selection(b, "accept-b"), baseVersion: 0 }), /injected/);
    assert.deepEqual(new AssetRepository(db).get(a.assetId), before);
    assert.equal((await f.service.list()).items[0]?.version, 0);
    assert.equal(await f.service.operation("accept-b"), undefined);
    assert.equal((db.prepare("SELECT body_markdown FROM asset_fts WHERE asset_id=?").get(a.assetId) as { body_markdown: string }).body_markdown, "A");
    db.exec("DROP TRIGGER reject_receipt");
    await f.service.accept({ ...selection(b, "accept-b"), baseVersion: 0 });
    const current = new AssetRepository(db).get(a.assetId)!;
    assert.equal(current.version, 1); assert.equal(current.bodyMarkdown, "B"); assert.equal(current.previousContent!.bodyMarkdown, "A");
  } finally { db.close(); await f.cleanup(); }
});

for (const committed of [false, true]) test(`process death ${committed ? "after" : "before"} COMMIT preserves the transaction decision`, async () => {
  const f = await fixture();
  try {
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {openDatabase} from ${JSON.stringify(resolve("src/storage/schema.ts"))};
      import {CandidateRepository} from ${JSON.stringify(resolve("src/asset/candidate-repository.ts"))};
      const db=openDatabase(${JSON.stringify(f.options.databasePath)}), repository=new CandidateRepository(db);
      repository.write('crash','prepare','input',()=>{
        repository.insert({candidateId:'cnd1',assetId:'ast1',intent:'NEW',baseVersion:null,type:'MEMORY',scope:'GLOBAL',workspace:null,title:'title',summary:'summary',retrievalTerms:[],bodyMarkdown:'A'});
        if(!${committed}) process.exit(73);
        return {count:1};
      }); process.exit(73);
    `]), (error: unknown) => error instanceof Error && "code" in error && error.code === 73);
    assert.equal((await f.service.list()).items.length, committed ? 1 : 0);
    assert.equal((await f.service.operation("crash")) !== undefined, committed);
  } finally { await f.cleanup(); }
});

test("another process rejects stale versions while unrelated candidates remain writable", async () => {
  const f = await fixture();
  try {
    const [a, b] = (await f.prepare("both", [content("A"), content("B")])).candidates;
    await f.service.rewrite(selection(a!, "rewrite"), { title: "changed", summary: "summary", retrievalTerms: content().retrievalTerms, bodyMarkdown: "changed" });
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { CandidateService } from ${JSON.stringify(resolve("src/asset/candidate-service.ts"))};
      try { await new CandidateService(${JSON.stringify(f.options)}).reject(${JSON.stringify(selection(a!, "reject-stale"))}); }
      catch(error) { console.log(error.code); }
    `]);
    assert.match(stdout, /VERSION_CONFLICT/);
    await f.service.reject(selection(b!, "reject-other"));
    assert.equal((await f.service.list()).items.length, 1);
    assert.equal(await f.service.operation("reject-stale"), undefined);
  } finally { await f.cleanup(); }
});

test("readers cannot observe an uncommitted batch", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    new CandidateRepository(db).insert({ candidateId: "cnd1", assetId: "ast1", intent: "NEW", baseVersion: null, type: "MEMORY", scope: "GLOBAL", workspace: null, title: "title", summary: "summary", retrievalTerms: [], bodyMarkdown: "body" });
    assert.equal((await f.service.list()).items.length, 0);
    db.exec("COMMIT");
    assert.equal((await f.service.list()).items.length, 1);
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); await f.cleanup(); }
});

test("failure inserting the second candidate rolls back the first and the receipt", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON asset_candidate WHEN NEW.asset_type='SKILL' BEGIN SELECT RAISE(ABORT,'second'); END");
    await assert.rejects(f.prepare("partial", [content("A"), { ...content("B"), type: "SKILL" }]), /second/);
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.operation("partial"), undefined);
  } finally { db.close(); await f.cleanup(); }
});

test("A to B to A to B revisions use increasing versions and rotate one previous content", async () => {
  const f = await fixture();
  try {
    const first = (await f.prepare("a", [content("A")])).candidates[0]!;
    await f.service.accept(selection(first, "accept-a"));
    for (const [version, body] of ["B", "A", "B"].entries()) {
      const candidate = (await f.prepare("revise-" + version, [{ ...content(body), existingAssetId: first.assetId, baseVersion: version }])).candidates[0]!;
      const input = { ...selection(candidate, "accept-" + version), baseVersion: version };
      const accepted = await f.service.accept(input);
      assert.equal(accepted.version, version + 1); assert.deepEqual(await f.service.accept(input), accepted);
    }
    const current = (await f.service.formalAssets())[0]!;
    assert.equal(current.bodyMarkdown, "B"); assert.equal(current.previousContent!.bodyMarkdown, "A"); assert.equal(current.version, 3);
  } finally { await f.cleanup(); }
});

test("unchanged rewrites return to pending without increasing the content version", async () => {
  const f = await fixture();
  try {
    const item = (await f.prepare("a", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    const rewrite = await f.service.rewrite(selection(item, "no-change"), { title: content().title, summary: content().summary, retrievalTerms: content().retrievalTerms, bodyMarkdown: content().bodyMarkdown });
    assert.equal(rewrite.changed, false); assert.equal(rewrite.version, 0);
    assert.equal((await f.service.list("PENDING")).items.length, 1);
    assert.equal((await f.service.list("DEFERRED")).items.length, 0);
  } finally { await f.cleanup(); }
});

test("rewrite and rejection restore content and status when receipt insertion fails", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    const item = (await f.prepare("a", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    const before = (await f.service.list()).items[0]!;
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON write_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.service.rewrite(selection(item, "rewrite"), { title: "新标题", summary: "新摘要", retrievalTerms: content().retrievalTerms, bodyMarkdown: "新正文" }), /injected/);
    await assert.rejects(f.service.reject(selection(item, "reject")), /injected/);
    assert.deepEqual((await f.service.list("DEFERRED")).items[0], before);
    assert.equal(await f.service.operation("rewrite"), undefined); assert.equal(await f.service.operation("reject"), undefined);
  } finally { db.close(); await f.cleanup(); }
});
