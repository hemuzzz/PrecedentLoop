import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { knowledgeFixture, knowledgeRuntime } from "../test-support/knowledge-fixture.js";

test("N13 candidate acceptance, revisions, scope and persistent facts survive restart without rebuilding", async () => {
  const f = await knowledgeFixture();
  const candidates = f.candidateService;
  try {
    const content = { type: "MEMORY", target: { scope: "WORKSPACE", workspace: "alpha" }, title: "Synthetic migration bridge",
      summary: "synthetic M03 M04 bridge without legacy identifiers", retrievalTerms: ["migrationbridge", "正式候选", "版本边界"], bodyMarkdown: "migrationbridge original current Markdown" };
    const prepared = await candidates.prepare("prepare", [content]); assert.ok(!("status" in prepared));
    const item = prepared.candidates[0]!;
    const selection = { candidateId: item.candidateId, assetId: item.assetId, candidateVersion: 0 };
    assert.deepEqual((await candidates.list()).items.map(row => row.assetId), [item.assetId]);
    await assert.rejects(candidates.prepare("unknown", [{ ...content, target: { scope: "WORKSPACE", workspace: "unknown" } }]), { code: "TARGET_INVALID" });
    assert.deepEqual(await f.search.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }), []);
    await assert.rejects(candidates.accept({ ...selection, candidateVersion: 1, requestId: "stale" }), { code: "VERSION_CONFLICT" });
    const accepted = await candidates.accept({ ...selection, requestId: "accept" });
    assert.equal(accepted.version, 0); assert.equal((await candidates.list()).items.length, 0);
    assert.equal((await f.search.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }))[0]!.assetId, item.assetId);
    assert.deepEqual(await f.search.search({ context: { authorizedWorkspaces: ["beta"] }, query: "migrationbridge" }), []);
    const recall = await f.service.recall({ capabilityIds: [f.alpha], queries: ["migrationbridge"] });
    const read = await f.service.read({ capabilityIds: [f.alpha], recallItemId: recall.items[0]!.recallItemId });
    assert.equal(read.markdown, content.bodyMarkdown);
    await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef });
    const facts = f.rows();
    const revision = await candidates.prepare("revision", [{ ...content, bodyMarkdown: "migrationbridge modified", existingAssetId: item.assetId, baseVersion: 0 }]);
    assert.ok(!("status" in revision)); const revised = revision.candidates[0]!;
    await candidates.accept({ requestId: "accept-revision", candidateId: revised.candidateId, candidateVersion: 0, assetId: item.assetId, baseVersion: 0 });
    assert.equal(f.records.get(item.assetId)!.previousContent!.bodyMarkdown, content.bodyMarkdown);
    await assert.rejects(f.service.read({ capabilityIds: [f.alpha], recallItemId: recall.items[0]!.recallItemId }), { code: "CONTENT_CHANGED" });
    await writeFile(f.options.workspaceConfigPath, "invalid");
    await assert.rejects(f.service.recall({ capabilityIds: [f.alpha], queries: ["migrationbridge"] }), { code: "WORKSPACE_CONFIG_UNAVAILABLE" });
    await writeFile(f.options.workspaceConfigPath, JSON.stringify(f.config));
    const restarted = knowledgeRuntime(f.options);
    try {
      assert.equal((await restarted.search.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "modified" }))[0]!.assetId, item.assetId);
      assert.equal(restarted.search.read({ assetId: item.assetId, context: { authorizedWorkspaces: ["alpha"] } }).version, 1);
      assert.deepEqual(f.rows(), facts);
      f.remove(item.assetId);
      assert.deepEqual(await restarted.search.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "migrationbridge" }), []);
      await assert.rejects(restarted.service.used({ capabilityIds: [f.alpha], readRef: read.readRef }), { code: "ASSET_NOT_FOUND" });
      assert.deepEqual(f.rows(), facts);
    } finally { restarted.close(); }
  } finally { await f.close(); }
});
