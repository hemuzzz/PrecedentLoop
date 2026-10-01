import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Writable } from "node:stream";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import Database from "better-sqlite3";

import {
  AssetConfirmationError,
  AssetIndexManager,
  AssetSearchService,
  computeContentHash,
  confirmInboxAsset,
  scanAssetRepository,
  targetPathForInboxPath,
  type AssetConfirmationErrorCode,
  type AssetScope,
  type AssetType,
} from "../src/asset/index.js";
import {
  CONFIRM_ASSET_REPOSITORY_PATH_ENV,
  CONFIRM_WORKSPACE_CONFIG_PATH_ENV,
  parseArguments,
  runAssetConfirmationCli,
} from "../src/asset/confirm-cli.js";
import { RepositoryOperationError } from "../src/asset/coordination.js";

const idGenerator = new SnowflakeIdGenerator();
const execFileAsync = promisify(execFile);

test("N12 confirms all GLOBAL/WORKSPACE Asset types without changing bytes and supports Catalog Search/Read", async () => {
  const fixture = await createFixture();
  const cases: Array<{ path: string; scope: AssetScope; type: AssetType; workspace?: string }> = [
    { path: "inbox/global/memories/global-memory.md", scope: "GLOBAL", type: "MEMORY" },
    { path: "inbox/global/documents/global-document.md", scope: "GLOBAL", type: "DOCUMENT" },
    { path: "inbox/global/skills/global-skill.md", scope: "GLOBAL", type: "SKILL" },
    {
      path: "inbox/workspaces/alpha/memories/workspace-memory.md",
      scope: "WORKSPACE",
      type: "MEMORY",
      workspace: "alpha",
    },
    {
      path: "inbox/workspaces/alpha/documents/workspace-document.md",
      scope: "WORKSPACE",
      type: "DOCUMENT",
      workspace: "alpha",
    },
    {
      path: "inbox/workspaces/alpha/skills/workspace-skill.md",
      scope: "WORKSPACE",
      type: "SKILL",
      workspace: "alpha",
    },
  ];

  try {
    const expected = new Map<string, { id: string; source: Buffer }>();
    for (const [index, item] of cases.entries()) {
      const id = idGenerator.next("ast");
      const source = Buffer.from(
        assetSource({
          body: `N12-search-token-${index}\r\nExact bytes: café e\u0301`,
          id,
          lineEnding: index % 2 === 0 ? "\r\n" : "\n",
          scope: item.scope,
          type: item.type,
          ...(item.workspace === undefined ? {} : { workspace: item.workspace }),
        }),
        "utf8",
      );
      await writeFixture(join(fixture.repositoryPath, item.path), source);
      expected.set(item.path, { id, source });
    }
    await writeFixture(
      join(fixture.repositoryPath, "inbox/global/memories/unrelated-invalid.md"),
      Buffer.from("no frontmatter", "utf8"),
    );

    for (const item of cases) {
      const value = expected.get(item.path);
      assert.ok(value);
      const contentHash = computeContentHash(value.source);
      const result = await confirmInboxAsset(
        { relativePath: item.path, expectedContentHash: contentHash },
        fixture,
      );
      const targetPath = item.path.replace(/^inbox\//u, "assets/");
      assert.deepEqual(result, {
        ok: true,
        assetId: value.id,
        sourceRelativePath: item.path,
        targetRelativePath: targetPath,
        contentHash,
      });
      assert.deepEqual(await readFile(join(fixture.repositoryPath, targetPath)), value.source);
      assert.equal(await exists(join(fixture.repositoryPath, item.path)), false);
    }

    const formal = await scanAssetRepository(fixture);
    assert.equal(formal.isComplete, true);
    assert.equal(formal.assets.length, 6);
    assert.equal(formal.assets.every(({ contentHash, relativePath }) => {
      const sourcePath = relativePath.replace(/^assets\//u, "inbox/");
      return contentHash === computeContentHash(expected.get(sourcePath)?.source ?? Buffer.alloc(0));
    }), true);

    const manager = await AssetIndexManager.create({ ...fixture, databasePath: fixture.databasePath });
    const sync = await manager.synchronize();
    assert.equal(sync?.added, 6);
    const searchService = new AssetSearchService({
      ...fixture,
      databasePath: fixture.databasePath,
      refreshIndex: () => manager.synchronize(),
    });
    try {
      const found = await searchService.search({
        context: { authorizedWorkspaces: ["alpha"] },
        query: "N12-search-token-4",
      });
      assert.equal(found[0]?.assetId, expected.get(cases[4]?.path ?? "")?.id);
      const read = await searchService.read({
        context: { authorizedWorkspaces: ["alpha"] },
        assetId: expected.get(cases[4]?.path ?? "")?.id ?? "",
      });
      assert.match(read.markdown, /Exact bytes: café e\u0301/u);
    } finally {
      searchService.close();
      await manager.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("N12 maps only the inbox root and rejects unsafe, ambiguous, or override inputs", () => {
  assert.equal(
    targetPathForInboxPath("inbox/global/memories/a.md"),
    "assets/global/memories/a.md",
  );
  assert.equal(
    targetPathForInboxPath("inbox/workspaces/alpha/documents/a.md"),
    "assets/workspaces/alpha/documents/a.md",
  );

  for (const path of [
    "",
    "/inbox/global/memories/a.md",
    "C:\\inbox\\global\\memories\\a.md",
    "inbox/global/memories/../a.md",
    "inbox/global/./memories/a.md",
    "inbox/global//memories/a.md",
    "inbox\\global\\memories\\a.md",
    "inbox/global/memories/a.md\0ignored",
    "assets/global/memories/a.md",
    "inbox/global/memories/a.txt",
    "inbox/global/memories",
    "inbox/global/unknown/a.md",
    "inbox/global/memories/nested/a.md",
  ]) {
    assert.throws(
      () => targetPathForInboxPath(path),
      (error) => hasConfirmationCode(error, "CONFIRM_INPUT_INVALID"),
      path,
    );
  }

  assert.deepEqual(
    parseArguments([
      "--relative-path",
      "inbox/global/memories/a.md",
      "--expected-content-hash",
      "a".repeat(64),
    ]),
    {
      relativePath: "inbox/global/memories/a.md",
      expectedContentHash: "a".repeat(64),
    },
  );
  assert.deepEqual(
    parseArguments([
      "--",
      "--relative-path",
      "inbox/global/memories/a.md",
      "--expected-content-hash",
      "a".repeat(64),
    ]),
    {
      relativePath: "inbox/global/memories/a.md",
      expectedContentHash: "a".repeat(64),
    },
  );
  for (const args of [
    ["--relative-path", "inbox/global/memories/a.md"],
    ["--relative-path", "a.md", "--relative-path", "b.md", "--expected-content-hash", "a".repeat(64)],
    ["--relative-path", "a.md", "--destination", "assets/global/memories/a.md"],
    ["--workspace", "alpha", "--expected-content-hash", "a".repeat(64)],
    ["--scope", "GLOBAL", "--type", "MEMORY"],
    ["--asset-id", idGenerator.next("ast"), "--expected-content-hash", "a".repeat(64)],
    ["--all", "true", "--expected-content-hash", "a".repeat(64)],
  ]) {
    assert.throws(
      () => parseArguments(args),
      (error) => hasConfirmationCode(error, "CONFIRM_INPUT_INVALID"),
    );
  }
});

test("N12 fails closed for selected Scanner violations and ignores unrelated eligibility diagnostics", async () => {
  const fixture = await createFixture();
  const duplicateId = idGenerator.next("ast");
  const paths = {
    invalidFrontmatter: "inbox/global/memories/invalid-frontmatter.md",
    missingFrontmatter: "inbox/global/memories/missing-frontmatter.md",
    invalidId: "inbox/global/memories/invalid-id.md",
    unknownType: "inbox/global/memories/unknown-type.md",
    globalWorkspace: "inbox/global/memories/global-workspace.md",
    workspaceRequired: "inbox/workspaces/alpha/memories/workspace-required.md",
    unknownWorkspace: "inbox/workspaces/unknown/memories/unknown-workspace.md",
    typeMismatch: "inbox/global/memories/type-mismatch.md",
    scopeMismatch: "inbox/global/memories/scope-mismatch.md",
    workspaceMismatch: "inbox/workspaces/beta/memories/workspace-mismatch.md",
    duplicateOne: "inbox/global/memories/duplicate-one.md",
    duplicateTwo: "inbox/global/memories/duplicate-two.md",
    directory: "inbox/global/memories/directory.md",
    symlink: "inbox/global/memories/symlink.md",
    fifo: "inbox/global/memories/fifo.md",
  } as const;

  try {
    await writeFixture(
      join(fixture.repositoryPath, paths.invalidFrontmatter),
      Buffer.from("---\nid: [\n---\nbody", "utf8"),
    );
    await writeFixture(join(fixture.repositoryPath, paths.missingFrontmatter), Buffer.from("body", "utf8"));
    await writeFixture(
      join(fixture.repositoryPath, paths.invalidId),
      Buffer.from(assetSource({ id: "ast_invalid", scope: "GLOBAL", type: "MEMORY" }), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.unknownType),
      Buffer.from(rawAssetSource([`id: ${idGenerator.next("ast")}`, "type: UNKNOWN", "scope: GLOBAL"]), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.globalWorkspace),
      Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY", workspace: "alpha" }), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.workspaceRequired),
      Buffer.from(rawAssetSource([`id: ${idGenerator.next("ast")}`, "type: MEMORY", "scope: WORKSPACE"]), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.unknownWorkspace),
      Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "WORKSPACE", type: "MEMORY", workspace: "unknown" }), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.typeMismatch),
      Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "DOCUMENT" }), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.scopeMismatch),
      Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "WORKSPACE", type: "MEMORY", workspace: "alpha" }), "utf8"),
    );
    await writeFixture(
      join(fixture.repositoryPath, paths.workspaceMismatch),
      Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "WORKSPACE", type: "MEMORY", workspace: "alpha" }), "utf8"),
    );
    for (const path of [paths.duplicateOne, paths.duplicateTwo]) {
      await writeFixture(
        join(fixture.repositoryPath, path),
        Buffer.from(assetSource({ id: duplicateId, scope: "GLOBAL", type: "MEMORY" }), "utf8"),
      );
    }
    await mkdir(join(fixture.repositoryPath, paths.directory), { recursive: true });
    const linkTarget = join(fixture.rootPath, "outside.md");
    await writeFile(linkTarget, assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }), "utf8");
    await symlink(linkTarget, join(fixture.repositoryPath, paths.symlink));
    await execFileAsync("mkfifo", [join(fixture.repositoryPath, paths.fifo)]);

    for (const path of Object.values(paths)) {
      await assertConfirmationRejects(
        () => confirmInboxAsset({ relativePath: path, expectedContentHash: "0".repeat(64) }, fixture),
        "INBOX_ASSET_INVALID",
      );
    }
    await assertConfirmationRejects(
      () => confirmInboxAsset({
        relativePath: "inbox/global/memories/not-found.md",
        expectedContentHash: "0".repeat(64),
      }, fixture),
      "INBOX_ASSET_NOT_FOUND",
    );

    const validPath = "inbox/global/memories/valid-amid-diagnostics.md";
    const validSource = Buffer.from(
      assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
      "utf8",
    );
    await writeFixture(join(fixture.repositoryPath, validPath), validSource);
    const result = await confirmInboxAsset(
      { relativePath: validPath, expectedContentHash: computeContentHash(validSource) },
      fixture,
    );
    assert.equal(result.targetRelativePath, "assets/global/memories/valid-amid-diagnostics.md");
    assert.equal(await exists(join(fixture.repositoryPath, paths.duplicateOne)), true);
    assert.equal(await exists(join(fixture.repositoryPath, paths.symlink)), true);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 rejects formal Asset ID conflicts and never overwrites an existing target", async () => {
  const fixture = await createFixture();
  try {
    const conflictId = idGenerator.next("ast");
    const conflictPath = "inbox/global/memories/id-conflict.md";
    const conflictSource = Buffer.from(assetSource({ id: conflictId, scope: "GLOBAL", type: "MEMORY" }), "utf8");
    await writeFixture(join(fixture.repositoryPath, conflictPath), conflictSource);
    await writeFixture(
      join(fixture.repositoryPath, "assets/global/documents/formal.md"),
      Buffer.from(assetSource({ id: conflictId, scope: "GLOBAL", type: "DOCUMENT" }), "utf8"),
    );
    await assertConfirmationRejects(
      () => confirmInboxAsset({ relativePath: conflictPath, expectedContentHash: computeContentHash(conflictSource) }, fixture),
      "ASSET_ID_CONFLICT",
    );
    assert.equal(await exists(join(fixture.repositoryPath, conflictPath)), true);

    const targetId = idGenerator.next("ast");
    const sourcePath = "inbox/global/memories/target-conflict.md";
    const targetPath = "assets/global/memories/target-conflict.md";
    const source = Buffer.from(assetSource({ id: targetId, scope: "GLOBAL", type: "MEMORY", body: "candidate" }), "utf8");
    const existing = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY", body: "formal" }), "utf8");
    await writeFixture(join(fixture.repositoryPath, sourcePath), source);
    await writeFixture(join(fixture.repositoryPath, targetPath), existing);
    await assertConfirmationRejects(
      () => confirmInboxAsset({ relativePath: sourcePath, expectedContentHash: computeContentHash(source) }, fixture),
      "TARGET_ALREADY_EXISTS",
    );
    assert.deepEqual(await readFile(join(fixture.repositoryPath, targetPath)), existing);
    assert.deepEqual(await readFile(join(fixture.repositoryPath, sourcePath)), source);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 A0 proves a path-only baseline moves replaced bytes while expectedContentHash fails closed", async () => {
  const fixture = await createFixture();
  try {
    const id = idGenerator.next("ast");
    const sourcePath = join(fixture.repositoryPath, "inbox/global/memories/a0.md");
    const baselineTarget = join(fixture.rootPath, "a0-path-only-output.md");
    const safeTarget = join(fixture.repositoryPath, "assets/global/memories/a0.md");
    const reviewed = Buffer.from(assetSource({ id, scope: "GLOBAL", type: "MEMORY", body: "reviewed A" }), "utf8");
    const replaced = Buffer.from(assetSource({ id, scope: "GLOBAL", type: "MEMORY", body: "replacement B" }), "utf8");
    await writeFixture(sourcePath, reviewed);
    const reviewedHash = computeContentHash(reviewed);
    await writeFile(sourcePath, replaced);

    await copyFile(sourcePath, baselineTarget);
    assert.deepEqual(await readFile(baselineTarget), replaced);
    assert.notEqual(computeContentHash(await readFile(baselineTarget)), reviewedHash);

    await assertConfirmationRejects(
      () => confirmInboxAsset({ relativePath: "inbox/global/memories/a0.md", expectedContentHash: reviewedHash }, fixture),
      "CONTENT_HASH_MISMATCH",
    );
    assert.equal(await exists(sourcePath), true);
    assert.equal(await exists(safeTarget), false);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 A1 proves ordinary copy overwrites while exclusive confirmation preserves the target", async () => {
  const fixture = await createFixture();
  try {
    const sourceRelativePath = "inbox/global/memories/a1.md";
    const targetRelativePath = "assets/global/memories/a1.md";
    const sourcePath = join(fixture.repositoryPath, sourceRelativePath);
    const targetPath = join(fixture.repositoryPath, targetRelativePath);
    const source = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY", body: "candidate" }), "utf8");
    const existing = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY", body: "existing formal" }), "utf8");
    await writeFixture(sourcePath, source);
    await writeFixture(targetPath, existing);

    await copyFile(sourcePath, targetPath);
    assert.deepEqual(await readFile(targetPath), source);
    await writeFile(targetPath, existing);

    await assertConfirmationRejects(
      () => confirmInboxAsset({ relativePath: sourceRelativePath, expectedContentHash: computeContentHash(source) }, fixture),
      "TARGET_ALREADY_EXISTS",
    );
    assert.deepEqual(await readFile(targetPath), existing);
    assert.deepEqual(await readFile(sourcePath), source);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 detects source changes after Scanner validation and cleans an uncompleted copied target", async () => {
  const fixture = await createFixture();
  try {
    const relativePath = "inbox/workspaces/alpha/documents/race.md";
    const targetPath = join(fixture.repositoryPath, relativePath.replace(/^inbox\//u, "assets/"));
    const sourcePath = join(fixture.repositoryPath, relativePath);
    const id = idGenerator.next("ast");
    const reviewed = Buffer.from(assetSource({ id, scope: "WORKSPACE", type: "DOCUMENT", workspace: "alpha", body: "A" }), "utf8");
    const changed = Buffer.from(assetSource({ id, scope: "WORKSPACE", type: "DOCUMENT", workspace: "alpha", body: "B" }), "utf8");
    await writeFixture(sourcePath, reviewed);

    // The transaction journal is prepared from validated bytes; an external edit
    // before file publication must fail closed and never be overwritten.
    await assert.rejects(confirmInboxAsset(
      { relativePath, expectedContentHash: computeContentHash(reviewed) },
      withCheckpoint(fixture, async (stage) => { if (stage === "prepared") await writeFile(sourcePath, changed); }),
    ), (error) => error instanceof RepositoryOperationError);
    assert.deepEqual(await readFile(sourcePath), changed);
    assert.equal(await exists(targetPath), false);
    assert.equal(committedConfirmations(fixture), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 concurrent identical confirmations commit once and repeated execution cannot overwrite", async () => {
  const fixture = await createFixture();
  try {
    const relativePath = "inbox/global/skills/concurrent.md";
    const source = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "SKILL" }), "utf8");
    await writeFixture(join(fixture.repositoryPath, relativePath), source);
    const input = { relativePath, expectedContentHash: computeContentHash(source) };
    // Identical path-only requests share one request identity: the loser returns
    // the committed receipt instead of performing a second move.
    const results = await Promise.all([
      confirmInboxAsset(input, fixture),
      confirmInboxAsset(input, fixture),
    ]);
    assert.deepEqual(results[1], results[0]);
    assert.equal(committedConfirmations(fixture), 1);
    const target = join(fixture.repositoryPath, "assets/global/skills/concurrent.md");
    assert.deepEqual(await readFile(target), source);
    assert.equal((await confirmInboxAsset(input, fixture)).ok, true);
    assert.equal(committedConfirmations(fixture), 1);
    assert.deepEqual(await readFile(target), source);
  } finally {
    await fixture.cleanup();
  }
});

test("N12 file publication and database commit failures roll back without losing the source", async () => {
  for (const scenario of ["file-written", "database-commit"] as const) {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath);
    try {
      const relativePath = `inbox/global/documents/${scenario}.md`;
      const sourcePath = join(fixture.repositoryPath, relativePath);
      const targetPath = join(fixture.repositoryPath, relativePath.replace(/^inbox\//u, "assets/"));
      const source = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "DOCUMENT" }), "utf8");
      await writeFixture(sourcePath, source);
      const input = { relativePath, expectedContentHash: computeContentHash(source) };
      if (scenario === "database-commit") {
        database.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON inbox_operation BEGIN SELECT RAISE(ABORT,'injected'); END");
        await assert.rejects(confirmInboxAsset(input, fixture), { code: "DATABASE_WRITE_FAILED" });
      } else {
        await assert.rejects(confirmInboxAsset(input, withCheckpoint(fixture, async (stage) => {
          if (stage === "file-written") throw new Error("injected failure after publication");
        })), { code: "FILE_OPERATION_FAILED" });
      }
      assert.deepEqual(await readFile(sourcePath), source);
      assert.equal(await exists(targetPath), false);
      assert.equal(committedConfirmations(fixture), 0);
      if (scenario === "database-commit") database.exec("DROP TRIGGER reject_receipt");
      // The rolled-back attempt left no receipt, so an explicit retry succeeds once.
      assert.equal((await confirmInboxAsset(input, fixture)).ok, true);
      assert.deepEqual(await readFile(targetPath), source);
      assert.equal(await exists(sourcePath), false);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  }
});

test("N12 fails closed when configuration or a complete repository snapshot is unavailable", async () => {
  const fixture = await createFixture();
  try {
    await assertConfirmationRejects(
      () => confirmInboxAsset(
        { relativePath: "inbox/global/memories/a.md", expectedContentHash: "0".repeat(64) },
        { ...fixture, repositoryPath: "relative" },
      ),
      "CONFIRM_CONFIGURATION_INVALID",
    );
    // Fail closed without creating the missing root; the error code is tracked separately below.
    const missingRepository = join(fixture.rootPath, "missing-repository");
    await assert.rejects(confirmInboxAsset(
      { relativePath: "inbox/global/memories/a.md", expectedContentHash: "0".repeat(64) },
      { ...fixture, repositoryPath: missingRepository },
    ));
    assert.equal(await exists(missingRepository), false);
    assert.equal(committedConfirmations(fixture), 0);

    const invalidConfigPath = join(fixture.rootPath, "invalid-workspaces.json");
    await writeFile(invalidConfigPath, "{}", "utf8");
    await assertConfirmationRejects(
      () => confirmInboxAsset(
        { relativePath: "inbox/global/memories/a.md", expectedContentHash: "0".repeat(64) },
        { ...fixture, workspaceConfigPath: invalidConfigPath },
      ),
      "INBOX_SNAPSHOT_UNAVAILABLE",
    );

    const noAssetsFixture = await createFixture({ createAssetsDirectory: false });
    try {
      const relativePath = "inbox/global/memories/a.md";
      const source = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }), "utf8");
      await writeFixture(join(noAssetsFixture.repositoryPath, relativePath), source);
      await assertConfirmationRejects(
        () => confirmInboxAsset({ relativePath, expectedContentHash: computeContentHash(source) }, noAssetsFixture),
        "INBOX_SNAPSHOT_UNAVAILABLE",
      );
    } finally {
      await noAssetsFixture.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("N12 missing repository root reports INBOX_SNAPSHOT_UNAVAILABLE", async () => {
  const fixture = await createFixture();
  try {
    await assertConfirmationRejects(
      () => confirmInboxAsset(
        { relativePath: "inbox/global/memories/a.md", expectedContentHash: "0".repeat(64) },
        { ...fixture, repositoryPath: join(fixture.rootPath, "missing-repository") },
      ),
      "INBOX_SNAPSHOT_UNAVAILABLE",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("N12 CLI returns stable JSON, safe exit codes, and no sensitive content", async () => {
  const fixture = await createFixture();
  try {
    const relativePath = "inbox/global/memories/cli.md";
    const source = Buffer.from(assetSource({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY", body: "SECRET_MARKDOWN_BODY" }), "utf8");
    await writeFixture(join(fixture.repositoryPath, relativePath), source);
    const environment = {
      [CONFIRM_ASSET_REPOSITORY_PATH_ENV]: fixture.repositoryPath,
      [CONFIRM_WORKSPACE_CONFIG_PATH_ENV]: fixture.workspaceConfigPath,
      PRECEDENT_LOOP_DATABASE_PATH: fixture.databasePath,
    };
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    const code = await runAssetConfirmationCli([
      "--relative-path",
      relativePath,
      "--expected-content-hash",
      computeContentHash(source),
    ], stdout, stderr, environment);
    assert.equal(code, 0);
    assert.equal(stderr.output, "");
    const success = JSON.parse(stdout.output) as Record<string, unknown>;
    assert.equal(success.ok, true);
    assert.equal(success.sourceRelativePath, relativePath);

    const invalidStdout = new StringWriter();
    const invalidStderr = new StringWriter();
    const invalidCode = await runAssetConfirmationCli(
      ["--destination", "/Users/private/formal.md"],
      invalidStdout,
      invalidStderr,
      environment,
    );
    assert.equal(invalidCode, 2);
    assert.equal(invalidStdout.output, "");
    assert.match(invalidStderr.output, /"code":"CONFIRM_INPUT_INVALID"/u);
    assert.doesNotMatch(invalidStderr.output, /\/Users\/private|stack|SECRET_MARKDOWN_BODY/iu);

    const configStderr = new StringWriter();
    const configCode = await runAssetConfirmationCli(
      ["--relative-path", relativePath, "--expected-content-hash", "0".repeat(64)],
      new StringWriter(),
      configStderr,
      {},
    );
    assert.equal(configCode, 2);
    assert.match(configStderr.output, /"code":"CONFIRM_CONFIGURATION_INVALID"/u);
    assert.doesNotMatch(configStderr.output, new RegExp(escapeRegExp(fixture.rootPath), "u"));
  } finally {
    await fixture.cleanup();
  }
});

interface Fixture {
  cleanup: () => Promise<void>;
  databasePath: string;
  repositoryPath: string;
  rootPath: string;
  workspaceConfigPath: string;
}

interface AssetSourceOptions {
  body?: string;
  id: string;
  lineEnding?: "\n" | "\r\n";
  scope: AssetScope;
  type: AssetType;
  workspace?: string;
}

async function createFixture(
  options: { createAssetsDirectory?: boolean } = {},
): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n12-"));
  const repositoryPath = join(rootPath, "asset-repository");
  const workspaceConfigPath = join(rootPath, "config", "workspaces.json");
  if (options.createAssetsDirectory !== false) {
    await mkdir(join(repositoryPath, "assets"), { recursive: true });
  } else {
    await mkdir(repositoryPath, { recursive: true });
  }
  await writeFixture(
    workspaceConfigPath,
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { name: "alpha", paths: ["/workspace/alpha"] },
        { name: "beta", paths: ["/workspace/beta"] },
      ],
    }), "utf8"),
  );
  // Current confirmation requires an explicitly initialized baseline-1 store.
  const databasePath = join(rootPath, "data", "precedent-loop.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });
  initializeDatabase(databasePath);

  return {
    rootPath,
    repositoryPath,
    workspaceConfigPath,
    databasePath,
    cleanup: () => rm(rootPath, { force: true, recursive: true }),
  };
}

type CheckpointStage = "prepared" | "file-written" | "database-committed";

// The public confirmation entry forwards its options to the shared file transaction.
function withCheckpoint(fixture: Fixture, checkpoint: (stage: CheckpointStage) => Promise<void>): Fixture {
  return Object.assign({}, fixture, { checkpoint });
}

function committedConfirmations(fixture: Fixture): number {
  const database = new Database(fixture.databasePath, { readonly: true });
  try {
    return database.prepare<[], { n: number }>("SELECT count(*) AS n FROM inbox_operation WHERE operation = 'confirm'").get()!.n;
  } finally {
    database.close();
  }
}

function assetSource(options: AssetSourceOptions): string {
  const fields = [
    `id: ${options.id}`,
    `type: ${options.type}`,
    `scope: ${options.scope}`,
  ];
  if (options.workspace !== undefined) {
    fields.push(`workspace: ${options.workspace}`);
  }
  fields.push(`title: ${options.type} title`, `summary: ${options.type} summary`);
  return rawAssetSource(fields, options.body, options.lineEnding);
}

function rawAssetSource(
  fields: readonly string[],
  body = "N12 body",
  lineEnding: "\n" | "\r\n" = "\n",
): string {
  return ["---", ...fields, "---", body, ""].join(lineEnding);
}

async function writeFixture(path: string, source: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ? Promise.reject(error)
      : false;
  }
}

async function assertConfirmationRejects(
  operation: () => Promise<unknown>,
  code: AssetConfirmationErrorCode,
): Promise<void> {
  await assert.rejects(operation, (error) => hasConfirmationCode(error, code));
}

function hasConfirmationCode(error: unknown, code: AssetConfirmationErrorCode): boolean {
  return error instanceof AssetConfirmationError && error.code === code;
}

class StringWriter extends Writable {
  output = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += chunk.toString();
    callback();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
