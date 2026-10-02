import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
import { OverviewApplicationService } from "../src/http/overview.js";

test("overview projects current titles and pending status, includes empty workspaces and hides deleted rows", async () => {
  const f = await knowledgeFixture();
  try {
    const formal = await f.asset({ title: "正式记忆", workspace: "alpha", body: "不应随图谱返回的正文" });
    const pending = await f.asset({ title: "待确认记忆", workspace: "alpha", inbox: true, body: "不应随图谱返回的正文" });
    await f.asset({ title: "全局记忆" });
    const service = new OverviewApplicationService({ ...f.options, candidateService: f.candidateService, projection: f.projection });
    const result = await service.get();
    assert.deepEqual(result.scopes.map(s => s.workspace), [null, "alpha", "beta"]);
    const scope = result.scopes.find(s => s.workspace === "alpha")!;
    assert.equal(scope.assets.MEMORY, 1); assert.equal(scope.inboxCount, 1);
    assert.deepEqual(scope.items.find(i => i.assetId === formal.assetId), { assetId: formal.assetId, title: "正式记忆", type: "MEMORY", pending: false, knowledgeNumber: 1 });
    const candidate = (await f.candidateService.list()).items[0]!;
    assert.deepEqual(scope.items.find(i => i.assetId === pending.assetId), { assetId: pending.assetId, title: "待确认记忆", type: "MEMORY", pending: true, candidateId: candidate.candidateId, number: candidate.number, knowledgeNumber: null });
    assert.equal(result.scopes.at(-1)!.items.length, 0);
    assert.equal(result.diagnosticCount, 0);
    assert.ok(!JSON.stringify(result).includes("不应随图谱返回的正文"));
    f.remove(formal.assetId);
    const refreshed = await service.get();
    assert.equal(refreshed.scopes.find(s => s.workspace === "alpha")!.assets.MEMORY, 0);
    assert.ok(!refreshed.scopes.flatMap(s => s.items).some(i => i.assetId === formal.assetId));
    await writeFile(f.options.workspaceConfigPath, "invalid");
    await assert.rejects(service.get(), { code: "WORKSPACE_CONFIG_UNAVAILABLE" });
  } finally { await f.close(); }
});
