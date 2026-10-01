import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import {
  AssetIndexManager,
  AssetNotAccessibleError,
  AssetSearchInputError,
  AssetSearchService,
  buildFtsAndQuery,
  escapeFtsLiteral,
  normalizeAssetSearchQuery,
  scanAssetFiles,
  type AssetScope,
  type AssetType,
} from "../src/asset/index.js";

const idGenerator = new SnowflakeIdGenerator();

test("normalizes literal queries, counts Unicode code points, and uniquely escapes FTS terms", () => {
  assert.deepEqual(normalizeAssetSearchQuery("  Spring\t事务  "), {
    longTerms: ["spring"],
    phrase: "spring 事务",
    shortTerms: ["事务"],
    strategy: "HYBRID",
    terms: ["spring", "事务"],
  });
  assert.equal(normalizeAssetSearchQuery("资金 结算").strategy, "LITERAL");
  assert.equal(normalizeAssetSearchQuery("充值回调 幂等处理").strategy, "FTS");
  assert.equal(normalizeAssetSearchQuery("😀😀").strategy, "LITERAL");
  assert.equal(normalizeAssetSearchQuery("😀😀😀").strategy, "FTS");
  assert.equal(escapeFtsLiteral('a"b*-(c)'), '"a""b*-(c)"');
  assert.equal(buildFtsAndQuery(["and", "or", "not"]), '"and" AND "or" AND "not"');
  assert.throws(
    () => normalizeAssetSearchQuery(" \n\t "),
    (error: unknown) => error instanceof AssetSearchInputError && error.code === "EMPTY_QUERY",
  );
});

test("passes Golden Query across FTS, LITERAL, HYBRID, Workspace isolation, and deterministic ranking", async () => {
  const fixture = await createFixture();
  const globalId = idGenerator.next("ast");
  const alphaId = idGenerator.next("ast");
  const betaId = idGenerator.next("ast");
  const manager = await AssetIndexManager.create(fixture);
  let refreshCount = 0;

  try {
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/global.md",
      assetSource({
        body: [
          "充值回调必须保持幂等处理并避免并发重复。",
          "单字 锁，缩写 ID IO。",
          "代码标识 taskId asset_read @Transactional。",
          'FTS 字面符号 "quoted" asset*read call(test) state-machine AND OR NOT。',
        ].join("\n"),
        id: globalId,
        scope: "GLOBAL",
        summary: "共享检索规则：充值回调与幂等处理",
        title: "共享检索规则",
        type: "MEMORY",
      }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/documents/alpha.md",
      assetSource({
        body: [
          "资金结算、发票申请和事务边界。",
          "Spring Transaction RocketMQ PROCESSING CLOSING。",
          "order_id 幂等，MQ 重试机制。",
        ].join("\n"),
        id: alphaId,
        scope: "WORKSPACE",
        summary: "共享检索规则：资金、结算、发票、并发、事务、幂等",
        title: "共享检索规则",
        type: "DOCUMENT",
        workspace: "alpha",
      }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/beta/memories/beta.md",
      assetSource({
        body: "其他 Workspace 的共享检索、资金结算与充值回调，不得越权返回。",
        id: betaId,
        scope: "WORKSPACE",
        summary: "共享检索规则",
        title: "共享检索规则",
        type: "MEMORY",
        workspace: "beta",
      }),
    );
    await manager.synchronize();

    const service = new AssetSearchService({
      ...fixture,
      refreshIndex: async () => {
        refreshCount += 1;
        await manager.synchronize();
      },
    });
    try {
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "充值回调" }), [globalId], "FTS");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "充值" }), [globalId], "LITERAL");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "锁" }), [globalId], "LITERAL");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "ID" }), [globalId], "LITERAL");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "IO" }), [globalId], "LITERAL");
      for (const shortQuery of ["并发", "幂等"]) {
        assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: shortQuery }), [globalId], "LITERAL");
      }
      assertSearch(
        await service.search({ context: { authorizedWorkspaces: [] }, query: "充值回调 幂等" }),
        [globalId],
        "HYBRID",
      );

      assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "资金 结算" }), [alphaId], "LITERAL");
      for (const shortQuery of ["资金", "结算", "发票", "事务", "MQ"]) {
        assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: shortQuery }), [alphaId], "LITERAL");
      }
      for (const longQuery of ["资金结算", "发票申请", "事务边界", "RocketMQ", "spring"]) {
        assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: longQuery }), [alphaId], "FTS");
      }
      assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "MQ 重试机制" }), [alphaId], "HYBRID");
      assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "order_id 幂等" }), [alphaId], "HYBRID");
      assertSearch(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "Spring 事务" }), [alphaId], "HYBRID");
      assertSearch(
        await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "PROCESSING CLOSING" }),
        [alphaId],
        "FTS",
      );
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "taskId" }), [globalId], "FTS");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "asset_read" }), [globalId], "FTS");
      assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "@Transactional" }), [globalId], "FTS");

      for (const literalQuery of ['"', "*", "(", ")", "-"]) {
        assertSearch(
          await service.search({ context: { authorizedWorkspaces: [] }, query: literalQuery }),
          [globalId],
          "LITERAL",
        );
      }
      for (const [ftsQuery, expectedStrategy] of [
        ['"quoted"', "FTS"],
        ["asset*read", "FTS"],
        ["call(test)", "FTS"],
        ["state-machine", "FTS"],
        ["AND OR NOT", "HYBRID"],
      ] as const) {
        const items = await service.search({ context: { authorizedWorkspaces: [] }, query: ftsQuery });
        assert.deepEqual(items.map(({ assetId }) => assetId), [globalId], `FTS literal query: ${ftsQuery}`);
        assert.equal(items.every(({ searchStrategy }) => searchStrategy === expectedStrategy), true);
      }

      const ranked = await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "共享检索" });
      assert.deepEqual(ranked.map(({ assetId }) => assetId), [alphaId, globalId]);
      assert.equal(ranked.every(({ searchStrategy }) => searchStrategy === "FTS"), true);
      assert.equal(ranked[0]?.score !== undefined && ranked[0].score > (ranked[1]?.score ?? 0), true);
      assert.deepEqual(
        (await service.search({ context: { authorizedWorkspaces: [] }, query: "共享检索" })).map(({ assetId }) => assetId),
        [globalId],
      );
      assert.deepEqual(
        (await service.search({ context: { authorizedWorkspaces: ["beta"] }, query: "共享检索" })).map(({ assetId }) => assetId),
        [betaId, globalId],
      );
      assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "资金结算" }), []);
      assert.deepEqual(await service.search({ context: { authorizedWorkspaces: ["alpha"] }, query: "资金 不存在" }), []);
      assert.deepEqual(
        (await service.search({ context: { authorizedWorkspaces: ["alpha"] }, limit: 1, query: "共享检索" })).map(({ assetId }) => assetId),
        [alphaId],
      );
      await assert.rejects(
        service.search({ context: { authorizedWorkspaces: ["alpha"] }, limit: 0, query: "资金" }),
        (error: unknown) => error instanceof AssetSearchInputError && error.code === "INVALID_LIMIT",
      );

      const read = await service.read({ assetId: alphaId, context: { authorizedWorkspaces: ["alpha"] } });
      assert.equal(read.frontmatter.id, alphaId);
      assert.match(read.markdown, /Spring Transaction/);
      await assert.rejects(
        service.read({ assetId: alphaId, context: { authorizedWorkspaces: [] } }),
        AssetNotAccessibleError,
      );
      await assert.rejects(
        service.read({ assetId: betaId, context: { authorizedWorkspaces: ["alpha"] } }),
        AssetNotAccessibleError,
      );
      assert.equal((await service.read({ assetId: globalId, context: { authorizedWorkspaces: ["alpha"] } })).frontmatter.id, globalId);
      assert.equal(refreshCount, 0);

      const literalTimes = await measureSearch(service, { authorizedWorkspaces: ["alpha"] }, "资金 结算", 20);
      const hybridTimes = await measureSearch(service, { authorizedWorkspaces: ["alpha"] }, "Spring 事务", 20);
      const timing = {
        hybridMaxMs: round(Math.max(...hybridTimes)),
        hybridMedianMs: round(median(hybridTimes)),
        literalMaxMs: round(Math.max(...literalTimes)),
        literalMedianMs: round(median(literalTimes)),
      };
      assert.equal(Object.values(timing).every(Number.isFinite), true);
      assert.equal(Math.max(...literalTimes, ...hybridTimes) < 500, true);
      console.log(`N05_TIMING ${JSON.stringify(timing)}`);
    } finally {
      service.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("orders literal and FTS field tiers before the Asset ID tie-breaker", async () => {
  const fixture = await createFixture();
  const manager = await AssetIndexManager.create(fixture);
  const literalAssets = [
    { body: "ordinary", id: idGenerator.next("ast"), summary: "ordinary", title: "资金 结算" },
    { body: "ordinary", id: idGenerator.next("ast"), summary: "ordinary", title: "资金 结算规则" },
    { body: "ordinary", id: idGenerator.next("ast"), summary: "ordinary", title: "规则资金和结算" },
    { body: "ordinary", id: idGenerator.next("ast"), summary: "规则资金和结算", title: "ordinary" },
    { body: "ordinary", id: idGenerator.next("ast"), summary: "结算说明", title: "资金说明" },
    { body: "正文包含资金和结算", id: idGenerator.next("ast"), summary: "ordinary", title: "ordinary" },
  ];
  const ftsAssets = [
    { body: "ordinary", id: idGenerator.next("ast"), summary: "ordinary", title: "充值回调" },
    { body: "ordinary", id: idGenerator.next("ast"), summary: "包含充值回调", title: "ordinary" },
    { body: "正文包含充值回调", id: idGenerator.next("ast"), summary: "ordinary", title: "ordinary" },
  ];

  try {
    for (const [index, asset] of [...literalAssets, ...ftsAssets].entries()) {
      await writeAsset(
        fixture.repositoryPath,
        `assets/global/memories/rank-${index}.md`,
        assetSource({ ...asset, scope: "GLOBAL", type: "MEMORY" }),
      );
    }
    await manager.synchronize();
    const service = new AssetSearchService({
      ...fixture,
      refreshIndex: () => manager.synchronize(),
    });
    try {
      assert.deepEqual(
        (await service.search({ context: { authorizedWorkspaces: [] }, query: "资金 结算" })).map(({ assetId }) => assetId),
        literalAssets.map(({ id }) => id),
      );
      assert.deepEqual(
        (await service.search({ context: { authorizedWorkspaces: [] }, query: "充值回调" })).map(({ assetId }) => assetId),
        ftsAssets.map(({ id }) => id),
      );
    } finally {
      service.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("reads current Markdown, skips stale results, and triggers index invalidation", async () => {
  const fixture = await createFixture();
  const assetId = idGenerator.next("ast");
  const assetPath = "assets/global/memories/stale.md";
  const manager = await AssetIndexManager.create(fixture);
  let refreshCount = 0;

  try {
    await writeAsset(
      fixture.repositoryPath,
      assetPath,
      assetSource({ body: "stale original content", id: assetId, scope: "GLOBAL", type: "MEMORY" }),
    );
    await manager.synchronize();
    const service = new AssetSearchService({
      ...fixture,
      refreshIndex: async () => {
        refreshCount += 1;
        await manager.synchronize();
      },
    });

    try {
      await writeAsset(
        fixture.repositoryPath,
        assetPath,
        assetSource({ body: "fresh replacement content", id: assetId, scope: "GLOBAL", type: "MEMORY" }),
      );
      assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "stale original" }), []);
      assert.equal(refreshCount, 1);
      assert.equal(service.diagnostics().some(({ code }) => code === "STALE_INDEX"), true);
      assertSearch(
        await service.search({ context: { authorizedWorkspaces: [] }, query: "fresh replacement" }),
        [assetId],
        "FTS",
      );

      await writeAsset(
        fixture.repositoryPath,
        assetPath,
        assetSource({ body: "read always returns newest Markdown", id: assetId, scope: "GLOBAL", type: "MEMORY" }),
      );
      const currentRead = await service.read({ assetId, context: { authorizedWorkspaces: [] } });
      assert.match(currentRead.markdown, /read always returns newest Markdown/);
      assert.equal(currentRead.contentHash, managerHashFromMarkdown(currentRead.markdown));
      assert.equal(refreshCount, 2);

      await writeAsset(fixture.repositoryPath, assetPath, "# invalid current file\n");
      await assert.rejects(
        service.read({ assetId, context: { authorizedWorkspaces: [] } }),
        AssetNotAccessibleError,
      );
      assert.equal(refreshCount, 3);
      assert.equal(manager.status().catalogCount, 0);
      assert.equal(service.diagnostics().some(({ code }) => code === "CURRENT_ASSET_INVALID"), true);
      assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "newest" }), []);

      const deletedId = idGenerator.next("ast");
      const deletedPath = "assets/global/documents/deleted.md";
      await writeAsset(
        fixture.repositoryPath,
        deletedPath,
        assetSource({ body: "deleted search candidate", id: deletedId, scope: "GLOBAL", type: "DOCUMENT" }),
      );
      await manager.synchronize();
      assertSearch(
        await service.search({ context: { authorizedWorkspaces: [] }, query: "deleted search" }),
        [deletedId],
        "FTS",
      );
      await rm(join(fixture.repositoryPath, deletedPath));
      assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "deleted search" }), []);
      assert.equal(refreshCount, 4);
      assert.equal(manager.status().catalogCount, 0);
    } finally {
      service.close();
    }
  } finally {
    await manager.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("validates only selected Catalog paths and rejects path traversal", async () => {
  const fixture = await createFixture();
  const selectedPath = "assets/global/memories/selected.md";
  const excludedPath = "assets/workspaces/beta/memories/excluded.md";

  try {
    await writeAsset(
      fixture.repositoryPath,
      selectedPath,
      assetSource({ body: "selected", id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      excludedPath,
      assetSource({
        body: "excluded",
        id: idGenerator.next("ast"),
        scope: "WORKSPACE",
        type: "MEMORY",
        workspace: "beta",
      }),
    );

    const selected = await scanAssetFiles({ ...fixture, relativePaths: [selectedPath] });
    assert.deepEqual(selected.assets.map(({ relativePath }) => relativePath), [selectedPath]);
    assert.equal(selected.diagnostics.length, 0);

    const unsafe = await scanAssetFiles({ ...fixture, relativePaths: ["../outside.md"] });
    assert.deepEqual(unsafe.assets, []);
    assert.deepEqual(unsafe.diagnostics.map(({ code }) => code), ["INVALID_ASSET_PATH"]);
  } finally {
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

interface Fixture {
  databasePath: string;
  repositoryPath: string;
  rootPath: string;
  workspaceConfigPath: string;
}

interface AssetSourceOptions {
  body: string;
  id: string;
  scope: AssetScope;
  summary?: string;
  title?: string;
  type: AssetType;
  workspace?: string;
}

async function createFixture(): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n05-"));
  const repositoryPath = join(rootPath, "asset-repository");
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  const databasePath = join(rootPath, "data", "precedent-loop.sqlite");
  await mkdir(join(repositoryPath, "assets"), { recursive: true });
  await writeFile(
    workspaceConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { name: "alpha", paths: ["/workspace/alpha"] },
        { name: "beta", paths: ["/workspace/beta"] },
      ],
    }),
    "utf8",
  );
  initializeDatabase(databasePath);
  return { databasePath, repositoryPath, rootPath, workspaceConfigPath };
}

function assetSource(options: AssetSourceOptions): string {
  const fields = [`id: ${options.id}`, `type: ${options.type}`, `scope: ${options.scope}`];
  if (options.workspace !== undefined) {
    fields.push(`workspace: ${options.workspace}`);
  }
  fields.push(
    `title: ${options.title ?? `${options.type} title`}`,
    `summary: ${options.summary ?? `${options.type} summary`}`,
  );
  return ["---", ...fields, "---", options.body, ""].join("\n");
}

async function writeAsset(repositoryPath: string, relativePath: string, source: string): Promise<void> {
  const absolutePath = join(repositoryPath, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}

function assertSearch(
  items: readonly { assetId: string; matchedSnippet: string; searchStrategy: string }[],
  expectedIds: readonly string[],
  strategy: string,
): void {
  assert.deepEqual(items.map(({ assetId }) => assetId), expectedIds);
  assert.equal(items.every(({ searchStrategy }) => searchStrategy === strategy), true);
  assert.equal(items.every(({ matchedSnippet }) => matchedSnippet.length > 0), true);
}

async function measureSearch(
  service: AssetSearchService,
  context: { authorizedWorkspaces: string[] },
  query: string,
  iterations: number,
): Promise<number[]> {
  const times: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    await service.search({ context, query });
    times.push(performance.now() - startedAt);
  }
  return times;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  const left = sorted[middle - 1];
  if (right === undefined) {
    throw new Error("Cannot calculate a median from an empty collection");
  }
  return sorted.length % 2 === 0 && left !== undefined ? (left + right) / 2 : right;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function managerHashFromMarkdown(markdown: string): string {
  return createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
}
