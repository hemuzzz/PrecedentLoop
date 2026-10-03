import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dataPaths, inspectNode, verifyBundledNode } from "../src/config.js";
import { DataDirectoryError, ensureMarker, initializeDataDirectory, inspectDataDirectory, prepareDirectoryLayout, readSchemaCookie } from "../src/data-directory.js";
import { fixtureExecutor } from "./executor-fixture.js";

function header(schemaCookie: number, userVersion = 0): Buffer {
  const bytes = Buffer.alloc(100);
  bytes.write("SQLite format 3\0"); bytes.writeUInt32BE(schemaCookie, 40); bytes.writeUInt32BE(userVersion, 60);
  return bytes;
}
async function product(path: string, schemaCookie = 1): Promise<void> {
  await mkdir(join(path, "runtime"), { recursive: true });
  await writeFile(dataPaths(path).databasePath, header(schemaCookie));
  try { await writeFile(join(path, ".precedentloop.json"), JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), dataId: randomUUID() }), { flag: "wx" }); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
}
async function fakeRuntime(root: string, fail = "", schemaCookie = 1): Promise<string> {
  const runtime = join(root, "PrecedentLoop-Test-data.app/Contents/Resources/runtime");
  const helper = await fixtureExecutor(runtime);
  await writeFile(join(runtime, "build-info.json"), JSON.stringify({ buildId: randomUUID(), ...await inspectNode(helper) }));
  await mkdir(join(runtime, "apps/server/dist"), { recursive: true });
  await writeFile(join(runtime, "apps/server/dist/maintenance-cli.js"), `
    const fs = require('node:fs'), path = require('node:path');
    if (fs.realpathSync(process.argv[1]) !== process.argv[1]) process.exit(0);
    const command = process.argv[2];
    for (const key of ['DATABASE_PATH', 'WORKSPACES_PATH', 'LOG_PATH']) {
      if (!path.isAbsolute(process.env['PRECEDENT_LOOP_' + key])) throw Error('nonabsolute environment');
    }
    fs.appendFileSync('commands.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
    if (command === ${JSON.stringify(fail)}) { console.error('fixture initialization failed'); process.exit(3); }
    const header = Buffer.alloc(100); header.write('SQLite format 3\\0');
    header.writeUInt32BE(${schemaCookie}, 40);
    fs.writeFileSync(process.env.PRECEDENT_LOOP_DATABASE_PATH, header);
  `);
  return runtime;
}

test("directory inspection is read-only and classifies missing, empty, unrelated, product and unsupported data", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-data-"));
  try {
    const path = join(root, "data");
    assert.deepEqual(await inspectDataDirectory(path), { kind: "MISSING" });
    assert.deepEqual(await readdir(root), []);
    await mkdir(path);
    assert.deepEqual(await inspectDataDirectory(path), { kind: "EMPTY" });
    assert.deepEqual(await readdir(path), []);
    await writeFile(join(path, "mine.txt"), "preserve");
    assert.deepEqual(await inspectDataDirectory(path), { kind: "OTHER_NON_EMPTY" });
    await product(path);
    assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT" });
    assert.equal(await readFile(join(path, "mine.txt"), "utf8"), "preserve");
    assert.ok(await readFile(join(path, ".precedentloop.json")));
    for (const schemaCookie of [0, 1, 2, 4, 256, 0xffffffff]) {
      for (const userVersion of [0, 1, 2, 7, 0xffffffff]) {
        await writeFile(dataPaths(path).databasePath, header(schemaCookie, userVersion));
        assert.equal(await readSchemaCookie(dataPaths(path).databasePath), schemaCookie);
        assert.deepEqual(await inspectDataDirectory(path), { kind: schemaCookie > 0 ? "PRODUCT" : "PRODUCT_INCOMPLETE" });
      }
    }
    const wrongMagic = header(1); wrongMagic.write("SQLite format 2\0");
    for (const bytes of [Buffer.alloc(100), header(1).subarray(0, 99), wrongMagic, Buffer.alloc(0)]) {
      await writeFile(dataPaths(path).databasePath, bytes);
      assert.equal(await readSchemaCookie(dataPaths(path).databasePath), undefined);
      assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT_UNSUPPORTED", reason: "SQLite 文件头无效" });
    }
    await rm(dataPaths(path).databasePath);
    await mkdir(dataPaths(path).databasePath);
    assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT_UNSUPPORTED", reason: "主数据库不是普通文件" });
    assert.equal((await inspectDataDirectory(join(path, "mine.txt"))).kind, "NOT_WRITABLE");
    assert.equal((await inspectDataDirectory("relative")).kind, "NOT_WRITABLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marker identifies incomplete product data, refuses malformed markers and only adds missing markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-marker-"));
  try {
    const path = join(root, "data");
    await mkdir(path);
    await writeFile(join(path, ".precedentloop.json"), JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), dataId: randomUUID() }));
    assert.equal((await inspectDataDirectory(path)).kind, "PRODUCT_INCOMPLETE");
    await product(path);
    const before = await readFile(join(path, ".precedentloop.json"));
    await ensureMarker(path);
    assert.deepEqual(await readFile(join(path, ".precedentloop.json")), before);
    await rm(join(path, ".precedentloop.json"));
    const db = await readFile(dataPaths(path).databasePath);
    await assert.rejects(ensureMarker(path), /不是可用/);
    await product(path);
    await ensureMarker(path);
    const marker = JSON.parse(await readFile(join(path, ".precedentloop.json"), "utf8"));
    assert.equal(marker.formatVersion, 1); assert.match(marker.dataId, /^[a-f0-9-]{36}$/u);
    assert.ok(Number.isFinite(Date.parse(marker.createdAt)));
    assert.deepEqual(await readFile(dataPaths(path).databasePath), db);
    await writeFile(join(path, ".precedentloop.json"), "broken");
    assert.equal((await inspectDataDirectory(path)).kind, "PRODUCT_UNSUPPORTED");
    await assert.rejects(ensureMarker(path), /不是可用/);
    assert.equal(await readFile(join(path, ".precedentloop.json"), "utf8"), "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspection reports access failure and cloud paths including a symlink without writing probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-data-risk-"));
  const locked = join(root, "locked");
  try {
    await mkdir(locked);
    await chmod(locked, 0o500);
    assert.equal((await inspectDataDirectory(locked)).kind, "NOT_WRITABLE");
    assert.equal((await inspectDataDirectory(join(locked, "new"))).kind, "NOT_WRITABLE");
    await chmod(locked, 0o700);
    await product(locked);
    await chmod(dataPaths(locked).databasePath, 0o000);
    assert.equal((await inspectDataDirectory(locked)).kind, "NOT_WRITABLE");
    await chmod(dataPaths(locked).databasePath, 0o600);
    for (const name of ["Mobile Documents", "CloudStorage"]) {
      const cloud = join(root, "Library", name);
      assert.deepEqual(await inspectDataDirectory(cloud, root), { kind: "SYNC_RISK", inspection: { kind: "MISSING" } });
      await product(cloud);
      assert.deepEqual(await inspectDataDirectory(cloud, root), { kind: "SYNC_RISK", inspection: { kind: "PRODUCT" } });
      assert.equal((await inspectDataDirectory(`${cloud}-unrelated`, root)).kind, "MISSING");
    }
    await symlink(join(root, "Library/CloudStorage"), join(root, "alias"));
    assert.equal((await inspectDataDirectory(join(root, "alias/new"), root)).kind, "SYNC_RISK");
  } finally { await chmod(locked, 0o700); await rm(root, { recursive: true, force: true }); }
});

test("initialization uses bundled initialization and produces the fixed layout for empty or missing directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-init-"));
  try {
    const runtime = await fakeRuntime(root);
    for (const empty of [true, false]) {
      const path = join(root, empty ? "empty data" : "missing data");
      if (empty) await mkdir(path);
      await initializeDataDirectory(path, runtime);
      assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT" });
      assert.deepEqual(JSON.parse(await readFile(dataPaths(path).workspaceConfigPath, "utf8")), { schemaVersion: 1, workspaces: [] });
      await assert.rejects(stat(join(path, "repository")), { code: "ENOENT" });
      assert.ok((await stat(join(path, "logs"))).isDirectory());
      assert.deepEqual((await readFile(join(path, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)),
        [["init-database", "--offline"]]);
      await assert.rejects(initializeDataDirectory(path, runtime), /仅允许/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real built CLI initialization succeeds through the desktop runtime path with user_version zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-real-init-"));
  try {
    // Build @precedent-loop/server first. The Helper is a fixture; the CLI and schema are real build output.
    const cli = fileURLToPath(new URL("../../server/dist/maintenance-cli.js", import.meta.url));
    assert.ok((await stat(cli)).isFile());
    const runtime = await fakeRuntime(root);
    const entry = join(runtime, "apps/server/dist/maintenance-cli.js");
    await rm(entry);
    await symlink(cli, entry);
    const path = join(root, "data");
    await initializeDataDirectory(path, runtime);
    assert.ok((await readSchemaCookie(dataPaths(path).databasePath))! > 0);
    assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT" });
    const database = new DatabaseSync(dataPaths(path).databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 0);
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'asset'").get());
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real SQLite empty headers are incomplete and existing tables are recognized regardless of user_version", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-sqlite-header-"));
  try {
    for (const userVersion of [0, 2, 7]) {
      const path = join(root, `data-${userVersion}`);
      await prepareDirectoryLayout(path);
      const database = new DatabaseSync(dataPaths(path).databasePath);
      try { database.exec(`PRAGMA user_version = ${userVersion}`); }
      finally { database.close(); }
      assert.equal(await readSchemaCookie(dataPaths(path).databasePath), 0);
      assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT_INCOMPLETE" });
      const existing = new DatabaseSync(dataPaths(path).databasePath);
      try { existing.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY)"); }
      finally { existing.close(); }
      assert.ok((await readSchemaCookie(dataPaths(path).databasePath))! > 0);
      const before = await readFile(dataPaths(path).databasePath);
      assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT" });
      assert.deepEqual(await readFile(dataPaths(path).databasePath), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a successful CLI exit with an uninitialized schema fails the initialization check", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-init-check-"));
  try {
    const runtime = await fakeRuntime(root, "", 0);
    const path = join(root, "data");
    await assert.rejects(initializeDataDirectory(path, runtime), error =>
      error instanceof DataDirectoryError && error.step === "核对存储已初始化" && error.message.includes("存储尚未初始化"));
    assert.deepEqual(await inspectDataDirectory(path), { kind: "PRODUCT_INCOMPLETE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("initialization reports the failed step, retains partial results, and never writes into an unrelated directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-init-failure-"));
  try {
    const runtime = await fakeRuntime(root, "init-database");
    const path = join(root, "data");
    await assert.rejects(initializeDataDirectory(path, runtime), error => error instanceof DataDirectoryError && error.step === "init-database");
    await assert.rejects(readSchemaCookie(dataPaths(path).databasePath), { code: "ENOENT" });
    assert.equal((await inspectDataDirectory(path)).kind, "PRODUCT_INCOMPLETE");
    assert.ok(await readFile(join(path, ".precedentloop.json")));
    assert.ok(await readFile(dataPaths(path).workspaceConfigPath));
    const other = join(root, "other"); await mkdir(other); await writeFile(join(other, "mine"), "do not change");
    await assert.rejects(initializeDataDirectory(other, runtime), /仅允许/);
    assert.deepEqual(await readdir(other), ["mine"]);
    assert.equal(await readFile(join(other, "mine"), "utf8"), "do not change");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Helper identity derives from App name and validates every recorded runtime field", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-executor-"));
  try {
    const runtime = join(root, "PrecedentLoop-Test-identity.app/Contents/Resources/runtime");
    const helper = await fixtureExecutor(runtime);
    assert.match(helper, /PrecedentLoop-Test-identity Helper\.app\/Contents\/MacOS\/PrecedentLoop-Test-identity Helper$/u);
    const build = { buildId: randomUUID(), ...await inspectNode(helper) };
    assert.equal(await verifyBundledNode(runtime, build), helper);
    for (const mismatch of [{ modules: "mismatch" }, { nodeVersion: "v0.0.0" }, { electronVersion: "0.0.0" },
      { arch: build.arch === "arm64" ? "x64" as const : "arm64" as const }]) {
      await assert.rejects(verifyBundledNode(runtime, { ...build, ...mismatch }), /ABI/);
    }
    await assert.rejects(readFile(join(runtime, "node/bin/node")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marked missing or schema-cookie-zero storage resumes without changing existing content; DS_Store is ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-resume-"));
  try {
    const runtime = await fakeRuntime(root);
    const empty = join(root, "finder-empty"); await mkdir(empty); await writeFile(join(empty, ".DS_Store"), "finder");
    assert.equal((await inspectDataDirectory(empty)).kind, "EMPTY");
    await initializeDataDirectory(empty, runtime);
    assert.equal(await readFile(join(empty, ".DS_Store"), "utf8"), "finder");
    for (const schemaCookie of [undefined, 0]) {
      const path = join(root, `partial-${schemaCookie}`);
      await mkdir(path);
      const marker = JSON.stringify({ formatVersion: 1, dataId: randomUUID(), createdAt: new Date().toISOString() });
      await writeFile(join(path, ".precedentloop.json"), marker);
      if (schemaCookie === 0) await product(path, 0);
      await mkdir(join(path, "config"), { recursive: true });
      await writeFile(dataPaths(path).workspaceConfigPath, '{"schemaVersion":1,"workspaces":[]}\n');
      await writeFile(join(path, "keep.md"), "retain");
      const configBefore = await stat(dataPaths(path).workspaceConfigPath);
      assert.equal((await inspectDataDirectory(path)).kind, "PRODUCT_INCOMPLETE");
      await initializeDataDirectory(path, runtime);
      assert.equal((await inspectDataDirectory(path)).kind, "PRODUCT");
      assert.equal(await readFile(join(path, ".precedentloop.json"), "utf8"), marker);
      assert.equal(await readFile(join(path, "keep.md"), "utf8"), "retain");
      assert.equal((await stat(dataPaths(path).workspaceConfigPath)).mtimeMs, configBefore.mtimeMs);
    }
    const interrupted = join(root, "interrupted");
    await assert.rejects(initializeDataDirectory(interrupted, join(root, "no-runtime")), /校验包内运行时/);
    assert.equal((await inspectDataDirectory(interrupted)).kind, "PRODUCT_INCOMPLETE");
    await initializeDataDirectory(interrupted, runtime);
    assert.equal((await inspectDataDirectory(interrupted)).kind, "PRODUCT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all data writes reject sync-risk paths until explicit confirmation, including symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-sync-write-"));
  try {
    const runtime = await fakeRuntime(root);
    const cloud = join(root, "Library/CloudStorage"); await mkdir(cloud, { recursive: true });
    const alias = join(root, "alias"); await symlink(cloud, alias);
    const path = join(alias, "data");
    await assert.rejects(initializeDataDirectory(path, runtime, { home: root }), /确认同步盘风险/);
    assert.deepEqual(await readdir(cloud), []);
    await initializeDataDirectory(path, runtime, { home: root, syncRiskConfirmed: true });
    await rm(join(path, ".precedentloop.json"));
    await assert.rejects(ensureMarker(path, { home: root }), /确认同步盘风险/);
    await product(path);
    await ensureMarker(path, { home: root, syncRiskConfirmed: true });
    assert.equal(await readSchemaCookie(dataPaths(path).databasePath), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
