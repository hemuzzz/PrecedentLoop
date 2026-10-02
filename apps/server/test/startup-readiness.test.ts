import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { knowledgeFixture, knowledgeRuntime } from "../test-support/knowledge-fixture.js";
for (const change of ["add", "delete", "workspace", "unavailable"] as const) {
  test(`startup reads current database and configuration after ${change}`, async () => {
    const f = await knowledgeFixture();
    try {
      const first = await f.asset({ title: "startup", workspace: "alpha" });
      if (change === "add") await f.asset({ title: "startup second", workspace: "alpha" });
      if (change === "delete") f.remove(first.assetId);
      if (change === "workspace") await writeFile(f.options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
      if (change === "unavailable") await writeFile(f.options.workspaceConfigPath, "invalid");
      const restarted = knowledgeRuntime(f.options);
      try {
        if (change === "unavailable") await assert.rejects(restarted.search.listLibrary({}), { code: "WORKSPACE_CONFIG_UNAVAILABLE" });
        else assert.equal((await restarted.search.listLibrary({})).total, change === "add" ? 2 : 0);
      } finally { restarted.close(); }
    } finally { await f.close(); }
  });
}
