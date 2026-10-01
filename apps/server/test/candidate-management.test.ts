import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { AssetContentVersionRepository } from "../src/asset/content-version.js";
import { CandidateService, type CandidateSummary, type PrepareItem } from "../src/asset/candidate-service.js";
import { freezeAssets, releaseAssets, withRepositoryAccess } from "../src/asset/coordination.js";
import { scanInboxRepository, scanAssetRepository } from "../src/asset/scanner.js";

const exec = promisify(execFile);
const content = (body = "原文"): PrepareItem => ({ title: "事务知识", summary: "准确摘要", bodyMarkdown: body, type: "MEMORY", target: { scope: "GLOBAL" } });
const selection = (item: CandidateSummary, requestId: string) => ({ requestId, candidateId: item.candidateId, assetId: item.assetId, candidateHash: item.contentHash });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "candidate-management-"));
  const options = { repositoryPath: join(root, "repository"), databasePath: join(root, "data.sqlite"), workspaceConfigPath: join(root, "workspaces.json") };
  await mkdir(join(options.repositoryPath, "assets"), { recursive: true });
  await writeFile(options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  initializeDatabase(options.databasePath);

  const service = new CandidateService(options);
  await service.initialize();
  return { root, options, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("prepare, defer, accept and reject share durable identity and do not reuse committed candidate IDs", async () => {
  const f = await fixture();
  try {
    const first = (await f.service.prepare("prepare-a", [content()])).candidates[0]!;
    assert.equal(first.candidateId, "1");
    await f.service.defer({ ...selection(first, "defer-a"), deferred: true });
    assert.equal((await f.service.list("DEFERRED")).items[0]?.candidateId, first.candidateId);
    const accepted = await f.service.accept(selection(first, "accept-a"));
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal((await scanAssetRepository(f.options)).assets[0]?.contentHash, first.contentHash);
    assert.deepEqual(await f.service.accept(selection(first, "accept-a")), accepted);
    const next = (await f.service.prepare("prepare-b", [content("另一条")])).candidates[0]!;
    await f.service.reject(selection(next, "reject-b"));
    assert.deepEqual(await new CandidateService(f.options).operation("reject-b"), { deleted: true, candidateId: next.candidateId });
    const last = (await f.service.prepare("prepare-c", [content("第三条")])).candidates[0]!;
    assert.ok(BigInt(last.candidateId) > BigInt(next.candidateId));
    assert.equal((await scanAssetRepository(f.options)).assets.length, 1);
  } finally { await f.cleanup(); }
});

test("zero-result imports commit a queryable receipt and a reused request cannot change input", async () => {
  const f = await fixture();
  try {
    const result = await f.service.prepare("empty", [], undefined, { warnings: ["没有独立增量"] });
    assert.equal(result.count, 0);
    assert.deepEqual(await new CandidateService(f.options).operation("empty"), result);
    await assert.rejects(f.service.prepare("empty", [content()]), { code: "REQUEST_ID_CONFLICT" });
    assert.equal((await scanInboxRepository(f.options)).assets.length, 0);
  } finally { await f.cleanup(); }
});

test("SQL failure after all files are written restores the whole batch and records no success", async () => {
  const f = await fixture();
  const database = new Database(f.options.databasePath);
  try {
    database.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON inbox_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.service.prepare("failed-batch", [content("A"), content("B")]));
    assert.equal((await scanInboxRepository(f.options)).assets.length, 0);
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.operation("failed-batch"), undefined);
    database.exec("DROP TRIGGER reject_receipt");
    assert.equal((await f.service.prepare("retry-batch", [content("A"), content("B")])).count, 2);
  } finally { database.close(); await f.cleanup(); }
});

test("failed formal acceptance restores candidate and prior CURRENT/PREVIOUS", async () => {
  const f = await fixture();
  const database = new Database(f.options.databasePath);
  try {
    const a = (await f.service.prepare("a", [content("A")])).candidates[0]!;
    await f.service.accept(selection(a, "accept-a"));
    const b = (await f.service.prepare("b", [{ ...content("B"), existingAssetId: a.assetId, baselineHash: a.contentHash }])).candidates[0]!;
    database.exec("CREATE TRIGGER reject_current BEFORE INSERT ON asset_content_version BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.service.accept({ ...selection(b, "accept-b"), baselineHash: a.contentHash }));
    assert.equal((await scanAssetRepository(f.options)).assets[0]?.contentHash, a.contentHash);
    assert.equal((await f.service.list()).items[0]?.contentHash, b.contentHash);
    assert.equal(await f.service.operation("accept-b"), undefined);
    database.exec("DROP TRIGGER reject_current");
    await f.service.accept({ ...selection(b, "accept-b-retry"), baselineHash: a.contentHash });
    const versions = new AssetContentVersionRepository(f.options.databasePath);
    try {
      const rows = versions.read(a.assetId); assert.ok(Array.isArray(rows));
      assert.equal(rows.find(row => row.status === "CURRENT")?.contentHash, b.contentHash);
      assert.equal(rows.find(row => row.status === "PREVIOUS")?.contentHash, a.contentHash);
    } finally { versions.close(); }
  } finally { database.close(); await f.cleanup(); }
});

for (const stage of ["prepared", "file-written", "database-committed"] as const) {
  test(`process death at ${stage}: first reader recovers using commit fact`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { CandidateService } from ${JSON.stringify(resolve("src/asset/candidate-service.ts"))};
        const service = new CandidateService({ ...${JSON.stringify(f.options)}, checkpoint: async stage => { if(stage === ${JSON.stringify(stage)}) process.exit(73); } });
        await service.prepare('crash', [${JSON.stringify(content("A"))}, ${JSON.stringify(content("B"))}]);
      `]), (error: unknown) => error instanceof Error && "code" in error && error.code === 73);
      const expected = stage === "database-committed" ? 2 : 0;
      assert.equal((await scanInboxRepository(f.options)).assets.length, expected);
      assert.equal((await f.service.list()).items.length, expected);
      assert.equal((await f.service.operation("crash")) !== undefined, stage === "database-committed");
    } finally { await f.cleanup(); }
  });
}

test("freeze is enforced by another process; unrelated candidates remain writable", async () => {
  const f = await fixture();
  try {
    const [a, b] = (await f.service.prepare("both", [content("A"), content("B")])).candidates;
    await withRepositoryAccess(f.options.repositoryPath, async () => freezeAssets(f.options.repositoryPath, [a!.assetId], "generation"));
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { CandidateService } from ${JSON.stringify(resolve("src/asset/candidate-service.ts"))};
      try { await new CandidateService(${JSON.stringify(f.options)}).reject(${JSON.stringify(selection(a!, "delete-frozen"))}); }
      catch(error) { console.log(error.code); }
    `]);
    assert.match(stdout, /ASSET_FROZEN/u);
    await f.service.reject(selection(b!, "delete-other"));
    await releaseAssets(f.options.repositoryPath, "generation");
    await f.service.reject(selection(a!, "delete-released"));
    assert.equal((await f.service.list()).items.length, 0);
  } finally { await f.cleanup(); }
});

test("readers cannot observe a batch between file publication and SQL COMMIT", async () => {
  const f = await fixture();
  let continueCommit!: () => void;
  let filesWritten!: () => void;
  const pause = new Promise<void>(resolve => { continueCommit = resolve; });
  const reached = new Promise<void>(resolve => { filesWritten = resolve; });
  try {
    const writer = new CandidateService({ ...f.options, checkpoint: async stage => { if (stage === "file-written") { filesWritten(); await pause; } } });
    const write = writer.prepare("batch", [content("A"), content("B")]);
    await reached;
    let delivered = false;
    const read = f.service.list().then(result => { delivered = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(delivered, false);
    continueCommit(); await write;
    assert.equal((await read).items.length, 2);
  } finally { continueCommit(); await f.cleanup(); }
});

test("external candidate changes and unknown targets are never overwritten", async () => {
  const f = await fixture();
  try {
    const a = (await f.service.prepare("a", [content("A")])).candidates[0]!;
    const item = (await f.service.list()).items[0]!;
    const path = join(f.options.repositoryPath, item.relativePath);
    const changed = (await readFile(path, "utf8")) + "\n外部修改\n";
    await writeFile(path, changed);
    await assert.rejects(f.service.reject(selection(a, "reject-changed")), { code: "CONTENT_HASH_MISMATCH" });
    assert.equal(await readFile(path, "utf8"), changed);
  } finally { await f.cleanup(); }
});

test("failure publishing the second file rolls back the first file and the entire batch", async () => {
  const f = await fixture(); let protectedDirectory = "";
  const writer = new CandidateService({ ...f.options, checkpoint: async stage => {
    if (stage === "prepared") {
      const journal = JSON.parse(await readFile(join(f.options.repositoryPath, ".candidate-transaction.json"), "utf8")) as { changes: Array<{ relativePath: string }> };
      protectedDirectory = dirname(join(f.options.repositoryPath, journal.changes[1]!.relativePath)); await chmod(protectedDirectory, 0o555);
    }
  } });
  try {
    await assert.rejects(writer.prepare("partial-files", [content("A"), { ...content("B"), type: "SKILL" }]), { code: "FILE_OPERATION_FAILED" });
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.operation("partial-files"), undefined);
  } finally { if (protectedDirectory) await chmod(protectedDirectory, 0o755); await f.cleanup(); }
});

test("path-only confirmation can cycle A to B to A to B without reusing a historical confirmation", async () => {
  const f = await fixture();
  try {
    const a = (await f.service.prepare("a", [content("A")])).candidates[0]!;
    await f.service.accept(selection(a, "accept-a"));
    const b = (await f.service.prepare("b", [{ ...content("B"), existingAssetId: a.assetId, baselineHash: a.contentHash }])).candidates[0]!;
    const itemB = (await f.service.list()).items[0]!;
    const confirm = { relativePath: itemB.relativePath, updateAssetId: a.assetId, expectedBaselineHash: a.contentHash, expectedContentHash: b.contentHash };
    await f.service.confirmPath(confirm);
    const aAgain = (await f.service.prepare("a-again", [{ ...content("A"), existingAssetId: a.assetId, baselineHash: b.contentHash }])).candidates[0]!;
    await f.service.accept({ ...selection(aAgain, "accept-a-again"), baselineHash: b.contentHash });
    await f.service.prepare("b-again", [{ ...content("B"), existingAssetId: a.assetId, baselineHash: a.contentHash }]);
    await f.service.confirmPath(confirm); await f.service.confirmPath(confirm);
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal((await scanAssetRepository(f.options)).assets[0]?.contentHash, b.contentHash);
  } finally { await f.cleanup(); }
});

test("no-change rewrite preserves deferred state; an external changed deferred file returns to visible pending diagnostics", async () => {
  const f = await fixture();
  try {
    const item = (await f.service.prepare("a", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    const rewrite = await f.service.rewrite(selection(item, "no-change"), { title: content().title, summary: content().summary, bodyMarkdown: content().bodyMarkdown });
    assert.equal(rewrite.changed, false); assert.equal((await f.service.list("DEFERRED")).items.length, 1);
    const row = (await f.service.list()).items[0]!;
    await writeFile(join(f.options.repositoryPath, row.relativePath), row.rawMarkdown + "\n外部新稿");
    assert.equal((await f.service.list("DEFERRED")).items.length, 0);
    assert.match((await f.service.list("PENDING")).items[0]!.problem!, /外部/u);
  } finally { await f.cleanup(); }
});

test("formal duplicate identity and candidate symlink are rejected without overwriting files", async () => {
  const f = await fixture();
  try {
    const item = (await f.service.prepare("a", [content()])).candidates[0]!;
    const row = (await f.service.list()).items[0]!;
    const directory = join(f.options.repositoryPath, "assets/global/memories"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "copy-a.md"), row.rawMarkdown); await writeFile(join(directory, "copy-b.md"), row.rawMarkdown);
    await assert.rejects(f.service.accept(selection(item, "duplicate")), { code: "ASSET_ID_CONFLICT" });
    assert.equal(await readFile(join(f.options.repositoryPath, row.relativePath), "utf8"), row.rawMarkdown);
    const outside = join(f.root, "outside.md"); await writeFile(outside, row.rawMarkdown + "\nPRIVATE");
    await unlink(join(f.options.repositoryPath, row.relativePath)); await symlink(outside, join(f.options.repositoryPath, row.relativePath));
    await assert.rejects(f.service.reject(selection(item, "symlink")));
    assert.match(await readFile(outside, "utf8"), /PRIVATE/u);
    assert.equal((await f.service.list()).items.length, 0);
  } finally { await f.cleanup(); }
});

test("rewrite and deletion restore the original bytes and review bucket when receipt insertion fails", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath);
  try {
    const item = (await f.service.prepare("a", [content()])).candidates[0]!;
    await f.service.defer({ ...selection(item, "defer"), deferred: true });
    const before = (await f.service.list()).items[0]!;
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON inbox_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(f.service.rewrite(selection(item, "rewrite"), { title: "新标题", summary: "新摘要", bodyMarkdown: "新正文" }), { code: "DATABASE_WRITE_FAILED" });
    await assert.rejects(f.service.reject(selection(item, "reject")), { code: "DATABASE_WRITE_FAILED" });
    const after = (await f.service.list("DEFERRED")).items[0]!;
    assert.equal(after.rawMarkdown, before.rawMarkdown); assert.equal(after.contentHash, before.contentHash);
    assert.equal(await f.service.operation("rewrite"), undefined); assert.equal(await f.service.operation("reject"), undefined);
  } finally { db.close(); await f.cleanup(); }
});

test("cleanup failure after COMMIT is still success and the next access completes cleanup without rotating again", async () => {
  const f = await fixture();
  try {
    const writer = new CandidateService({ ...f.options, checkpoint: async stage => { if (stage === "database-committed") throw new Error("cleanup interrupted"); } });
    const result = await writer.prepare("committed", [content()]);
    assert.equal(result.count, 1);
    assert.deepEqual(await f.service.operation("committed"), result);
    assert.equal((await f.service.list()).items.length, 1);
    await assert.rejects(readFile(join(f.options.repositoryPath, ".candidate-transaction.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

for (const action of ["rewrite", "reject"] as const) for (const stage of ["prepared", "file-written", "database-committed"] as const) {
  test(`${action} process death at ${stage} follows the same COMMIT decision`, async () => {
    const f = await fixture();
    try {
      const item = (await f.service.prepare("a", [content()])).candidates[0]!;
      await f.service.defer({ ...selection(item, "defer"), deferred: true });
      await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { CandidateService } from ${JSON.stringify(resolve("src/asset/candidate-service.ts"))};
        const service=new CandidateService({...${JSON.stringify(f.options)},checkpoint:async stage=>{if(stage===${JSON.stringify(stage)})process.exit(73);}});
        await service.${action}(${JSON.stringify(selection(item, action))}${action === "rewrite" ? ',{title:"改稿",summary:"摘要",bodyMarkdown:"新正文"}' : ""});
      `]), (error: unknown) => error instanceof Error && "code" in error && error.code === 73);
      const committed = stage === "database-committed";
      const rows = (await f.service.list()).items;
      assert.equal((await f.service.operation(action)) !== undefined, committed);
      if (action === "reject" && committed) assert.equal(rows.length, 0);
      else {
        assert.equal(rows[0]?.candidateId, item.candidateId);
        assert.equal(rows[0]?.reviewBucket, committed ? "PENDING" : "DEFERRED");
        assert.equal(rows[0]?.contentHash === item.contentHash, !committed);
      }
    } finally { await f.cleanup(); }
  });
}

test("recovery interrupted after restoring one file resumes rollback on the next reader", async () => {
  const f = await fixture();
  try {
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { CandidateService } from ${JSON.stringify(resolve("src/asset/candidate-service.ts"))};
      const service=new CandidateService({...${JSON.stringify(f.options)},checkpoint:async stage=>{if(stage==='file-written')process.exit(73);}});
      await service.prepare('crash',[${JSON.stringify(content("A"))},${JSON.stringify(content("B"))}]);
    `]), (error: unknown) => error instanceof Error && "code" in error && error.code === 73);
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.unlink;fs.unlink=async path=>{await original(path);if(String(path).includes('/inbox/'))process.exit(74);};syncBuiltinESMExports();
      const {CandidateService}=await import(${JSON.stringify(resolve("src/asset/candidate-service.ts"))});
      await new CandidateService(${JSON.stringify(f.options)}).list();
    `]), (error: unknown) => error instanceof Error && "code" in error && error.code === 74);
    assert.equal((await f.service.list()).items.length, 0);
    assert.equal(await f.service.operation("crash"), undefined);
    await assert.rejects(readFile(join(f.options.repositoryPath, ".candidate-transaction.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
