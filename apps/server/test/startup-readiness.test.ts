import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
const root = new URL(process.env.PRECEDENT_LOOP_TEST_DIST === "1" ? "../dist/" : "../src/", import.meta.url);
const { AssetIndexManager, scanAssetRepository }: typeof import("../src/asset/index.js") = await import(new URL("asset/index.js", root).href);
console.log(`F06_MODULE_ROOT ${root.href}`);
for (const change of ["add", "delete", "workspace", "unavailable"] as const) {
  test(`F06 reconciles ${change} between initial Snapshot and watcher registration`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-f06-"));
    const repositoryPath = join(directory, "repo");
    const workspaceConfigPath = join(directory, "workspaces.json");
    const databasePath = join(directory, "db.sqlite");
    const path = join(repositoryPath, "assets/workspaces/alpha/memories/a.md");
    await mkdir(join(repositoryPath, "assets/workspaces/alpha/memories"), { recursive: true });
    await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [join(directory, "alpha")] }] }));
    const source = (id: string) => `---\nid: ${id}\ntype: MEMORY\nscope: WORKSPACE\nworkspace: alpha\ntitle: startup\nsummary: startup\n---\nbody\n`;
    await writeFile(path, source("ast301"));
    initializeDatabase(databasePath);
    let scans = 0;
    let readyBeforeReconciliation = false;
    const manager = await AssetIndexManager.create({ repositoryPath, databasePath, workspaceConfigPath, scanner: async (options) => {
      if (scans === 1) readyBeforeReconciliation = manager.status().indexState === "READY";
      const snapshot = await scanAssetRepository(options);
      if (scans++ === 0) {
        if (change === "add") await writeFile(path.replace("a.md", "b.md"), source("ast302"));
        if (change === "delete") await unlink(path);
        if (change === "workspace") await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
        if (change === "unavailable") await unlink(workspaceConfigPath);
      }
      return snapshot;
    } });
    try {
      const status = await manager.start();
      assert.ok(scans >= 2, "Watcher ready must be followed by a complete reconciliation");
      assert.equal(readyBeforeReconciliation, false);
      assert.equal(status.indexState, change === "unavailable" ? "DEGRADED" : "READY");
      const db = new Database(databasePath, { readonly: true });
      try {
        assert.equal((db.prepare("SELECT count(*) AS n FROM asset_catalog").get() as { n: number }).n, change === "add" ? 2 : change === "unavailable" ? 1 : 0);
      } finally { db.close(); }
    } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
