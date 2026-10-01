import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { runKnowledgeWriter } from "../test-support/knowledge-writer.js";

test("eight independent first Used calls create exactly one event and preserve the first identity and timestamp", async () => {
  const f = await knowledgeFixture();
  try {
    const asset = await f.asset({ title: "concurrent Used" }); await f.index.synchronize();
    const read = await f.service.read({ capabilityIds: [], assetId: asset.assetId });
    const source = JSON.stringify({ capabilityIds: [], readRef: read.readRef });
    const results = await Promise.all(Array.from({ length: 8 }, () => runKnowledgeWriter(f.options,
      `console.log(JSON.stringify(await service.used(${source})))`)));
    const used = results.map(result => JSON.parse(result) as { created: boolean; usedId: string });
    assert.equal(used.filter(result => result.created).length, 1);
    assert.equal(new Set(used.map(result => result.usedId)).size, 1);
    assert.deepEqual(f.repository.summarizeByAsset(asset.assetId), { recallCount: 0, readCount: 1, totalUsedCount: 1 });
    const before = f.rows();
    assert.equal((await f.service.used({ capabilityIds: [], readRef: read.readRef })).created, false);
    assert.deepEqual(f.rows(), before);
  } finally { await f.close(); }
});
