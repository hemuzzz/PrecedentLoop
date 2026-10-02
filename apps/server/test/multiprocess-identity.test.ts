import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { runKnowledgeWriter } from "../test-support/knowledge-writer.js";

test("U03 eight independent Recall/Read/Used writers at a frozen millisecond preserve every usg identity and fact", async () => {
  const f = await knowledgeFixture();
  try {
    const asset = await f.asset({ title: "identitytoken", body: "current body" });
    const outputs = await Promise.all(Array.from({ length: 8 }, () => runKnowledgeWriter(f.options, `
      const recall = await service.recall({ capabilityIds: [], queries: ["identitytoken"] });
      if (!recall.usageRecorded || recall.items.length !== 1) throw new Error("Recall fact missing");
      const read = await service.read({ capabilityIds: [], recallItemId: recall.items[0].recallItemId });
      if (!read.usageRecorded) throw new Error("Read fact missing");
      const used = await service.used({ capabilityIds: [], readRef: read.readRef });
      const recallId = repository.item(recall.items[0].recallItemId).recallId;
      console.log(JSON.stringify([recallId, recall.items[0].recallItemId, read.readRef, used.usedId]));
    `)));
    const identities = outputs.flatMap(output => JSON.parse(output) as string[]);
    assert.equal(identities.length, 32); assert.equal(new Set(identities).size, 32);
    assert.ok(identities.every(id => /^usg[0-9]+$/u.test(id)));
    assert.deepEqual(f.projection.totals(), { recallOperations: 8, recallItems: 8, reads: 8, used: 8 });
    assert.deepEqual(f.repository.summarizeByAsset(asset.assetId), { recallCount: 8, readCount: 8, totalUsedCount: 8 });
    const stored = ["SELECT recall_id AS id FROM recall_operation", "SELECT recall_item_id AS id FROM recall_item",
      "SELECT read_ref AS id FROM read_operation", "SELECT used_id AS id FROM used_event"]
      .flatMap(sql => f.repository.db.prepare<[], { id: string }>(sql).all().map(row => row.id));
    assert.deepEqual(new Set(stored), new Set(identities));
    assert.deepEqual(f.repository.db.pragma("foreign_key_check"), []);
  } finally { await f.close(); }
});
