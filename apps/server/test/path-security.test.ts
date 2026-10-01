import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { knowledgeRuntime, initializeDatabase, serveKnowledge, toolData, toolPayload, persistentRows } from "../test-support/knowledge-fixture.js";
import type { RecallResult } from "../src/knowledge/model.js";

// The same filesystem/HTTP assertions also exercise compiled production modules.
const moduleRoot = new URL(process.env.PRECEDENT_LOOP_TEST_DIST === "1" ? "../dist/" : "../src/", import.meta.url);
console.log(`F02_PRODUCTION_MODULE_ROOT ${moduleRoot.href}`);
const assets: typeof import("../src/asset/index.js") = await import(new URL("asset/index.js", moduleRoot).href);
const ids = new SnowflakeIdGenerator();
const pathCases = ["root", "assets-parent", "global-parent", "parent-outside", "parent-inside", "file", "prefix-sibling", "parent-missing", "root-missing"] as const;
type PathCase = typeof pathCases[number];

for (const pathCase of pathCases) {
  for (const existingUsage of [false, true]) {
    test(`F02 ${pathCase}, existing Usage=${existingUsage}: all current readers reject a stale Catalog path`, async (t) => {
      const fixture = await createFixture();
      try {
        let readRef: string | null = null, recallItemId: string | null = null;
        if (existingUsage) {
          const recall = await fixture.service.recall({ capabilityIds: [], queries: ["F02_PRIVATE_BODY"] });
          recallItemId = recall.items[0]!.recallItemId;
          readRef = (await fixture.service.read({ capabilityIds: [], recallItemId })).readRef;
          assert.ok(readRef); assert.ok(recallItemId);
        }
        const usageBefore = fixture.usageRows();
        const operationsBefore = fixture.operations();
        const catalogBefore = fixture.catalogRows();
        await replacePath(fixture, pathCase);
        const full = await assets.scanAssetRepository(fixture);
        const targeted = await assets.scanAssetFiles({ ...fixture, relativePaths: [fixture.assetPath] });
        let readReturned = false;
        try {
          const read = await fixture.search.read({ assetId: fixture.assetId, context: { authorizedWorkspaces: [] } });
          readReturned = read.markdown.includes("F02_PRIVATE_BODY");
        } catch (error) {
          assert.ok(error instanceof assets.AssetNotAccessibleError || error instanceof assets.AssetSearchUnavailableError);
        }
        const results: Record<string, CallToolResult> = {};
        const usageAfterCalls: Record<string, unknown> = {};
        const calls: Array<[string, string, Record<string, unknown>]> = [
          ["read-by-id", "asset_read", { capabilityIds: [], assetId: fixture.assetId }],
          ["read-by-reference", "asset_read", { capabilityIds: [], recallItemId: recallItemId ?? ids.next("usg") }],
          ["used-by-read", "asset_mark_used", { capabilityIds: [], readRef: readRef ?? ids.next("usg") }],
          ["used-by-recall", "asset_mark_used", { capabilityIds: [], recallItemId: recallItemId ?? ids.next("usg") }],
          ["recall", "knowledge_recall", { capabilityIds: [], queries: ["F02_PRIVATE_BODY"] }],
        ];
        for (const [key, name, arguments_] of calls) {
          results[key] = await fixture.client.callTool({ name, arguments: arguments_ }) as CallToolResult;
          usageAfterCalls[key] = fixture.usageRows();
          if (key !== "recall") {
            assert.equal(results[key]!.isError, true, key);
            const error = toolPayload<{ error: { code: string } }>(results[key]!);
            const expected = !existingUsage && key !== "read-by-id"
              ? ["SOURCE_NOT_FOUND"] : ["ASSET_NOT_ACCESSIBLE", "ASSET_INDEX_UNAVAILABLE"];
            assert.ok(expected.includes(error.error.code), JSON.stringify(error));
            assert.doesNotMatch(JSON.stringify(results[key]), /F02_PRIVATE_BODY/u);
            assert.deepEqual(fixture.operations(), operationsBefore);
          }
        }
        const recallResult = results.recall!;
        const serialized = JSON.stringify(recallResult);
        // queries echoes the submitted literal; only delivered items can contain asset content.
        if (!recallResult.isError) {
          const recall = toolData<RecallResult>(recallResult);
          assert.deepEqual(recall.items, []);
          assert.equal(recall.usageRecorded, true);
          const operations = fixture.operations();
          assert.equal(operations.length, operationsBefore.length + 1);
          assert.deepEqual(operations.slice(0, -1), operationsBefore);
          assert.equal(operations.at(-1)!.recall_id, recall.recallId);
          assert.deepEqual(JSON.parse(operations.at(-1)!.queries_json), ["F02_PRIVATE_BODY"]);
        } else {
          assert.deepEqual(toolPayload(recallResult), { error: { code: "ASSET_INDEX_UNAVAILABLE" } });
          assert.deepEqual(fixture.operations(), operationsBefore);
          assert.doesNotMatch(serialized, /F02_PRIVATE_BODY/u);
        }
        const hub = await fetch(`${fixture.origin}/api/assets/${fixture.assetId}`);
        const hubBody = await hub.text();
        const evidence = {
          pathCase, existingUsage,
          fullAccepted: full.assets.some((asset) => asset.frontmatter.id === fixture.assetId),
          fullDiagnostics: full.diagnostics.map((item) => item.code),
          targetedAccepted: targeted.assets.some((asset) => asset.frontmatter.id === fixture.assetId),
          targetedDiagnostics: targeted.diagnostics.map((item) => item.code),
          applicationReadReturned: readReturned,
          mcpReadRejected: results["read-by-id"]?.isError === true,
          mcpUsedRejected: results["used-by-read"]?.isError === true,
          searchReturnedPrivate: !recallResult.isError && JSON.stringify(toolData<RecallResult>(recallResult).items).includes("F02_PRIVATE_BODY"),
          searchReturnedAsset: serialized.includes(fixture.assetId),
          hubStatus: hub.status,
          usageUnchanged: JSON.stringify(fixture.usageRows()) === JSON.stringify(usageBefore),
        };
        t.diagnostic(`F02_EVIDENCE ${JSON.stringify(evidence)}`);
        assert.equal(evidence.fullAccepted, false);
        assert.equal(evidence.applicationReadReturned, false, "Current Application Read must reject a path rejected by the full Scanner");
        assert.equal(evidence.targetedAccepted, false);
        assert.ok(targeted.diagnostics.some((item) => ["SYMLINK", "REPOSITORY_UNAVAILABLE", "FILE_READ_ERROR"].includes(item.code)));
        assert.equal(evidence.mcpReadRejected, true);
        assert.equal(evidence.mcpUsedRejected, true);
        assert.equal(evidence.searchReturnedPrivate, false);
        assert.equal(evidence.searchReturnedAsset, false);
        assert.doesNotMatch(hubBody, /F02_PRIVATE_BODY/u);
        assert.ok([404, 409, 503].includes(hub.status));
        assert.deepEqual(fixture.usageRows(), usageBefore, "Failed Read/Used and excluded Search must preserve every Usage field");
        for (const [name, rows] of Object.entries(usageAfterCalls)) {
          assert.deepEqual(rows, usageBefore, `${name} must preserve every Usage field immediately after the call`);
        }
        assert.deepEqual(fixture.catalogRows(), catalogBefore, "No watcher or refresh may erase the stale Catalog test window");
        if (pathCase !== "root" && pathCase !== "root-missing" && pathCase !== "assets-parent") {
          const valid = await fixture.search.read({ assetId: fixture.validId, context: { authorizedWorkspaces: ["alpha"] } });
          assert.match(valid.markdown, /VALID_SIBLING/u);
        }
      } finally {
        await fixture.close();
      }
    });
  }
}

test("F02 preserves edits, deletion, legal moves, raw hashes and configured roots beneath system path aliases", async () => {
  const fixture = await createFixture();
  try {
    const changed = `${fixture.source}\n正常修改 café e\u0301\r\n`;
    await writeFile(join(fixture.repositoryPath, fixture.assetPath), changed);
    const read = await fixture.search.read({ assetId: fixture.assetId, context: { authorizedWorkspaces: [] } });
    assert.equal(read.markdown, changed);
    assert.equal(read.contentHash, hash(changed));
    await fixture.index.synchronize();
    const moved = "assets/global/memories/moved.md";
    await rename(join(fixture.repositoryPath, fixture.assetPath), join(fixture.repositoryPath, moved));
    await assert.rejects(fixture.search.read({ assetId: fixture.assetId, context: { authorizedWorkspaces: [] } }));
    await fixture.index.synchronize();
    assert.equal((await fixture.search.read({ assetId: fixture.assetId, context: { authorizedWorkspaces: [] } })).markdown, changed);
    await unlink(join(fixture.repositoryPath, moved));
    const deleted = await assets.scanAssetFiles({ ...fixture, relativePaths: [moved] });
    assert.equal(deleted.assets.length, 0);
    await assert.rejects(fixture.search.read({ assetId: fixture.assetId, context: { authorizedWorkspaces: [] } }));

    // The configured Repository root is regular; a symlink ABOVE it is allowed.
    const parentAlias = join(fixture.rootPath, "parent-alias");
    await symlink(fixture.rootPath, parentAlias);
    const aliased = { ...fixture, repositoryPath: join(parentAlias, "repository") };
    const full = await assets.scanAssetRepository(aliased);
    const targeted = await assets.scanAssetFiles({ ...aliased, relativePaths: [fixture.validPath] });
    assert.deepEqual(full.assets.map((asset) => asset.frontmatter.id), [fixture.validId]);
    assert.deepEqual(targeted.assets.map((asset) => asset.frontmatter.id), [fixture.validId]);
  } finally {
    await fixture.close();
  }
});

test("F02 rejects lexical sibling-prefix and absolute paths without widening the Repository", async () => {
  const fixture = await createFixture();
  try {
    const sibling = `${fixture.repositoryPath}-outside`;
    await mkdir(sibling);
    await writeFile(join(sibling, "one.md"), fixture.source);
    for (const path of ["../repository-outside/one.md", "assets/../../repository-outside/one.md", join(sibling, "one.md")]) {
      const scan = await assets.scanAssetFiles({ ...fixture, relativePaths: [path] });
      assert.equal(scan.assets.length, 0);
      assert.deepEqual(scan.diagnostics.map((item) => item.code), ["INVALID_ASSET_PATH"]);
    }
  } finally {
    await fixture.close();
  }
});

async function replacePath(fixture: Awaited<ReturnType<typeof createFixture>>, pathCase: PathCase) {
  const original = join(fixture.repositoryPath, fixture.assetPath);
  let sourcePath = dirname(original);
  let destination = join(fixture.rootPath, "outside-parent");
  if (pathCase === "root" || pathCase === "root-missing") sourcePath = fixture.repositoryPath;
  if (pathCase === "assets-parent") sourcePath = join(fixture.repositoryPath, "assets");
  if (pathCase === "global-parent") sourcePath = join(fixture.repositoryPath, "assets/global");
  if (pathCase === "parent-inside") destination = join(fixture.repositoryPath, "held-parent");
  if (pathCase === "prefix-sibling") destination = `${fixture.repositoryPath}-outside`;
  if (pathCase === "file") {
    sourcePath = original;
    destination = join(fixture.rootPath, "outside-file.md");
  }
  await rename(sourcePath, destination);
  if (pathCase === "root-missing" || pathCase === "parent-missing") return;
  await symlink(destination, sourcePath);
  // The audit counterexample changes only location: exact bytes, ID and hash survive.
  assert.equal(await readFile(original, "utf8"), fixture.source);
  assert.equal(hash(await readFile(original, "utf8")), hash(fixture.source));
  assert.notEqual(await realpath(original), original);
}

function hash(source: string) { return createHash("sha256").update(Buffer.from(source)).digest("hex"); }

async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-f02-"));
  const repositoryPath = join(rootPath, "repository");
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  const databasePath = join(rootPath, "memory.sqlite");
  const assetId = ids.next("ast");
  const validId = ids.next("ast");
  const assetPath = "assets/global/memories/one.md";
  const validPath = "assets/workspaces/alpha/documents/valid.md";
  const source = `---\nid: ${assetId}\ntype: MEMORY\nscope: GLOBAL\ntitle: private\nsummary: private summary\n---\nF02_PRIVATE_BODY 中文正文\n`;
  // A sibling in another Workspace survives intermediate directory replacements.
  const validAssetPath = validPath;
  await mkdir(dirname(join(repositoryPath, assetPath)), { recursive: true });
  await mkdir(dirname(join(repositoryPath, validAssetPath)), { recursive: true });
  await writeFile(join(repositoryPath, assetPath), source);
  await writeFile(join(repositoryPath, validAssetPath), `---\nid: ${validId}\ntype: DOCUMENT\nscope: WORKSPACE\nworkspace: alpha\ntitle: valid\nsummary: valid\n---\nVALID_SIBLING\n`);
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [join(rootPath, "workspace-alpha")] }] }));
  const options = { repositoryPath, workspaceConfigPath, databasePath };
  initializeDatabase(databasePath);
  const index = await assets.AssetIndexManager.create(options);
  await index.synchronize();
  const runtime = knowledgeRuntime(options, () => index.status());
  const endpoint = await serveKnowledge(runtime);
  const client = await endpoint.connect();
  const { search, service, repository } = runtime;
  const database = repository.db;
  return {
    ...options, rootPath, assetId, validId, assetPath, validPath: validAssetPath, source, search, service, index, client, origin: endpoint.origin,
    usageRows: () => {
      const rows = persistentRows(database);
      delete rows.recall_operation;
      return rows;
    },
    operations: () => database.prepare<[], { recall_id: string; queries_json: string }>("SELECT * FROM recall_operation ORDER BY rowid").all(),
    catalogRows: () => database.prepare("SELECT * FROM asset_catalog ORDER BY asset_id").all(),
    close: async () => {
      await endpoint.close();
      runtime.close();
      await index.close();
      await rm(rootPath, { recursive: true, force: true });
    },
  };
}
