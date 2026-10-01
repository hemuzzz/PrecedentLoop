import { initializeDatabase } from "../dist/storage/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startPrecedentLoopServer } from "../dist/runtime.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "precedent-loop-f01-build-"));
const repositoryPath = join(root, "repository");
const workspaceConfigPath = join(root, "workspaces.json");
const marker = join(root, "execution-marker");
const cliPath = fileURLToPath(new URL("../dist/asset/confirm-cli.js", import.meta.url));
const validSource = (id) => `---\r\nid: ${id}\r\ntype: MEMORY\r\nscope: GLOBAL\r\ntitle: 中文标题\r\nsummary: 合法摘要\r\n---\r\n中文正文 e\u0301 😀\r\n`;
const unsafeSource = (id) => `---javascript\n(require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'compiled parser executed'), ${JSON.stringify({ id, type: "MEMORY", scope: "GLOBAL", title: "invalid", summary: "invalid" })})\n---\nbody\n`;
const candidate = "inbox/global/memories/unsafe-inbox.md";
const unsafe = unsafeSource("ast2034512345678901249");
const valid = validSource("ast2034512345678901250");
const hash = (source) => createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
let runtime;

try {
  await mkdir(join(repositoryPath, "assets/global/memories"), { recursive: true });
  await mkdir(join(repositoryPath, "inbox/global/memories"), { recursive: true });
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  await writeFile(join(repositoryPath, "assets/global/memories/valid.md"), validSource("ast2034512345678901247"));
  await writeFile(join(repositoryPath, "assets/global/memories/unsafe.md"), unsafeSource("ast2034512345678901248"));
  await writeFile(join(repositoryPath, candidate), unsafe);
  await writeFile(join(repositoryPath, "inbox/global/memories/valid-inbox.md"), valid);
  // Startup never migrates; mirror the explicit offline installation step.
  initializeDatabase(join(root, "memory.sqlite"));

  runtime = await startPrecedentLoopServer({
    assetRepositoryPath: repositoryPath,
    databasePath: join(root, "memory.sqlite"),
    workspaceConfigPath,
    logPath: join(root, "runtime.log"),
    port: await allocatePort(),
  });
  assert.equal(existsSync(marker), false, "compiled startup scan must not execute");
  for (const path of ["/api/assets", "/api/inbox", "/api/system/status"]) {
    const response = await fetch(new URL(path, runtime.endpoint));
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(existsSync(marker), false, path);
    if (path === "/api/system/status") {
      assert.equal(body.data.repository.formalAssetCount, 1);
      assert.equal(body.data.repository.inboxAssetCount, 1);
      assert.ok(body.data.diagnostics.some((item) => item.code === "INVALID_FRONTMATTER" && item.relativePath === candidate));
    } else {
      assert.equal(body.data.items.length, 1);
      assert.match(body.data.items[0].relativePath, /\/valid(?:-inbox)?\.md$/u);
      if (path === "/api/inbox") {
        assert.ok(body.data.diagnostics.some((item) => item.code === "INVALID_FRONTMATTER" && item.relativePath === candidate));
      }
    }
  }
  await runtime.close();
  runtime = undefined;
  const cliOptions = {
    timeout: 10_000,
    env: {
      ...process.env,
      PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repositoryPath,
      PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath,
      PRECEDENT_LOOP_DATABASE_PATH: join(root, "memory.sqlite"),
    },
  };
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "--relative-path", candidate, "--expected-content-hash", hash(unsafe)], cliOptions),
    (error) => error.code === 2 && error.stdout === "" && JSON.parse(error.stderr).error.code === "INBOX_ASSET_INVALID",
  );
  assert.equal(existsSync(marker), false);
  assert.equal(await readFile(join(repositoryPath, candidate), "utf8"), unsafe);
  assert.equal(existsSync(join(repositoryPath, "assets/global/memories/unsafe-inbox.md")), false);
  // The existing formal unsafe file is unchanged; failed confirmation never overwrites it.
  assert.equal(await readFile(join(repositoryPath, "assets/global/memories/unsafe.md"), "utf8"), unsafeSource("ast2034512345678901248"));
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath, "--relative-path", "inbox/global/memories/valid-inbox.md", "--expected-content-hash", hash(valid),
  ], cliOptions);
  assert.equal(JSON.parse(stdout).contentHash, hash(valid));
  assert.equal(await readFile(join(repositoryPath, "assets/global/memories/valid-inbox.md"), "utf8"), valid);
  assert.equal(existsSync(marker), false);
  console.log(JSON.stringify({ event: "F01_BUILD_SMOKE", status: "ok", markerExists: false }));
} finally {
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
}

async function allocatePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
