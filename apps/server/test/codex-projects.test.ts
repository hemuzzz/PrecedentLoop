import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeCodexWorkspaces } from "../src/workspace/codex-projects.js";
import { candidateFixture } from "../test-support/candidate-fixture.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { readCodexProjects } from "../src/workspace/codex-project-parser.js";
import { loadWorkspaceConfig } from "../src/asset/scanner.js";

test("selected desktop imports bind exact config bytes and reject unlisted paths inside the repository lock", async () => {
  const f = await candidateFixture();
  const statePath = join(f.root, "state.json"), empty = '{"schemaVersion":1,"workspaces":[]}';
  const state = JSON.stringify({ "local-projects": { one: { name: "one", rootPaths: [f.root] } } });
  await writeFile(statePath, state); await writeFile(f.options.workspaceConfigPath, empty);
  try {
    for (const selection of [
      { paths: [f.root], expectedConfig: empty + " ", append: true },
      { paths: [join(f.root, "unlisted")], expectedConfig: empty, append: true },
    ]) {
      await assert.rejects(initializeCodexWorkspaces(f.options, statePath, selection), { code: "WORKSPACE_CONFIG_CHANGED" });
      assert.equal(await readFile(f.options.workspaceConfigPath, "utf8"), empty);
    }
  } finally { await f.cleanup(); }
});

test("first use reads saved local projects, removes stale/duplicate paths and writes host-only workspaces once", async () => {
  const f = await candidateFixture();
  const statePath = join(f.root, "codex-state.json"), one = join(f.root, "one"), two = join(f.root, "two");
  await mkdir(one); await mkdir(two);
  const empty = JSON.stringify({ schemaVersion: 1, workspaces: [] });
  await writeFile(f.options.workspaceConfigPath, empty);
  await writeFile(statePath, JSON.stringify({
    "local-projects": { a: { name: "project", rootPaths: [one] }, b: { name: "project", rootPaths: [two] },
      c: { name: "duplicate", rootPaths: [one] }, d: { name: "deleted", rootPaths: [join(f.root, "missing")] } },
    "electron-saved-workspace-roots": [f.root], unrelated: "must never become a workspace",
  }));
  try {
    const [config, concurrent] = await Promise.all([initializeCodexWorkspaces(f.options, statePath), initializeCodexWorkspaces(f.options, statePath)]);
    assert.deepEqual(config, concurrent);
    // New entries carry no access field: every workspace is available across projects.
    assert.deepEqual(config.workspaces.map(value => [value.name, value.knowledgeAccess]), [["project", undefined], ["project (2)", undefined]]);
    assert.deepEqual(config.workspaces.map(value => value.paths), [[await realpath(one)], [await realpath(two)]]);
    const bytes = await readFile(f.options.workspaceConfigPath);
    await writeFile(statePath, "invalid later state");
    assert.deepEqual(await initializeCodexWorkspaces(f.options, statePath), config);
    assert.deepEqual(await readFile(f.options.workspaceConfigPath), bytes);
    assert.equal((await f.service.list()).items.length, 0);
  } finally { await f.cleanup(); }
});

test("existing names, paths, aliases and explicit authorization stay byte-for-byte unchanged", async () => {
  const f = await candidateFixture();
  const config = { schemaVersion: 1, workspaces: [{ name: "renamed", paths: [f.root], aliases: ["别名"], description: "保留说明", knowledgeAccess: "PREAUTHORIZED" }] };
  await writeFile(f.options.workspaceConfigPath, JSON.stringify(config, null, 4));
  try {
    const before = await readFile(f.options.workspaceConfigPath);
    assert.deepEqual(await initializeCodexWorkspaces(f.options, "/not-read"), config);
    assert.deepEqual(await readFile(f.options.workspaceConfigPath), before);
  } finally { await f.cleanup(); }
});

test("missing, unsupported or invalid Codex state cannot partially initialize workspaces", async () => {
  const f = await candidateFixture(); const statePath = join(f.root, "state.json");
  const empty = JSON.stringify({ schemaVersion: 1, workspaces: [] });
  await writeFile(f.options.workspaceConfigPath, empty);
  try {
    for (const state of ["not-json", { "electron-saved-workspace-roots": [f.root] }, { "local-projects": { a: { name: "valid", rootPaths: [f.root] }, b: { name: "relative", rootPaths: ["relative"] } } }]) {
      await writeFile(statePath, typeof state === "string" ? state : JSON.stringify(state));
      await assert.rejects(initializeCodexWorkspaces(f.options, statePath), { code: "CODEX_PROJECTS_UNAVAILABLE" });
      assert.equal(await readFile(f.options.workspaceConfigPath, "utf8"), empty);
    }
    await writeFile(statePath, JSON.stringify({ "local-projects": { a: { name: "../unsafe", rootPaths: [f.root] } } }));
    await assert.rejects(initializeCodexWorkspaces(f.options, statePath), { code: "CODEX_PROJECT_NAME_INVALID" });
    await writeFile(statePath, JSON.stringify({ "local-projects": {} }));
    await assert.rejects(initializeCodexWorkspaces(f.options, statePath), { code: "CODEX_PROJECTS_EMPTY" });
    assert.equal(await readFile(f.options.workspaceConfigPath, "utf8"), empty);
  } finally { await f.cleanup(); }
});

test("new config can be initialized but symlinked config and Codex state are refused", async () => {
  const f = await candidateFixture(); const statePath = join(f.root, "state.json"), linkedState = join(f.root, "linked-state.json"), target = join(f.root, "protected.json");
  const empty = JSON.stringify({ schemaVersion: 1, workspaces: [] });
  await writeFile(statePath, JSON.stringify({ "local-projects": { a: { name: "local", rootPaths: [f.root] } } }));
  try {
    await unlink(f.options.workspaceConfigPath);
    assert.equal((await initializeCodexWorkspaces(f.options, statePath)).workspaces[0]?.name, "local");
    await writeFile(f.options.workspaceConfigPath, empty);
    await symlink(statePath, linkedState);
    await assert.rejects(initializeCodexWorkspaces(f.options, linkedState), { code: "CODEX_PROJECTS_UNAVAILABLE" });
    await unlink(f.options.workspaceConfigPath); await writeFile(target, empty); await symlink(target, f.options.workspaceConfigPath);
    await assert.rejects(initializeCodexWorkspaces(f.options, statePath), /must not be a symlink/);
    assert.equal(await readFile(target, "utf8"), empty);
  } finally { await f.cleanup(); }
});

test("append validates inside the lock and an existing capability service offers new workspaces across projects without restart", async () => {
  const f = await candidateFixture(), repository = new KnowledgeRepository(f.options.databasePath);
  const capabilities = new WorkspaceCapabilityService(repository, f.options.workspaceConfigPath);
  try {
    const old = await realpath(f.root), next = join(old, "new-project"), duplicate = join(old, "duplicate");
    await mkdir(next); await mkdir(duplicate);
    const config = { schemaVersion: 1, workspaces: [{ name: "old", paths: [join(old, "old-project")], aliases: ["  Keep  "], description: "  Preserve  ", knowledgeAccess: "HOST_ONLY" }] };
    await writeFile(f.options.workspaceConfigPath, JSON.stringify(config));
    // Registered workspaces are offered from any directory, including unregistered ones.
    assert.deepEqual((await capabilities.issueFromTrustedHost(next)).map(value => value.workspace), ["old"]);
    const before = await readFile(f.options.workspaceConfigPath, "utf8"), statePath = join(old, "state.json");
    const state = JSON.stringify({ "local-projects": { a: { name: "new", rootPaths: [next] }, b: { name: "new", rootPaths: [duplicate] } } });
    await writeFile(statePath, state);
    const candidates = await readCodexProjects(statePath, await loadWorkspaceConfig(f.options.workspaceConfigPath), { home: join(old, "home") });
    // Same-name projects merge into one candidate instead of conflicting.
    assert.deepEqual(candidates.map(value => [value.name, value.paths.map(path => [path.path, path.reason ?? null])]), [["new", [[next, null], [duplicate, null]]]]);
    await assert.rejects(initializeCodexWorkspaces(f.options, statePath, { paths: [join(old, "missing")], expectedConfig: before, append: true }), { code: "WORKSPACE_CONFIG_CHANGED" });
    assert.equal(await readFile(f.options.workspaceConfigPath, "utf8"), before);
    const result = await initializeCodexWorkspaces(f.options, statePath, { paths: [next], expectedConfig: before, append: true, home: join(old, "home") });
    assert.deepEqual(result.workspaces[0], config.workspaces[0]); assert.deepEqual(result.workspaces[1], { name: "new", paths: [next] });
    // The project containing cwd comes first, then the rest by name.
    const issued = await capabilities.issueFromTrustedHost(next);
    assert.deepEqual(issued.map(value => value.workspace), ["new", "old"]);
    assert.deepEqual((await capabilities.select(issued.map(value => value.capabilityId))).authorizedWorkspaces, ["new", "old"]);
    assert.deepEqual((await capabilities.issueFromTrustedHost(join(old, "unrelated"))).map(value => value.workspace), ["new", "old"]);
    await assert.rejects(initializeCodexWorkspaces(f.options, statePath, { paths: [next], expectedConfig: before, append: true }), { code: "WORKSPACE_CONFIG_CHANGED" });
  } finally { repository.close(); await f.cleanup(); }
});

test("append merges Codex and Claude Code projects by exact name and explains every excluded directory", async () => {
  const f = await candidateFixture();
  try {
    const root = await realpath(f.root), home = join(root, "home"), shared = join(home, "work/shared"), claudeOnly = join(home, "work/notes");
    const registered = join(home, "work/registered"), worktree = join(home, "work/shared/.claude/worktrees/kind-1");
    for (const path of [shared, claudeOnly, join(registered, "src"), worktree]) await mkdir(path, { recursive: true });
    const statePath = join(root, "codex-state.json"), claudeConfigPath = join(root, "claude.json");
    await writeFile(statePath, JSON.stringify({ "local-projects": { a: { name: "shared", rootPaths: [shared] }, b: { name: "gone", rootPaths: [join(home, "gone")] } } }));
    await writeFile(claudeConfigPath, JSON.stringify({ projects: { [shared]: {}, [claudeOnly]: {}, [home]: {}, [root]: {}, [worktree]: {}, [join(registered, "src")]: {}, relative: {} }, other: 1 }));
    const config = { schemaVersion: 1 as const, workspaces: [{ name: "registered", paths: [registered], knowledgeAccess: "PREAUTHORIZED" as const }] };
    const projects = await readCodexProjects(statePath, config, { claudeConfigPath, home });
    const view = Object.fromEntries(projects.map(value => [value.name, { sources: value.sources, paths: value.paths.map(path => [path.path, path.reason ?? null, path.registeredAs ?? null]) }]));
    assert.deepEqual(view, {
      shared: { sources: ["claude", "codex"], paths: [[shared, null, null]] },
      gone: { sources: ["codex"], paths: [[join(home, "gone"), "目录不存在", null]] },
      notes: { sources: ["claude"], paths: [[claudeOnly, null, null]] },
      home: { sources: ["claude"], paths: [[home, "主目录或其上级目录，会匹配所有项目", null]] },
      [root.split("/").at(-1)!]: { sources: ["claude"], paths: [[root, "主目录或其上级目录，会匹配所有项目", null]] },
      "kind-1": { sources: ["claude"], paths: [[worktree, "临时工作副本", null]] },
      src: { sources: ["claude"], paths: [[join(registered, "src"), "已登记", "registered"]] },
    });
    // Codex alone is optional: a readable Claude Code file is enough, and neither being readable is an error.
    assert.equal((await readCodexProjects(join(root, "missing.json"), config, { claudeConfigPath, home })).length, 6);
    await assert.rejects(readCodexProjects(join(root, "missing.json"), config, { claudeConfigPath: join(root, "none.json"), home }), { code: "CODEX_PROJECTS_UNAVAILABLE" });
  } finally { await f.cleanup(); }
});
