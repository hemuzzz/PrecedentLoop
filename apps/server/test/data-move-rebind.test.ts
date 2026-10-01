import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import { configureRepositoryCoordination } from "../src/asset/coordination.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";

function capture() {
  let text = "";
  return { stream: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }), text: () => text };
}
async function dataDirectory(root: string, name: string) {
  const directory = join(root, name), repository = join(directory, "repository"), database = join(directory, "runtime/precedent-loop.sqlite");
  await mkdir(repository, { recursive: true }); await mkdir(join(directory, "runtime"), { recursive: true });
  new Database(database).close();
  return { directory, repository, database };
}
const boundPath = (repository: string) => {
  const database = new Database(join(repository, ".candidate-coordination.sqlite"), { readonly: true });
  try { return (database.prepare("SELECT value FROM configuration WHERE key='databasePath'").get() as { value: string } | undefined)?.value; }
  finally { database.close(); }
};

test("rebind-coordination points a copied data directory at its own database and leaves the source bound to the original", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "precedent-rebind-")));
  try {
    const source = await dataDirectory(root, "source");
    await configureRepositoryCoordination(source.repository, source.database);
    const copy = { directory: join(root, "copy"), repository: join(root, "copy/repository"), database: join(root, "copy/runtime/precedent-loop.sqlite") };
    await cp(source.directory, copy.directory, { recursive: true });
    // Without rebinding, the copy is still bound to the source database.
    await assert.rejects(configureRepositoryCoordination(copy.repository, copy.database), /同一知识库必须使用同一数据库/);
    const out = capture(), err = capture();
    const code = await runMaintenanceCli(["rebind-coordination", "--offline"],
      { PRECEDENT_LOOP_DATABASE_PATH: copy.database, PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: copy.repository }, out.stream, err.stream);
    assert.equal(code, 0, err.text());
    assert.deepEqual(JSON.parse(out.text()), { ok: true, rebound: true });
    assert.equal(boundPath(copy.repository), await realpath(copy.database));
    assert.equal(boundPath(source.repository), await realpath(source.database));
    await configureRepositoryCoordination(copy.repository, copy.database);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rebind-coordination requires --offline, reports a repository without coordination, and rejects a non-file coordination entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "precedent-rebind-")));
  try {
    const target = await dataDirectory(root, "target");
    const env = { PRECEDENT_LOOP_DATABASE_PATH: target.database, PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: target.repository };
    const refused = capture();
    assert.equal(await runMaintenanceCli(["rebind-coordination"], env, capture().stream, refused.stream), 1);
    assert.match(refused.text(), /--offline/);
    const out = capture();
    assert.equal(await runMaintenanceCli(["rebind-coordination", "--offline"], env, out.stream, capture().stream), 0);
    assert.deepEqual(JSON.parse(out.text()), { ok: true, rebound: false });
    await mkdir(join(target.repository, ".candidate-coordination.sqlite"));
    const invalid = capture();
    assert.equal(await runMaintenanceCli(["rebind-coordination", "--offline"], env, capture().stream, invalid.stream), 1);
    assert.match(invalid.text(), /协调文件必须是普通文件/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
