import assert from "node:assert/strict";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { assets, knowledgeFixture, KnowledgeError } from "../test-support/knowledge-fixture.js";

const inaccessibleError = (error: unknown) => error instanceof assets.AssetNotAccessibleError
  || error instanceof assets.AssetNotFoundError
  || (error instanceof KnowledgeError && error.code === "ASSET_NOT_ACCESSIBLE");

const scenarios = ["alpha-beta", "global-beta-alpha", "global-beta-null", "document", "skill", "deleted", "updated", "global"] as const;
for (const scenario of scenarios) {
  test(`F03 ${scenario}: Recall and both Read targets qualify current database rows and preserve historical facts`, async () => {
    const f = await knowledgeFixture();
    try {
      const workspace = scenario.startsWith("global") ? null : "alpha";
      const capabilityIds = scenario === "global-beta-null" ? [] : [f.alpha];
      const asset = await f.asset({ title: "f03match OLD_PRIVATE_TITLE", workspace, summary: "OLD_PRIVATE_SUMMARY" });
      const sibling = await f.asset({ title: "f03match Legal sibling", summary: "LEGAL_SIBLING_SUMMARY" });

      const initial = await f.service.recall({ capabilityIds, queries: ["f03match"] });
      const reference = initial.items.find(item => item.assetId === asset.assetId)!;
      const read = await f.service.read({ capabilityIds, recallItemId: reference.recallItemId });
      const before = f.rows();
      let currentSource = "CURRENT_BODY";
      if (scenario === "deleted") f.remove(asset.assetId);
      else if (scenario === "updated" || scenario === "global") {
        f.revise(asset.assetId, { title: "f03match Current allowed title", summary: "CURRENT_ALLOWED_SUMMARY", bodyMarkdown: currentSource });
      } else {
        const type = scenario === "document" ? "DOCUMENT" : scenario === "skill" ? "SKILL" : "MEMORY";
        const nextWorkspace = type === "MEMORY" ? "beta" : "alpha";
        f.revise(asset.assetId, { title: `f03match ${type === "MEMORY" ? "BETA_PRIVATE_MARKER" : "Allowed reference"}`,
          summary: type === "MEMORY" ? "BETA_PRIVATE_MARKER" : "REFERENCE_ONLY_SUMMARY", bodyMarkdown: currentSource });
        // Simulate a changed authorization boundary in the authoritative row.
        f.repository.db.prepare("UPDATE asset SET asset_type=?,asset_scope='WORKSPACE',workspace=? WHERE asset_id=?").run(type, nextWorkspace, asset.assetId);
      }
      const inaccessible = ["alpha-beta", "global-beta-alpha", "global-beta-null", "deleted", "invalid", "symlink"].includes(scenario);
      if (inaccessible) {
        for (const target of [{ assetId: asset.assetId }, { recallItemId: reference.recallItemId }]) {
          await assert.rejects(f.service.read({ capabilityIds, ...target }), inaccessibleError);
          assert.deepEqual(f.rows(), before);
        }
        for (const target of [{ readRef: read.readRef }, { recallItemId: reference.recallItemId }]) {
          await assert.rejects(f.service.used({ capabilityIds, ...target }), inaccessibleError);
          assert.deepEqual(f.rows(), before);
        }
      } else {
        await assert.rejects(f.service.read({ capabilityIds, recallItemId: reference.recallItemId }), { code: "CONTENT_CHANGED" });
        assert.deepEqual(f.rows(), before);
        const current = await f.service.read({ capabilityIds, assetId: asset.assetId });
        assert.equal(current.markdown, currentSource);
        assert.notEqual(current.version, reference.version);
      }
      const beforeRecall = f.rows();
      const recall = await f.service.recall({ capabilityIds, queries: ["f03match"] });
      assert.ok(recall.items.some(item => item.assetId === sibling.assetId));
      assert.doesNotMatch(JSON.stringify(recall), /BETA_PRIVATE_MARKER|OLD_PRIVATE_SUMMARY|OLD_PRIVATE_TITLE/u);
      assert.equal(recall.items.some(item => item.assetId === asset.assetId), !inaccessible);
      if (scenario === "document" || scenario === "skill") {
        const item = recall.items.find(item => item.assetId === asset.assetId)!;
        assert.equal(item.deliveredMode, "ON_DEMAND"); assert.equal(item.summary, undefined);
        assert.doesNotMatch(JSON.stringify(recall), /REFERENCE_ONLY_SUMMARY|CURRENT_BODY/u);
      }
      if (scenario === "updated" || scenario === "global") assert.match(JSON.stringify(recall), /CURRENT_ALLOWED_SUMMARY/u);
      const after = f.rows();
      for (const table of ["workspace_capability", "read_operation", "used_event"]) assert.deepEqual(after[table], beforeRecall[table]);
      assert.equal(after.recall_operation!.length, beforeRecall.recall_operation!.length + 1);
      assert.equal(after.recall_item!.length, beforeRecall.recall_item!.length + recall.items.length);
      assert.deepEqual(after.recall_operation!.slice(0, -1), beforeRecall.recall_operation);
      assert.deepEqual(after.recall_item!.slice(0, beforeRecall.recall_item!.length), beforeRecall.recall_item);
      assert.equal((await f.service.read({ capabilityIds, assetId: sibling.assetId })).markdown, sibling.source);
    } finally { await f.close(); }
  });
}

test("F03 Recall uses qualified Read metadata even when database metadata changes after that Read", async t => {
  const f = await knowledgeFixture();
  try {
    const asset = await f.asset({ title: "f03match", summary: "CURRENT_ALLOWED_SUMMARY" });

    const read = f.search.read.bind(f.search);
    f.repository.db.pragma("busy_timeout=0");
    t.mock.method(f.search, "read", (input: Parameters<typeof read>[0]) => {
      const result = read(input);
      assert.throws(() => f.repository.db.prepare("UPDATE asset SET title=?, summary=? WHERE asset_id=?").run("FORBIDDEN_CATALOG_TITLE", "FORBIDDEN_CATALOG_SUMMARY", asset.assetId), { code: "SQLITE_BUSY" });
      return result;
    });
    const recall = await f.service.recall({ capabilityIds: [], queries: ["f03match"] });
    assert.equal(recall.items[0]!.title, "f03match"); assert.equal(recall.items[0]!.summary, "CURRENT_ALLOWED_SUMMARY");
    assert.doesNotMatch(JSON.stringify(recall), /FORBIDDEN_CATALOG/u);
    assert.equal(f.repository.item(recall.items[0]!.recallItemId!)!.version, recall.items[0]!.version);
  } finally { await f.close(); }
});

test("F03 configuration and database faults propagate without fallback to stored content", async () => {
  const f = await knowledgeFixture();
  try {
    await f.asset({ title: "f03match" });
    const before = f.rows();
    await writeFile(f.options.workspaceConfigPath, "invalid");
    await assert.rejects(f.service.recall({ capabilityIds: [], queries: ["f03match"] }), { code: "WORKSPACE_CONFIG_UNAVAILABLE" });
    assert.deepEqual(f.rows(), before);
    await writeFile(f.options.workspaceConfigPath, JSON.stringify(f.config));
    f.repository.db.exec("DROP TABLE asset_fts");
    await assert.rejects(f.service.recall({ capabilityIds: [], queries: ["f03match"] }), /no such table/);
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});

test("U04 an oversized qualified title is omitted while a legal sibling and all existing facts survive", async () => {
  const f = await knowledgeFixture();
  try {
    const oversized = await f.asset({ title: "f03match " + "过长标题".repeat(1500), summary: "QUALIFIED_BUT_OVERSIZED" });
    const sibling = await f.asset({ title: "f03match", summary: "LEGAL_SIBLING_SUMMARY" });

    const read = await f.service.read({ capabilityIds: [], assetId: oversized.assetId });
    const before = f.rows();
    const result = await f.service.recall({ capabilityIds: [], queries: ["f03match"] });
    assert.ok(Array.from(JSON.stringify(result)).length <= 5000);
    assert.deepEqual(result.items.map(item => item.assetId), [sibling.assetId]);
    assert.doesNotMatch(JSON.stringify(result), /过长标题|QUALIFIED_BUT_OVERSIZED/u);
    assert.equal(f.repository.readFact(read.readRef!)!.assetId, oversized.assetId);
    assert.deepEqual(f.rows().read_operation, before.read_operation);
    assert.deepEqual(f.projection.items("i.recall_id=?", result.recallId!).map(item => item.assetId), [sibling.assetId]);
  } finally { await f.close(); }
});
