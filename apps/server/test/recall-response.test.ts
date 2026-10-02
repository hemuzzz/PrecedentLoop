import assert from "node:assert/strict";
import test from "node:test";
import type { RecallResult } from "../src/knowledge/model.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";

test("compact Recall preserves selection, summary qualification and complete stored facts, and its references support Read/Used", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  await f.asset({ title: "compact token memory", workspace: "alpha", summary: '摘要😀 "quoted"' });
  await f.asset({ title: "summary match", summary: "compact token summary" });
  await f.asset({ title: "body only", body: "compact token body" });
  await f.asset({ title: "compact token document", type: "DOCUMENT" });
  await f.asset({ title: "compact token skill", type: "SKILL" });
  const input = { capabilityIds: [f.alpha], queries: ["compact token"] };
  const ranks = f.search.rankedCandidates({ authorizedWorkspaces: ["alpha"] }, input.queries[0]!);
  let internal: RecallResult | undefined;
  const record = f.repository.recordRecall.bind(f.repository);
  t.mock.method(f.repository, "recordRecall", (result: RecallResult) => { internal = structuredClone(result); record(result); });
  const response = await f.service.recall(input);
  assert.ok(internal);
  assert.deepEqual(Object.keys(response).sort(), ["authorizedWorkspaces", "budget", "diagnostics", "items", "reference", "usageRecorded"]);
  assert.equal(response.reference, "asset_read: recallItemId + same capabilityIds");
  assert.deepEqual(response.authorizedWorkspaces, ["alpha"]);
  assert.equal(response.usageRecorded, true);
  // Verified against the pre-change service on this same isolated corpus.
  assert.deepEqual(response.items.map(item => [item.title, item.summary ?? null]), [
    ["compact token memory", '摘要😀 "quoted"'], ["compact token skill", null],
    ["compact token document", null], ["summary match", null], ["body only", null],
  ]);
  assert.deepEqual(response.items.map(item => item.assetId), ranks.map(rank => rank.assetId));
  assert.deepEqual(response.budget, { omittedCount: 0, downgradedCount: 0 });
  for (const [index, item] of response.items.entries()) {
    const rank = ranks[index]!;
    const direct = rank.item.type === "MEMORY" && rank.item.score >= 300;
    assert.equal(item.summary !== undefined, direct);
    assert.deepEqual(Object.keys(item).sort(), ["assetId", "recallItemId", "title", "type", "version", "workspace", ...(direct ? ["summary"] : [])].sort());
    assert.equal(item.workspace, rank.item.workspace ?? null);
    const fact = f.repository.db.prepare<[string], { mode: string; reasons: string; scope: string; workspace: string | null }>(
      "SELECT delivered_mode AS mode,delivery_reasons_json AS reasons,asset_scope AS scope,asset_workspace AS workspace FROM recall_item WHERE recall_item_id=?"
    ).get(item.recallItemId!)!;
    assert.deepEqual(fact, { mode: direct ? "DIRECT" : "ON_DEMAND", reasons: "[]", scope: item.workspace ? "WORKSPACE" : "GLOBAL", workspace: item.workspace });
    assert.equal((await f.service.read({ capabilityIds: input.capabilityIds, recallItemId: item.recallItemId })).assetId, item.assetId);
    assert.equal((await f.service.used({ capabilityIds: input.capabilityIds, recallItemId: item.recallItemId })).created, true);
  }
  const stored = f.projection.recalls().items[0]!;
  assert.equal(stored.recallId, internal.recallId);
  assert.equal(stored.occurredAt, internal.occurredAt);
  assert.deepEqual(stored.queries, input.queries);
  assert.deepEqual(stored.budget, internal.budget);
  const length = (text: string) => Array.from(text).length;
  const knowledgeCharacters = response.items.reduce((sum, item) => sum + length(JSON.stringify(item.title)) - 2
    + (item.summary === undefined ? 0 : length(JSON.stringify(item.summary)) - 2), 0);
  assert.deepEqual(stored.budget, {
    maxAssets: 8, maxModelVisibleCharacters: 5000, modelVisibleCharacters: length(JSON.stringify(response)),
    knowledgeContentCharacters: knowledgeCharacters, metadataCharacters: length(JSON.stringify(response)) - knowledgeCharacters,
    deliveredAssets: 5, omittedCount: 0, downgradedCount: 0,
  });
});

test("compact metadata removes the old character downgrade for eight eligible medium summaries", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  const expected: string[] = [], summary = "摘要😀".repeat(60);
  for (let index = 0; index < 8; index++) expected.push((await f.asset({ title: `compact token ${index}`, summary })).assetId);
  // The pre-change service delivered the same eight assets with one summary downgraded.
  const response = await f.service.recall({ capabilityIds: [f.alpha], queries: ["compact token"] });
  assert.deepEqual(new Set(response.items.map(item => item.assetId)), new Set(expected));
  assert.deepEqual(response.items.map(item => item.summary), Array<string>(8).fill(summary));
  assert.deepEqual(response.budget, { omittedCount: 0, downgradedCount: 0 });
  assert.ok(Array.from(JSON.stringify(response)).length <= 5000);
});

test("downgrade reasons are emitted only when present and complete budgets measure the escaped Unicode response", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  for (let index = 0; index < 10; index++) await f.asset({ title: `budget token ${index}`, summary: '😀"\\'.repeat(1000) });
  const response = await f.service.recall({ capabilityIds: [], queries: ["budget token"] });
  assert.equal(response.items.length, 8);
  assert.equal(response.budget.omittedCount, 2);
  assert.ok(response.budget.downgradedCount > 0);
  assert.ok(response.items.every(item => item.summary === undefined
    ? item.deliveryReasons?.includes("BUDGET_DOWNGRADED") : !("deliveryReasons" in item)));
  const stored = f.projection.recalls().items[0]!;
  assert.equal(stored.budget.modelVisibleCharacters, Array.from(JSON.stringify(response)).length);
  assert.ok(stored.budget.modelVisibleCharacters <= 5000);
  assert.equal(stored.budget.deliveredAssets, 8);
  assert.equal(stored.budget.downgradedCount, response.budget.downgradedCount);
  const facts = f.projection.items("i.recall_id=?", stored.recallId);
  assert.deepEqual(facts.map(item => item.deliveryReasons), response.items.map(item => item.deliveryReasons ?? []));
  assert.deepEqual(facts.map(item => item.deliveredMode), response.items.map(item => item.summary === undefined ? "ON_DEMAND" : "DIRECT"));
});

test("failed Recall facts leave no stable references and the top-level fallback can read with assetId and expectedVersion", async t => {
  const f = await knowledgeFixture(); t.after(() => f.close());
  const asset = await f.asset({ title: "fallback token" });
  f.repository.db.exec("CREATE TRIGGER fail_recall BEFORE INSERT ON recall_item BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const before = f.rows();
  const response = await f.service.recall({ capabilityIds: [], queries: ["fallback token"] });
  assert.equal(response.usageRecorded, false);
  assert.equal(response.reference, "asset_read: assetId + expectedVersion=version + same capabilityIds");
  assert.equal(response.items[0]!.recallItemId, null);
  assert.equal("recallId" in response, false);
  assert.equal("reference" in response.items[0]!, false);
  assert.ok(response.diagnostics.includes("USAGE_WRITE_FAILED"));
  assert.ok(Array.from(JSON.stringify(response)).length <= 5000);
  assert.deepEqual(f.rows(), before);
  const read = await f.service.read({ capabilityIds: [], assetId: asset.assetId, expectedVersion: response.items[0]!.version });
  assert.equal(read.assetId, asset.assetId);
  assert.equal((await f.service.used({ capabilityIds: [], readRef: read.readRef })).created, true);
});
