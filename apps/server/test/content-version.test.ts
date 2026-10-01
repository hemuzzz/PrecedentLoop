import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AssetContentVersionRepository } from "../src/asset/content-version.js";
import { AssetDiffService, compareContentVersions, DIFF_LIMITS } from "../src/asset/content-diff.js";
import { confirmInboxAsset, computeContentHash, AssetIndexManager, AssetSearchService, scanAssetRepository } from "../src/asset/index.js";
import { withRepositoryAccess } from "../src/asset/coordination.js";

const id = "ast2034512345678901248";
const relativePath = "inbox/global/memories/entry.md";
const formalPath = "assets/global/memories/entry.md";
const exec = promisify(execFile);
const source = (body: string) => Buffer.from(`\ufeff---\r\nid: ${id}\r\ntype: MEMORY\r\nscope: GLOBAL\r\ntitle: Content\r\nsummary: Current conclusion\r\n---\r\n${body}`);
const input = (bytes: Buffer, baseline?: Buffer) => ({ relativePath, expectedContentHash: computeContentHash(bytes),
  ...(baseline ? { updateAssetId: id, expectedBaselineHash: computeContentHash(baseline) } : {}) });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-version-"));
  const options = { repositoryPath: join(root, "repository"), databasePath: join(root, "data.sqlite"), workspaceConfigPath: join(root, "workspaces.json") };
  await mkdir(join(options.repositoryPath, "assets/global/memories"), { recursive: true });
  await mkdir(join(options.repositoryPath, "inbox/global/memories"), { recursive: true });
  await writeFile(options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  initializeDatabase(options.databasePath);

  return { ...options, root, candidate: (bytes: Buffer) => writeFile(join(options.repositoryPath, relativePath), bytes),
    formal: () => readFile(join(options.repositoryPath, formalPath)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function rows(repository: AssetContentVersionRepository) {
  const result = repository.read(id); assert.ok(Array.isArray(result)); return result;
}

test("A -> B -> C retains exact B/C bytes and timestamps; no-op/retries do not rotate; rebuild preserves durable history", async () => {
  const f = await fixture(); const a = source("A\n"), b = source("B\r\n"), c = source("C e\u0301");
  try {
    await f.candidate(a); await confirmInboxAsset(input(a), f);
    const versions = new AssetContentVersionRepository(f.databasePath);
    try {
      assert.equal(rows(versions).length, 1); assert.deepEqual(rows(versions)[0]?.rawContent, a);
      const aTime = rows(versions)[0]?.recordedAt;
      await f.candidate(b); await confirmInboxAsset(input(b, a), f);
      assert.equal(rows(versions).find(v => v.status === "PREVIOUS")?.recordedAt, aTime);
      await confirmInboxAsset(input(b, a), f);
      await f.candidate(b); const before = rows(versions); await confirmInboxAsset(input(b, b), f);
      assert.deepEqual(rows(versions), before);
      await f.candidate(c); await confirmInboxAsset(input(c, b), f);
      assert.deepEqual(rows(versions).map(v => v.rawContent), [c, b]); assert.deepEqual(await f.formal(), c);
      const manager = await AssetIndexManager.create(f);
      try {
        await manager.synchronize();
        // Offline rebuild exercises the actual maintenance Catalog implementation.
        const { AssetCatalog } = await import("../src/asset/catalog.js");
        const catalog = new AssetCatalog(f.databasePath, { maintenance: true });
        try { catalog.rebuild((await scanAssetRepository(f)).assets, new Date().toISOString()); } finally { catalog.close(); }
        await manager.synchronize();
        assert.deepEqual(rows(versions).map(v => v.rawContent), [c, b]);
        const search = new AssetSearchService({ ...f, refreshIndex: () => manager.synchronize() });
        try {
          const diff = new AssetDiffService(search, versions);
          assert.equal((await diff.get(id)).status, "AVAILABLE");
          await writeFile(join(f.repositoryPath, formalPath), source("external edit"));
          await manager.synchronize();
          assert.equal((await diff.get(id)).status, "CONTENT_MISMATCH");
          await unlink(join(f.repositoryPath, formalPath));
          await assert.rejects(diff.get(id));
        } finally { search.close(); }
      } finally { await manager.close(); }
    } finally { versions.close(); }
  } finally { await f.cleanup(); }
});

test("rejected hash, baseline, scope, path and concurrent updates preserve versions", async () => {
  const f = await fixture(); const a = source("A"), b = source("B"), c = source("C");
  try {
    await f.candidate(a); await confirmInboxAsset(input(a), f);
    await f.candidate(b);
    await assert.rejects(confirmInboxAsset(input(c, a), f), { code: "CONTENT_HASH_MISMATCH" });
    await assert.rejects(confirmInboxAsset(input(b, c), f), { code: "BASELINE_MISMATCH" });
    await f.candidate(Buffer.from(b.toString().replace("type: MEMORY", "type: DOCUMENT")));
    await assert.rejects(confirmInboxAsset(input(b, a), f));
    assert.deepEqual(await f.formal(), a);
    await f.candidate(b);
    const outcomes = await Promise.allSettled([confirmInboxAsset(input(b, a), f), confirmInboxAsset(input(b, a), f)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 2, "same committed request is idempotent");
    await f.candidate(c);
    await assert.rejects(confirmInboxAsset(input(c, a), f), { code: "BASELINE_MISMATCH" });
    const versions = new AssetContentVersionRepository(f.databasePath);
    try { assert.deepEqual(rows(versions).map(v => v.rawContent), [b, a]); } finally { versions.close(); }
  } finally { await f.cleanup(); }
});

test("SQL failure after file replacement rolls back both slots; exact retry completes once", async () => {
  const f = await fixture(); const a = source("A"), b = source("B"), c = source("C");
  try {
    await f.candidate(a); await confirmInboxAsset(input(a), f); await f.candidate(b); await confirmInboxAsset(input(b, a), f); await f.candidate(c);
    const db = new Database(f.databasePath);
    db.exec("CREATE TRIGGER fail_current BEFORE INSERT ON asset_content_version BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await assert.rejects(confirmInboxAsset(input(c, b), f));
    assert.deepEqual(await f.formal(), b);
    assert.deepEqual(await readFile(join(f.repositoryPath, relativePath)), c);
    assert.equal((db.prepare("SELECT count(*) AS n FROM asset_content_version").get() as {n:number}).n, 2);
    db.exec("DROP TRIGGER fail_current"); db.close();
    await confirmInboxAsset(input(c, b), f); await confirmInboxAsset(input(c, b), f);
    const versions = new AssetContentVersionRepository(f.databasePath);
    try { assert.deepEqual(rows(versions).map(v => v.rawContent), [c, b]); } finally { versions.close(); }
  } finally { await f.cleanup(); }
});

for (const stage of ["prepared", "file-written", "database-committed"] as const) {
  for (const update of [false, true]) {
    test(`real child exit at ${stage}, ${update ? "update" : "create"}: recover exact bytes without extra rotation`, async () => {
      const f = await fixture(); const a = source("A"), b = source("B");
      try {
        if (update) { await f.candidate(a); await confirmInboxAsset(input(a), f); }
        await f.candidate(b);
        const request = input(b, update ? a : undefined);
        await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
          `import { confirmInboxAsset } from ${JSON.stringify(resolve("src/asset/confirmation.ts"))};
           await confirmInboxAsset(${JSON.stringify(request)}, { ...${JSON.stringify(f)}, checkpoint: async s => { if (s === ${JSON.stringify(stage)}) process.exit(73); } });`,
        ]), (error: unknown) => error instanceof Error && "code" in error && error.code === 73);
        // The first reader recovers; it must not complete an uncommitted request.
        const snapshot = await scanAssetRepository(f);
        assert.equal(snapshot.assets.length, update || stage === "database-committed" ? 1 : 0);
        if (stage !== "database-committed") {
          if (update) assert.deepEqual(await f.formal(), a);
          assert.deepEqual(await readFile(join(f.repositoryPath, relativePath)), b);
        } else assert.deepEqual(await f.formal(), b);
        await confirmInboxAsset(request, f); await confirmInboxAsset(request, f);
        const versions = new AssetContentVersionRepository(f.databasePath);
        try { assert.deepEqual(rows(versions).map(v => v.rawContent), update ? [b, a] : [b]); } finally { versions.close(); }
        assert.deepEqual(await f.formal(), b);
      } finally { await f.cleanup(); }
    });
  }
}

test("recovery does not overwrite later external edits or accept another invocation", async () => {
  const f = await fixture(); const a = source("A"), b = source("B"), c = source("external C");
  try {
    await f.candidate(a); await confirmInboxAsset(input(a), f); await f.candidate(b);
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { confirmInboxAsset } from ${JSON.stringify(resolve("src/asset/confirmation.ts"))};
       await confirmInboxAsset(${JSON.stringify(input(b, a))}, { ...${JSON.stringify(f)}, checkpoint: async s => { if (s === 'file-written') process.exit(73); } });`
    ]));
    const recoveryPath = join(f.repositoryPath, ".candidate-transaction.json");
    const saved = await readFile(recoveryPath);
    await writeFile(join(f.repositoryPath, formalPath), c);
    await assert.rejects(withRepositoryAccess(f.repositoryPath, async () => undefined), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await f.formal(), c); assert.deepEqual(await readFile(recoveryPath), saved);
    await unlink(join(f.repositoryPath, formalPath));
    await symlink(join(f.repositoryPath, relativePath), join(f.repositoryPath, formalPath));
    await assert.rejects(confirmInboxAsset(input(b, a), f));
    assert.deepEqual(await readFile(join(f.repositoryPath, relativePath)), b);
  } finally { await f.cleanup(); }
});

function version(bytes: Buffer) { return { status: "CURRENT" as const, rawContent: bytes, contentHash: computeContentHash(bytes), recordedAt: "2026-09-06T00:00:00.000Z" }; }
const eol = { LF: "\n", CRLF: "\r\n", CR: "\r", NONE: "" };
test("lossless line diff reconstructs BOM, mixed EOL, final newline, Unicode and empty inputs", () => {
  for (const [a, b] of [["a\r\n", "a\n"], ["a\rb\n\r\nc", "a\nb\rc\r"], ["a\n", "a"], ["a", "\ufeffa"], ["é", "e\u0301"], ["", "\n"], ["a", ""], ["", ""]]) {
    const old = Buffer.from(a!), next = Buffer.from(b!);
    const result = compareContentVersions(id, formalPath, version(old), version(next));
    assert.equal(result.status, "AVAILABLE"); if (result.status !== "AVAILABLE") continue;
    assert.equal(result.hasChanges, !old.equals(next));
    for (const [excluded, expected] of [["add", a], ["delete", b]]) {
      const reconstructed = result.hunks.flatMap(h => h.lines).filter(l => l.kind !== excluded).map(l => l.text + eol[l.eol]).join("");
      assert.equal(reconstructed, expected);
    }
  }
});

test("budgets, invalid encoding and JSON expansion return explicit non-success with no partial hunks", () => {
  const compare = (a: Buffer, b: Buffer, limits = DIFF_LIMITS) => compareContentVersions(id, formalPath, version(a), version(b), limits);
  assert.equal(compare(Buffer.from([255]), Buffer.from("ok")).status, "UNSUPPORTED_ENCODING");
  assert.equal(compare(Buffer.alloc(1024 * 1024 + 1), Buffer.from("x")).status, "INPUT_LIMIT_EXCEEDED");
  assert.equal(compare(Buffer.from("x\n".repeat(2001)), Buffer.from("y")).status, "INPUT_LIMIT_EXCEEDED");
  const start = performance.now();
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(compare(Buffer.from("x\n".repeat(2000)), Buffer.from("y\n".repeat(2000))), { assetId: id, status: "WORK_LIMIT_EXCEEDED" });
  }
  for (const [a, b] of [["repeat\n".repeat(990), "other\n".repeat(990)], ["a\nb\n".repeat(495), "b\na\n".repeat(495)]]) {
    assert.equal(compare(Buffer.from(a!), Buffer.from(b!)).status, "AVAILABLE");
  }
  console.log(`20 worst-shape budget rejections: ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(compare(Buffer.alloc(1024 * 1024, 0), Buffer.alloc(1024 * 1024, 1)).status, "OUTPUT_LIMIT_EXCEEDED");
  assert.equal(compareContentVersions(id, formalPath, version(Buffer.from("a")), version(Buffer.from("b")), { ...DIFF_LIMITS, outputLines: 1 }).status, "OUTPUT_LIMIT_EXCEEDED");
});

test("stored hash corruption and missing durable schema fail explicitly", async () => {
  const f = await fixture();
  try {
    const versions = new AssetContentVersionRepository(f.databasePath);
    versions.rotate(id, null, source("A"));
    versions.database.prepare("UPDATE asset_content_version SET content_hash = 'bad'").run();
    assert.throws(() => versions.read(id), { code: "CONTENT_VERSION_INTEGRITY_ERROR" });
    versions.database.exec("DROP TABLE asset_content_version");
    assert.throws(() => versions.read(id)); versions.close();
    assert.throws(() => new AssetContentVersionRepository(f.databasePath), { code: "DATABASE_SCHEMA_INVALID" });
  } finally { await f.cleanup(); }
});

test("real REST Diff budgets remain read-only and concurrent ordinary REST/MCP requests complete", async () => {
  const f = await fixture();
  const { createServer } = await import("node:http");
  const { startPrecedentLoopServer } = await import("../src/runtime.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  let runtime: Awaited<ReturnType<typeof startPrecedentLoopServer>> | undefined;
  let client: InstanceType<typeof Client> | undefined;
  try {
    const a = source("old-line\n".repeat(1990)), b = source("new-line\n".repeat(1990));
    await f.candidate(a); await confirmInboxAsset(input(a), f);
    await f.candidate(b); await confirmInboxAsset(input(b, a), f);
    runtime = await startPrecedentLoopServer({ assetRepositoryPath: f.repositoryPath, databasePath: f.databasePath,
      workspaceConfigPath: f.workspaceConfigPath, logPath: join(f.root, "runtime.log"), port: address.port });
    client = new Client({ name: "content-diff-test", version: "0.0.0" });
    // Same SDK exactOptionalPropertyTypes mismatch as the existing MCP transport fixture.
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.endpoint)) as unknown as Transport);
    const url = new URL(`/api/assets/${id}/diff`, runtime.endpoint);
    for (const [suffix, method, status] of [["", "POST", 405], ["?path=outside", "GET", 400], ["?ref=HEAD", "GET", 400]] as const) {
      assert.equal((await fetch(url.href + suffix, { method })).status, status);
    }
    assert.equal((await fetch(url, { headers: { origin: "https://untrusted.example" } })).status, 403);
    const started = performance.now();
    const requests = Array.from({ length: 12 }, async () => {
      const response = await fetch(url); assert.equal(response.status, 200);
      const body = await response.json() as { data: { diff: unknown } };
      assert.deepEqual(body.data.diff, { assetId: id, status: "WORK_LIMIT_EXCEEDED" });
    });
    const ordinaryRest = fetch(new URL("/api/assets", url)).then(r => assert.equal(r.status, 200));
    const ordinaryMcp = client.callTool({ name: "asset_read", arguments: { capabilityIds: [], assetId: id } }).then(r => {
      assert.equal(r.isError, undefined);
      const content = r.content as { type: string; text?: string }[];
      assert.equal(content[0]?.type, "text");
      const read = JSON.parse(content[0]!.text!) as { markdown: string; usageRecorded: boolean };
      assert.equal(read.usageRecorded, true);
      assert.match(read.markdown, /new-line/);
      assert.doesNotMatch(read.markdown, /old-line/);
    });
    await Promise.all([...requests, ordinaryRest, ordinaryMcp]);
    console.log(`12 concurrent Diff + REST/MCP: ${(performance.now() - started).toFixed(1)} ms`);
    const db = new Database(f.databasePath);
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM asset_content_version").get() as {n: number}).n, 2);
      // Diff writes no facts; only the explicit Read above records a read operation.
      assert.equal((db.prepare("SELECT count(*) AS n FROM read_operation").get() as {n:number}).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM used_event").get() as {n:number}).n, 0);
    } finally { db.close(); }
  } finally { await client?.close(); await runtime?.close(); await f.cleanup(); }
});

test("untracked and first registered version are distinct; oversized BLOB is rejected before materialization", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repositoryPath, formalPath), source("legacy"));
    const manager = await AssetIndexManager.create(f);
    const versions = new AssetContentVersionRepository(f.databasePath);
    await manager.synchronize();
    const search = new AssetSearchService({ ...f, refreshIndex: () => manager.synchronize() });
    try {
      const diff = new AssetDiffService(search, versions);
      assert.deepEqual(await diff.get(id), { assetId: id, status: "UNTRACKED" });
      // Isolated fixture baseline, not an initialization command for real Assets.
      versions.rotate(id, null, source("legacy"));
      assert.deepEqual(await diff.get(id), { assetId: id, status: "NO_PREVIOUS_VERSION" });
      versions.database.prepare("UPDATE asset_content_version SET raw_content = zeroblob(?)").run(DIFF_LIMITS.inputBytes + 1);
      assert.deepEqual(await diff.get(id), { assetId: id, status: "INPUT_LIMIT_EXCEEDED" });
    } finally { search.close(); versions.close(); await manager.close(); }
  } finally { await f.cleanup(); }
});

test("a reader blocking COMMIT rolls back file and database, then permits a fresh explicit retry", async () => {
  const f = await fixture(); const a = source("A"), b = source("B");
  const reader = new Database(f.databasePath);
  try {
    await f.candidate(a); await confirmInboxAsset(input(a), f); await f.candidate(b);
    await assert.rejects(confirmInboxAsset(input(b, a), { ...f, checkpoint: async stage => {
      if (stage === "file-written") { reader.exec("BEGIN"); reader.prepare("SELECT * FROM asset_content_version").all(); }
    } }));
    assert.deepEqual(await f.formal(), a);
    assert.deepEqual(await readFile(join(f.repositoryPath, relativePath)), b);
    reader.exec("ROLLBACK");
    await confirmInboxAsset(input(b, a), f);
    assert.equal((reader.prepare("SELECT count(*) AS n FROM asset_content_version").get() as {n:number}).n, 2);
  } finally { reader.close(); await f.cleanup(); }
});
