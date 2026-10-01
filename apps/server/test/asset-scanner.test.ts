import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import {
  ASSET_SCOPES,
  ASSET_TYPES,
  assetFrontmatterSchema,
  computeContentHash,
  scanAssetRepository,
  workspaceConfigSchema,
  type AssetScope,
  type AssetType,
} from "../src/asset/index.js";

const idGenerator = new SnowflakeIdGenerator();
const execFileAsync = promisify(execFile);

test("defines strict Frontmatter and schemaVersion=1 Workspace schemas", () => {
  assert.deepEqual(ASSET_TYPES, ["MEMORY", "DOCUMENT", "SKILL"]);
  assert.deepEqual(ASSET_SCOPES, ["GLOBAL", "WORKSPACE"]);

  for (const type of ASSET_TYPES) {
    assert.equal(
      assetFrontmatterSchema.safeParse({
        id: idGenerator.next("ast"),
        scope: "GLOBAL",
        summary: `${type} summary`,
        title: `${type} title`,
        type,
      }).success,
      true,
    );
  }

  assert.equal(
    assetFrontmatterSchema.safeParse({
      id: idGenerator.next("ast"),
      scope: "WORKSPACE",
      summary: "Workspace summary",
      title: "Workspace title",
      type: "MEMORY",
      workspace: "precedent-loop",
    }).success,
    true,
  );
  assert.equal(
    assetFrontmatterSchema.safeParse({
      id: idGenerator.next("tsk"),
      scope: "GLOBAL",
      summary: "Wrong prefix",
      title: "Wrong prefix",
      type: "MEMORY",
    }).success,
    false,
  );
  assert.equal(
    assetFrontmatterSchema.safeParse({
      id: idGenerator.next("ast"),
      scope: "UNKNOWN",
      summary: "Unknown scope",
      title: "Unknown scope",
      type: "MEMORY",
    }).success,
    false,
  );
  assert.equal(
    assetFrontmatterSchema.safeParse({
      id: idGenerator.next("ast"),
      scope: "GLOBAL",
      summary: "Global summary",
      title: "Global title",
      type: "MEMORY",
      workspace: "precedent-loop",
    }).success,
    false,
  );
  assert.equal(
    assetFrontmatterSchema.safeParse({
      id: idGenerator.next("ast"),
      scope: "WORKSPACE",
      summary: "Missing workspace",
      title: "Missing workspace",
      type: "MEMORY",
    }).success,
    false,
  );

  const validConfig = {
    schemaVersion: 1,
    workspaces: [{ name: "precedent-loop", paths: ["/workspace/precedent-loop"] }],
  };
  assert.equal(workspaceConfigSchema.safeParse(validConfig).success, true);
  assert.equal(workspaceConfigSchema.safeParse({ ...validConfig, schemaVersion: 2 }).success, false);
  assert.equal(
    workspaceConfigSchema.safeParse({
      schemaVersion: 1,
      workspaces: [
        { name: "duplicate", paths: ["/workspace/one"] },
        { name: "duplicate", paths: ["/workspace/two"] },
      ],
    }).success,
    false,
  );
  assert.equal(
    workspaceConfigSchema.safeParse({
      schemaVersion: 1,
      workspaces: [{ name: "global", paths: ["/workspace/global"] }],
    }).success,
    false,
  );
});

test("hashes the current file bytes without newline or Unicode normalization", () => {
  assert.equal(
    computeContentHash(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  const lf = Buffer.from("caf\u00e9\n", "utf8");
  const crlf = Buffer.from("cafe\u0301\r\n", "utf8");

  assert.notEqual(computeContentHash(lf), computeContentHash(crlf));
});

test("scans only formal single-file Markdown Assets and hashes their exact bytes", async () => {
  const fixture = await createFixture();

  try {
    const globalSource = frontmatter({
      id: idGenerator.next("ast"),
      lineEnding: "\r\n",
      scope: "GLOBAL",
      type: "MEMORY",
    });
    const workspaceDocumentSource = frontmatter({
      id: idGenerator.next("ast"),
      scope: "WORKSPACE",
      type: "DOCUMENT",
      workspace: "alpha",
    });
    const workspaceSkillSource = frontmatter({
      id: idGenerator.next("ast"),
      scope: "WORKSPACE",
      type: "SKILL",
      workspace: "alpha",
    });

    await writeAsset(fixture.repositoryPath, "assets/global/memories/global.md", globalSource);
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/documents/document.md",
      workspaceDocumentSource,
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/skills/skill.md",
      workspaceSkillSource,
    );
    await writeAsset(
      fixture.repositoryPath,
      "inbox/global/memories/ignored.md",
      frontmatter({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );

    const result = await scanAssetRepository(fixture);

    assert.equal(result.isComplete, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.assets.map(({ relativePath }) => relativePath),
      [
        "assets/global/memories/global.md",
        "assets/workspaces/alpha/documents/document.md",
        "assets/workspaces/alpha/skills/skill.md",
      ],
    );

    const globalAsset = result.assets.find(
      ({ relativePath }) => relativePath === "assets/global/memories/global.md",
    );
    assert.ok(globalAsset);
    assert.equal(
      globalAsset.contentHash,
      createHash("sha256").update(Buffer.from(globalSource, "utf8")).digest("hex"),
    );
    assert.notEqual(
      globalAsset.contentHash,
      createHash("sha256").update(Buffer.from(globalSource.replaceAll("\r\n", "\n"), "utf8")).digest("hex"),
    );
    assert.equal(globalAsset.fileSize, Buffer.byteLength(globalSource));
    assert.match(globalAsset.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("keeps every invalid or conflicting Asset out of successful scan results", async () => {
  const fixture = await createFixture();
  const duplicateId = idGenerator.next("ast");
  const fifoPath = join(fixture.repositoryPath, "assets/global/memories/fifo.md");

  try {
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/valid.md",
      frontmatter({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/duplicate-one.md",
      frontmatter({ id: duplicateId, scope: "GLOBAL", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/documents/duplicate-two.md",
      frontmatter({ id: duplicateId, scope: "GLOBAL", type: "DOCUMENT" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/gamma/memories/unknown-workspace.md",
      frontmatter({
        id: idGenerator.next("ast"),
        scope: "WORKSPACE",
        type: "MEMORY",
        workspace: "gamma",
      }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/documents/scope-mismatch.md",
      frontmatter({
        id: idGenerator.next("ast"),
        scope: "WORKSPACE",
        type: "DOCUMENT",
        workspace: "alpha",
      }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/memories/workspace-mismatch.md",
      frontmatter({
        id: idGenerator.next("ast"),
        scope: "WORKSPACE",
        type: "MEMORY",
        workspace: "beta",
      }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/documents/type-mismatch.md",
      frontmatter({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/unknown-type.md",
      rawFrontmatter([
        `id: ${idGenerator.next("ast")}`,
        "type: UNKNOWN",
        "scope: GLOBAL",
        "title: Unknown type",
        "summary: Unknown type",
      ]),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/global-workspace.md",
      rawFrontmatter([
        `id: ${duplicateId}`,
        "type: MEMORY",
        "scope: GLOBAL",
        "workspace: alpha",
        "title: Global workspace",
        "summary: Global workspace",
      ]),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/workspaces/alpha/memories/missing-workspace.md",
      rawFrontmatter([
        `id: ${idGenerator.next("ast")}`,
        "type: MEMORY",
        "scope: WORKSPACE",
        "title: Missing workspace",
        "summary: Missing workspace",
      ]),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/missing-frontmatter.md",
      "# Missing frontmatter\n",
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/invalid-frontmatter.md",
      rawFrontmatter([
        `id: ${idGenerator.next("ast")}`,
        "type: MEMORY",
        "scope: GLOBAL",
        "title: Missing summary",
      ]),
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/not-markdown.txt",
      "not markdown",
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/directory-asset/nested.md",
      frontmatter({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );
    await symlink("valid.md", join(fixture.repositoryPath, "assets/global/memories/symlink.md"));
    await execFileAsync("mkfifo", [fifoPath]);

    const result = await scanAssetRepository(fixture);
    const codesByPath = new Map<string, Set<string>>();
    for (const item of result.diagnostics) {
      const codes = codesByPath.get(item.path) ?? new Set<string>();
      codes.add(item.code);
      codesByPath.set(item.path, codes);
    }

    assert.deepEqual(result.assets.map(({ relativePath }) => relativePath), [
      "assets/global/memories/valid.md",
    ]);
    assertDiagnostic(codesByPath, "assets/global/memories/duplicate-one.md", "DUPLICATE_ASSET_ID");
    assertDiagnostic(codesByPath, "assets/global/documents/duplicate-two.md", "DUPLICATE_ASSET_ID");
    assertDiagnostic(codesByPath, "assets/workspaces/gamma/memories/unknown-workspace.md", "UNKNOWN_WORKSPACE");
    assertDiagnostic(codesByPath, "assets/global/documents/scope-mismatch.md", "PATH_SCOPE_MISMATCH");
    assertDiagnostic(
      codesByPath,
      "assets/workspaces/alpha/memories/workspace-mismatch.md",
      "PATH_WORKSPACE_MISMATCH",
    );
    assertDiagnostic(codesByPath, "assets/global/documents/type-mismatch.md", "PATH_TYPE_MISMATCH");
    assertDiagnostic(codesByPath, "assets/global/memories/unknown-type.md", "UNKNOWN_ASSET_TYPE");
    assertDiagnostic(
      codesByPath,
      "assets/global/memories/global-workspace.md",
      "GLOBAL_WORKSPACE_FORBIDDEN",
    );
    assertDiagnostic(
      codesByPath,
      "assets/global/memories/global-workspace.md",
      "DUPLICATE_ASSET_ID",
    );
    assertDiagnostic(
      codesByPath,
      "assets/workspaces/alpha/memories/missing-workspace.md",
      "WORKSPACE_REQUIRED",
    );
    assertDiagnostic(codesByPath, "assets/global/memories/missing-frontmatter.md", "MISSING_FRONTMATTER");
    assertDiagnostic(codesByPath, "assets/global/memories/invalid-frontmatter.md", "INVALID_FRONTMATTER");
    assertDiagnostic(codesByPath, "assets/global/memories/not-markdown.txt", "NON_MARKDOWN_FILE");
    assertDiagnostic(codesByPath, "assets/global/memories/directory-asset", "DIRECTORY_ASSET");
    assertDiagnostic(codesByPath, "assets/global/memories/symlink.md", "SYMLINK");
    assertDiagnostic(codesByPath, "assets/global/memories/fifo.md", "NON_REGULAR_FILE");
  } finally {
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("invalid Workspace configuration fails closed before scanning Assets", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(
      fixture.workspaceConfigPath,
      JSON.stringify({ schemaVersion: 2, workspaces: [] }),
      "utf8",
    );
    await writeAsset(
      fixture.repositoryPath,
      "assets/global/memories/would-be-valid.md",
      frontmatter({ id: idGenerator.next("ast"), scope: "GLOBAL", type: "MEMORY" }),
    );

    const result = await scanAssetRepository(fixture);

    assert.equal(result.isComplete, false);
    assert.deepEqual(result.assets, []);
    assert.deepEqual(result.diagnostics.map(({ code }) => code), ["INVALID_WORKSPACE_CONFIG"]);
  } finally {
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

test("marks a missing Asset repository root as an incomplete scan instead of an empty snapshot", async () => {
  const fixture = await createFixture();

  try {
    await rm(join(fixture.repositoryPath, "assets"), { recursive: true });

    const result = await scanAssetRepository(fixture);

    assert.equal(result.isComplete, false);
    assert.deepEqual(result.assets, []);
    assert.deepEqual(result.diagnostics.map(({ code }) => code), ["ASSETS_DIRECTORY_MISSING"]);
  } finally {
    await rm(fixture.rootPath, { force: true, recursive: true });
  }
});

interface Fixture {
  repositoryPath: string;
  rootPath: string;
  workspaceConfigPath: string;
}

async function createFixture(): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n03-"));
  const repositoryPath = join(rootPath, "asset-repository");
  const workspaceConfigPath = join(rootPath, "workspaces.json");

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

  return { repositoryPath, rootPath, workspaceConfigPath };
}

interface FrontmatterOptions {
  id: string;
  lineEnding?: "\n" | "\r\n";
  scope: AssetScope;
  type: AssetType;
  workspace?: string;
}

function frontmatter(options: FrontmatterOptions): string {
  const fields = [
    `id: ${options.id}`,
    `type: ${options.type}`,
    `scope: ${options.scope}`,
  ];

  if (options.workspace !== undefined) {
    fields.push(`workspace: ${options.workspace}`);
  }

  fields.push(`title: ${options.type} title`, `summary: ${options.type} summary`);
  return rawFrontmatter(fields, options.lineEnding);
}

function rawFrontmatter(fields: string[], lineEnding: "\n" | "\r\n" = "\n"): string {
  return ["---", ...fields, "---", "# Body", ""].join(lineEnding);
}

async function writeAsset(repositoryPath: string, relativePath: string, source: string): Promise<void> {
  const absolutePath = join(repositoryPath, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}

function assertDiagnostic(
  codesByPath: Map<string, Set<string>>,
  path: string,
  expectedCode: string,
): void {
  assert.equal(codesByPath.get(path)?.has(expectedCode), true, `${path} should have ${expectedCode}`);
}
