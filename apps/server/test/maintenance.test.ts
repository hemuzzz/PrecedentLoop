import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";
const dist = process.env.PRECEDENT_LOOP_TEST_DIST === "1";
const root = new URL(dist ? "../dist/" : "../src/", import.meta.url);

test("unknown maintenance commands never change the authoritative database or create a missing one", async () => {
  const f = await knowledgeFixture();
  try {
    await f.asset({ title: "maintenance" });
    const before = await readFile(f.options.databasePath);
    for (const command of ["unknown-command", "unsupported-operation"]) {
      assert.equal((await cli([command, "--offline"], f.options.databasePath)).code, 1);
      assert.deepEqual(await readFile(f.options.databasePath), before);
      const missing = join(f.root, "missing.sqlite");
      assert.equal((await cli([command, "--offline"], missing)).code, 1);
      await assert.rejects(readFile(missing), { code: "ENOENT" });
    }
    const corrupt = join(f.root, "corrupt.sqlite");
    await writeFile(corrupt, "not sqlite");
    assert.equal((await cli(["init-database", "--offline"], corrupt)).code, 1);
    assert.equal(await readFile(corrupt, "utf8"), "not sqlite");
  } finally { await f.close(); }
});

test("capability revoke CLI logically deletes only the selected capability and preserves operation facts", async () => {
  const f = await knowledgeFixture();
  try {
    const asset = await f.asset({ title: "maintenance" });
    const read = await f.service.read({ capabilityIds: [f.alpha], assetId: asset.assetId });
    await f.service.used({ capabilityIds: [f.alpha], readRef: read.readRef });
    const facts = f.rows();
    const digest = createHash("sha256").update(f.alpha).digest("hex");
    assert.equal((await cli(["revoke-capability", "--digest", digest], f.options.databasePath)).code, 0);
    await assert.rejects(f.capabilities.select([f.alpha]), { code: "CAPABILITY_INVALID" });
    assert.deepEqual((await f.capabilities.select([f.beta])).authorizedWorkspaces, ["beta"]);
    for (const table of ["recall_operation", "recall_item", "read_operation", "used_event"]) assert.deepEqual(f.rows()[table], facts[table]);
    assert.equal((f.repository.db.prepare("SELECT is_deleted FROM workspace_capability WHERE capability_key_hash=?").get(digest) as { is_deleted: number }).is_deleted, 1);
    assert.equal((await cli(["revoke-capability", "--digest", "invalid"], f.options.databasePath)).code, 1);
  } finally { await f.close(); }
});

function cli(args: string[], databasePath: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(dist ? [] : ["--import", "tsx"]), fileURLToPath(new URL(`maintenance-cli.${dist ? "js" : "ts"}`, root)), ...args],
      { env: { ...process.env, PRECEDENT_LOOP_DATABASE_PATH: databasePath }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
