import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateFixture, content, selection } from "../test-support/candidate-fixture.js";
import { openDatabase, PERSISTENT_TABLES } from "../src/storage/schema.js";
import { assessmentDirectory, handleCaptureHook, recordAssessment } from "../src/hook/capture-assessment.js";

const turn = { sessionId: "legacy-session", turnId: "legacy-turn", outcome: "NO_INCREMENT", reason: "isolated compatibility" };
const legacyTables = ["asset_issue", "retrieval_check"] as const;

test("new databases omit retired tables and remain readable and writable without recreating them", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  for (const readonly of [true, false, true]) {
    const db = openDatabase(f.options.databasePath, { readonly });
    try {
      for (const name of legacyTables) {
        assert.equal(PERSISTENT_TABLES.some(table => String(table) === name), false);
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=? OR tbl_name=?").get(name, name), undefined);
      }
    } finally { db.close(); }
  }
});

test("legacy tables and data survive writable completion, readonly access and candidate lifecycle without participation", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const formal = (await f.prepare("formal", [content()])).candidates[0]!;
  await f.service.accept(selection(formal, "accept-formal"));
  const db = openDatabase(f.options.databasePath); t.after(() => db.close());
  db.exec(await readFile(new URL("../test-support/retired-issue-schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO retrieval_check(check_id,target_kind,target_id,target_version,result,passed) VALUES ('chk1','ASSET',?,0,'[]',1)").run(formal.assetId);
  db.prepare("INSERT INTO asset_issue(issue_id,asset_id,asset_version,kind,detail,source,check_id,status) VALUES ('isu1',?,0,'UNREACHABLE','historical','RETRIEVAL_CHECK','chk1','OPEN')").run(formal.assetId);
  const snapshot = () => legacyTables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  for (const readonly of [false, true]) {
    const reopened = openDatabase(f.options.databasePath, { readonly }); reopened.close();
    assert.deepEqual(snapshot(), before);
  }
  // Force the additive path as well as the normal complete-schema path.
  db.exec("ALTER TABLE read_operation RENAME TO saved_read_operation");
  openDatabase(f.options.databasePath).close();
  assert.deepEqual(snapshot(), before);
  const revision = (await f.prepare("revision", [{ ...content("revision"), existingAssetId: formal.assetId, baseVersion: 0 }])).candidates[0]!;
  const { title, summary, retrievalTerms } = content();
  const rewritten = await f.service.rewrite(selection(revision, "rewrite"), { title, summary, retrievalTerms, bodyMarkdown: "rewritten" });
  await f.service.reject(selection(rewritten, "reject"));
  const accepted = (await f.prepare("revision-accept", [{ ...content("accepted"), existingAssetId: formal.assetId, baseVersion: 0 }])).candidates[0]!;
  await f.service.accept({ ...selection(accepted, "accept"), baseVersion: 0 });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual((await f.service.list()).items, []);
  const readonly = openDatabase(f.options.databasePath, { readonly: true }); readonly.close();
});

test("knowledgeIssues is accepted and ignored for both hosts without database or cache payload writes", async t => {
  const f = await candidateFixture(); t.after(() => f.cleanup());
  const bytesBefore = await readFile(f.options.databasePath);
  const cache = join(f.root, "capture");
  const db = openDatabase(f.options.databasePath); t.after(() => db.close());
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const host of ["codex", "claude"] as const) {
      for (const knowledgeIssues of [undefined, null, {}, "invalid", 42, [], [null],
        [{ assetId: "ast1", kind: "OUTDATED", detail: "legacy", extra: true }]]) {
        assert.deepEqual(await recordAssessment(cache, { ...turn, knowledgeIssues }, host), { recorded: true });
        assert.deepEqual(JSON.parse(await readFile(join(assessmentDirectory(cache, turn, host), "assessment.json"), "utf8")), turn);
        assert.deepEqual(await handleCaptureHook({ session_id: turn.sessionId,
          [host === "codex" ? "turn_id" : "prompt_id"]: turn.turnId, hook_event_name: "Stop" }, cache, host), {});
      }
      for (const invalid of [{ outcome: "bad" }, { reason: "" }, { sessionId: "" }, { turnId: null }, { references: 1 }, { unknown: true }, { outcome: "CANDIDATE" }])
        await assert.rejects(recordAssessment(cache, { ...turn, ...invalid, knowledgeIssues: [] }, host));
    }
  } finally { db.exec("ROLLBACK"); }
  assert.deepEqual(await readFile(f.options.databasePath), bytesBefore);
});
