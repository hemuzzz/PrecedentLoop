import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { recallRanking } from "../src/knowledge/ranking.js";

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
