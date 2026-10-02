import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { AssetRepository } from "../src/asset/asset-repository.js";
import { CandidateRepository } from "../src/asset/candidate-repository.js";
import { openDatabase } from "../src/storage/schema.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import {
  AssetNotAccessibleError,
  AssetSearchInputError,
  AssetSearchService,
  buildFtsAndQuery,
  escapeFtsLiteral,
  normalizeAssetSearchQuery,
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

  try {
    await writeAsset(
      fixture,
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
      fixture,
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
      fixture,
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

    const service = new AssetSearchService(fixture);
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
      assert.equal(read.assetId, alphaId);
      assert.match(read.bodyMarkdown, /Spring Transaction/);
      await assert.rejects(
        async () => service.read({ assetId: alphaId, context: { authorizedWorkspaces: [] } }),
        AssetNotAccessibleError,
      );
      await assert.rejects(
        async () => service.read({ assetId: betaId, context: { authorizedWorkspaces: ["alpha"] } }),
        AssetNotAccessibleError,
      );
      assert.equal((await service.read({ assetId: globalId, context: { authorizedWorkspaces: ["alpha"] } })).assetId, globalId);

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
    fixture.db.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("orders literal and FTS field tiers before the Asset ID tie-breaker", async () => {
  const fixture = await createFixture();
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
        fixture,
        assetSource({ ...asset, scope: "GLOBAL", type: "MEMORY" }),
      );
    }
    const service = new AssetSearchService(fixture);
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
    fixture.db.close();
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("reads current database content and excludes logically deleted assets immediately", async () => {
  const fixture = await createFixture();
  const assetId = idGenerator.next("ast");
  const service = new AssetSearchService(fixture);
  try {
    await writeAsset(fixture, assetSource({ id: assetId, body: "stale original content", scope: "GLOBAL", type: "MEMORY" }));
    await writeAsset(fixture, assetSource({ id: assetId, body: "fresh replacement content", scope: "GLOBAL", type: "MEMORY" }));
    assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "stale original" }), []);
    assertSearch(await service.search({ context: { authorizedWorkspaces: [] }, query: "fresh replacement" }), [assetId], "FTS");
    const current = service.read({ assetId, context: { authorizedWorkspaces: [] } });
    assert.equal(current.bodyMarkdown, "fresh replacement content");
    assert.equal(current.version, 1);
    fixture.writes.write("delete", "delete", assetId, () => { fixture.assets.delete(assetId); return {}; });
    assert.throws(() => service.read({ assetId, context: { authorizedWorkspaces: [] } }), { code: "ASSET_NOT_FOUND" });
    assert.deepEqual(await service.search({ context: { authorizedWorkspaces: [] }, query: "fresh replacement" }), []);
  } finally { service.close(); fixture.db.close(); await rm(fixture.rootPath, { recursive: true, force: true }); }
});

interface AssetSourceOptions {
  body: string;
  id: string;
  scope: AssetScope;
  summary?: string;
  title?: string;
  type: AssetType;
  workspace?: string;
}

async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n05-"));
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  const databasePath = join(rootPath, "data.sqlite");
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [
    { name: "alpha", paths: ["/workspace/alpha"] }, { name: "beta", paths: ["/workspace/beta"] },
  ] }));
  initializeDatabase(databasePath);
  const db = openDatabase(databasePath);
  return { databasePath, rootPath, workspaceConfigPath, db, assets: new AssetRepository(db), writes: new CandidateRepository(db) };
}

function assetSource(options: AssetSourceOptions) { return options; }

async function writeAsset(fixture: Awaited<ReturnType<typeof createFixture>>, source: AssetSourceOptions): Promise<void> {
  const content = { assetId: source.id, type: source.type, scope: source.scope, workspace: source.workspace ?? null,
    title: source.title ?? `${source.type} title`, summary: source.summary ?? `${source.type} summary`, bodyMarkdown: source.body };
  fixture.writes.write(idGenerator.next("tsk"), "accept", source.id, () => {
    const current = fixture.assets.get(source.id);
    return current ? fixture.assets.revise(source.id, current.version, content) : fixture.assets.insert(content);
  });
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
