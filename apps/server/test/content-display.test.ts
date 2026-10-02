import assert from "node:assert/strict";
import test from "node:test";
import { displayContent } from "../src/asset/candidate-service.js";
import { AssetDiffService, compareContentVersions } from "../src/asset/content-diff.js";
import type { AssetRecord } from "../src/asset/asset-repository.js";

test("display inserts the summary after an exact existing first heading without duplicating it", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    assert.equal(displayContent({ title: "标题", summary: "摘要", bodyMarkdown: `# 标题${eol}${eol}正文${eol}第二行` }),
      `# 标题\n\n摘要\n\n正文${eol}第二行`);
  }
  assert.equal(displayContent({ title: "标题", summary: "摘要", bodyMarkdown: "# 标题" }), "# 标题\n\n摘要\n\n");
});

test("display preserves bodies whose first line is not exactly the content title", () => {
  for (const bodyMarkdown of ["正文", "# 别的标题\n\n正文", "# 标题 \n\n正文", "\n# 标题\n正文", "## 标题\n正文"]) {
    assert.equal(displayContent({ title: "标题", summary: "摘要", bodyMarkdown }), `# 标题\n\n摘要\n\n${bodyMarkdown}`);
  }
});

test("previous and current diff snapshots use the same single-heading display", async () => {
  const time = "2026-10-02T00:00:00.000Z";
  const asset: AssetRecord = {
    assetId: "ast1", knowledgeNumber: 1, type: "MEMORY", scope: "GLOBAL", workspace: null,
    title: "标题", summary: "新摘要", bodyMarkdown: "# 标题\n\n新正文", version: 1,
    createdAt: time, updatedAt: time,
    previousContent: { title: "标题", summary: "旧摘要", bodyMarkdown: "# 标题\n\n旧正文", updatedAt: time },
  };
  const diff = await new AssetDiffService({ readLibrary: async () => asset }).get(asset.assetId);
  assert.deepEqual(diff, compareContentVersions(asset.assetId,
    { rawContent: Buffer.from("# 标题\n\n旧摘要\n\n旧正文"), version: 0, recordedAt: time },
    { rawContent: Buffer.from("# 标题\n\n新摘要\n\n新正文"), version: 1, recordedAt: time }));
});
