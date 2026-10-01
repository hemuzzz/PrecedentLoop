import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { InboxApplicationService } from "../src/asset/inbox.js";
import { OverviewApplicationService } from "../src/http/overview.js";

test("overview graph projects qualified titles and pending status with exact counts, including empty workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-overview-graph-"));
  try {
    const ids = new SnowflakeIdGenerator();
    const repositoryPath = join(root, "repository");
    const workspaceConfigPath = join(root, "workspaces.json");
    await mkdir(repositoryPath);
    await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [
      { name: "alpha", paths: [join(root, "alpha")] }, { name: "empty", paths: [join(root, "empty")] },
    ] }));
    async function asset(area: string, scope: string, title: string) {
      const id = ids.next("ast");
      const path = join(repositoryPath, area, scope === "GLOBAL" ? "global" : "workspaces/alpha", "memories", `${id}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `---\nid: ${id}\ntype: MEMORY\nscope: ${scope}\n${scope === "WORKSPACE" ? "workspace: alpha\n" : ""}title: ${title}\nsummary: 测试标题投影\n---\n不应随图谱返回的正文。\n`);
      return { id, path };
    }
    const formal = await asset("assets", "WORKSPACE", "正式记忆");
    const pending = await asset("inbox", "WORKSPACE", "待确认记忆");
    await asset("assets", "GLOBAL", "全局记忆");
    await writeFile(join(dirname(formal.path), "invalid.md"), "没有合法 Frontmatter");
    await symlink(formal.path, join(dirname(formal.path), "linked.md"));
    const options = { repositoryPath, workspaceConfigPath };
    const inboxService = new InboxApplicationService(options, { existingCatalogAssetIds: () => new Set([formal.id]) });
    const service = new OverviewApplicationService({ ...options, inboxService,
      projection: { totals: () => ({ recallOperations: 5, recallItems: 9, reads: 3, used: 2 }) } });
    const result = await service.get();
    assert.deepEqual(result.scopes.map(s => s.workspace), [null, "alpha", "empty"]);
    const scope = result.scopes.find(s => s.workspace === "alpha")!;
    assert.equal(scope.assets.MEMORY, 1);
    assert.equal(scope.inboxCount, 1);
    assert.deepEqual(scope.items.find(i => i.assetId === formal.id), { assetId: formal.id, title: "正式记忆", type: "MEMORY", pending: false });
    assert.deepEqual(scope.items.find(i => i.assetId === pending.id), { assetId: pending.id, title: "待确认记忆", type: "MEMORY", pending: true });
    assert.equal(result.scopes.at(-1)!.items.length, 0);
    assert.ok(result.diagnosticCount >= 2);
    assert.ok(!JSON.stringify(result).includes("不应随图谱返回的正文"));
    await rm(formal.path);
    const refreshed = await service.get();
    assert.equal(refreshed.scopes.find(s => s.workspace === "alpha")!.assets.MEMORY, 0);
    assert.ok(!refreshed.scopes.flatMap(s => s.items).some(i => i.assetId === formal.id));
    await writeFile(workspaceConfigPath, "invalid");
    await assert.rejects(service.get(), { code: "ASSET_SEARCH_UNAVAILABLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
