import { initializeDatabase } from "../dist/storage/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AssetContentVersionRepository } from "../dist/asset/content-version.js";

const execFileAsync = promisify(execFile);
const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "precedent-loop-n12-build-"));
const repositoryPath = join(fixtureRoot, "asset-repository");
const workspaceConfigPath = join(fixtureRoot, "config", "workspaces.json");
const sourceRelativePath = "inbox/workspaces/alpha/memories/build-smoke.md";
const targetRelativePath = "assets/workspaces/alpha/memories/build-smoke.md";
const source = Buffer.from([
  "---",
  "id: ast2034512345678901248",
  "type: MEMORY",
  "scope: WORKSPACE",
  "workspace: alpha",
  "title: N12 build smoke",
  "summary: verifies compiled confirmation command",
  "---",
  "compiled-confirmation-token",
  "",
].join("\n"), "utf8");
const contentHash = createHash("sha256").update(source).digest("hex");

try {
  await writeFixture(
    workspaceConfigPath,
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspaces: [{ name: "alpha", paths: ["/workspace/alpha"] }],
    }), "utf8"),
  );
  await mkdir(join(repositoryPath, "assets"), { recursive: true });
  await writeFixture(join(repositoryPath, sourceRelativePath), source);
  // Confirmation requires the explicitly migrated candidate store.
  initializeDatabase(join(fixtureRoot, "confirm.sqlite"));


  const { stdout, stderr } = await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@precedent-loop/server",
      "asset:confirm",
      "--",
      "--relative-path",
      sourceRelativePath,
      "--expected-content-hash",
      contentHash,
    ],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
        PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
        PRECEDENT_LOOP_DATABASE_PATH: join(fixtureRoot, "confirm.sqlite"),
      },
    },
  );
  assert.match(stderr, /^\$ node dist\/asset\/confirm-cli\.js -- /u);
  assert.doesNotMatch(stderr, /"ok":false|Error:|ERR_PNPM/u);
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    assetId: "ast2034512345678901248",
    sourceRelativePath,
    targetRelativePath,
    contentHash,
  });
  assert.deepEqual(await readFile(join(repositoryPath, targetRelativePath)), source);
  await assert.rejects(readFile(join(repositoryPath, sourceRelativePath)), { code: "ENOENT" });
  const next = Buffer.from(source.toString().replace("compiled-confirmation-token", "updated-confirmation-token"));
  const nextHash = createHash("sha256").update(next).digest("hex");
  await writeFixture(join(repositoryPath, sourceRelativePath), next);
  for (let attempt = 0; attempt < 2; attempt++) {
    const updated = await execFileAsync(process.execPath, [join(serverRoot, "dist/asset/confirm-cli.js"),
      "--relative-path", sourceRelativePath, "--expected-content-hash", nextHash,
      "--update-asset-id", "ast2034512345678901248", "--expected-baseline-hash", contentHash,
    ], { env: { ...process.env, PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
      PRECEDENT_LOOP_DATABASE_PATH: join(fixtureRoot, "confirm.sqlite"), PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath } });
    assert.equal(JSON.parse(updated.stdout).contentHash, nextHash);
  }
  assert.deepEqual(await readFile(join(repositoryPath, targetRelativePath)), next);
  const versions = new AssetContentVersionRepository(join(fixtureRoot, "confirm.sqlite"));
  try { assert.deepEqual(versions.read("ast2034512345678901248").map(v => v.rawContent), [next, source]); }
  finally { versions.close(); }
  process.stdout.write(`${JSON.stringify({ event: "N12_ASSET_CONFIRM_BUILD_SMOKE", status: "ok" })}\n`);
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}

async function writeFixture(path, source) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}
