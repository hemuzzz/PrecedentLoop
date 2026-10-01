import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceImporter } from "../src/integrations/workspaces.js";
import { runSetupImport } from "../../server/src/workspace/setup-import-cli.js";
import { integrationFixture } from "./integration-fixture.js";

async function sources(f: Awaited<ReturnType<typeof integrationFixture>>, codex: Record<string, { name: string; rootPaths: string[] }>, claude: string[] = []) {
  await writeFile(join(f.env.codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": codex }));
  await writeFile(f.env.claudeConfig, JSON.stringify({ projects: Object.fromEntries(claude.map(path => [path, { allowedTools: [] }])), numStartups: 1 }));
}

test("import lists Codex and Claude Code projects merged by name, adds only chosen ones and reports sources", async () => {
  const f = await integrationFixture();
  try {
    const shared = join(f.root, "shared"), notes = join(f.root, "notes"), stale = join(f.root, "missing");
    await mkdir(shared); await mkdir(notes);
    await sources(f, { a: { name: "shared", rootPaths: [shared] }, b: { name: "stale", rootPaths: [stale] } }, [shared, notes]);
    const importer = new WorkspaceImporter(f.env, async () => f.config, runSetupImport);
    const list = await importer.list();
    assert.ok(list.planId); assert.deepEqual(list.registered, []);
    assert.deepEqual(list.projects.map(project => [project.name, project.sources, project.paths.map(path => path.reason ?? null)]),
      [["shared", ["claude", "codex"], [null]], ["stale", ["codex"], ["目录不存在"]], ["notes", ["claude"], [null]]]);
    await assert.rejects(importer.plan({ listId: list.planId, candidateIds: [list.projects[1]!.paths[0]!.candidateId] }), /可用目录/);
    const plan = await importer.plan({ listId: list.planId, candidateIds: [list.projects[0]!.paths[0]!.candidateId] });
    // New entries are name and paths only: there is no per-workspace access level any more.
    assert.deepEqual(JSON.parse(plan.diff), { workspaces: [{ name: "shared", paths: [shared] }] });
    assert.deepEqual(await importer.apply(plan.planId), { imported: 1, paths: [shared] });
    const configPath = join(f.config.dataDirectory, "config/workspaces.json");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { schemaVersion: 1, workspaces: [{ name: "shared", paths: [shared] }] });
    // The next list shows the new workspace as registered, with both sources, and still offers the rest.
    const next = await importer.list();
    assert.deepEqual(next.registered, [{ name: "shared", paths: [shared], aliases: [], sources: ["claude", "codex"] }]);
    assert.equal(next.projects.find(project => project.name === "shared")!.paths[0]!.reason, "已登记");
    assert.equal(next.projects.find(project => project.name === "notes")!.paths[0]!.reason, undefined);
    await assert.rejects(importer.apply(plan.planId), /失效/);
  } finally { await f.cleanup(); }
});

test("existing entries keep every value; registered paths, names, home, worktrees and reserved names are excluded with reasons", async () => {
  const f = await integrationFixture();
  try {
    const old = join(f.root, "existing"), child = join(old, "nested"), next = join(f.root, "new"), sameName = join(f.root, "elsewhere"), global = join(f.root, "global");
    const worktree = join(next, ".claude/worktrees/tmp-1");
    for (const path of [old, child, next, sameName, global, worktree]) await mkdir(path, { recursive: true });
    const original = { name: "registered", paths: [old], aliases: ["  Original alias  "], description: "  Keep exact whitespace  ", knowledgeAccess: "PREAUTHORIZED" };
    const target = join(f.config.dataDirectory, "config/workspaces.json"), text = JSON.stringify({ schemaVersion: 1, workspaces: [original] });
    await writeFile(target, text);
    await sources(f, { child: { name: "child", rootPaths: [child] }, next: { name: "new", rootPaths: [next] }, same: { name: "registered", rootPaths: [sameName] }, global: { name: "global", rootPaths: [global] } },
      [f.env.home, worktree, old]);
    const importer = new WorkspaceImporter(f.env, async () => f.config, runSetupImport), list = await importer.list();
    assert.deepEqual(list.registered, [{ name: "registered", paths: [old], aliases: ["  Original alias  "], sources: ["claude", "codex"] }]);
    const reasons = Object.fromEntries(list.projects.map(project => [project.name, project.paths[0]!.reason ?? null]));
    assert.deepEqual(reasons, { child: "已登记", new: null, registered: "已登记", global: "global 是保留名称，无法登记",
      [f.env.home.split("/").at(-1)!]: "主目录或其上级目录，会匹配所有项目", "tmp-1": "临时工作副本", existing: "已登记" });
    const selected = list.projects.find(project => project.name === "new")!.paths[0]!;
    const plan = await importer.plan({ listId: list.planId!, candidateIds: [selected.candidateId] });
    assert.doesNotMatch(plan.diff, /knowledgeAccess|Original alias/);
    assert.equal((await importer.apply(plan.planId)).imported, 1);
    const saved = await readFile(target, "utf8");
    assert.ok(saved.includes('"  Original alias  "') && saved.includes('"  Keep exact whitespace  "'));
    // A legacy knowledgeAccess value in an existing entry is kept as-is (ignored by the runtime).
    assert.deepEqual(JSON.parse(saved), { schemaVersion: 1, workspaces: [original, { name: "new", paths: [next] }] });
  } finally { await f.cleanup(); }
});

test("plans reject config, project-list and directory changes, but not unrelated rewrites of the Claude Code file", async () => {
  for (const change of ["config", "project-list", "directory", "claude-noise"] as const) {
    const f = await integrationFixture();
    try {
      const next = join(f.root, "next"), other = join(f.root, "other"); await mkdir(next); await mkdir(other);
      const target = join(f.config.dataDirectory, "config/workspaces.json");
      await writeFile(target, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "existing", paths: [join(f.root, "old")], knowledgeAccess: "PREAUTHORIZED" }] }));
      await sources(f, { next: { name: "next", rootPaths: [next] } });
      const importer = new WorkspaceImporter(f.env, async () => f.config, runSetupImport), list = await importer.list();
      const plan = await importer.plan({ listId: list.planId!, candidateIds: [list.projects[0]!.paths[0]!.candidateId] });
      if (change === "config") await writeFile(target, (await readFile(target, "utf8")) + "\n");
      if (change === "project-list") await sources(f, { next: { name: "next", rootPaths: [next] } }, [other]);
      if (change === "directory") await rm(next, { recursive: true });
      if (change === "claude-noise") await writeFile(f.env.claudeConfig, JSON.stringify({ projects: {}, numStartups: 99, tips: "changed" }));
      const before = await readFile(target);
      if (change === "claude-noise") { assert.equal((await importer.apply(plan.planId)).imported, 1); continue; }
      await assert.rejects(importer.apply(plan.planId), /变化/); assert.deepEqual(await readFile(target), before);
      await assert.rejects(importer.apply(plan.planId), /失效/);
    } finally { await f.cleanup(); }
  }
});

test("unreadable sources are reported as a reason while registered workspaces are still listed", async () => {
  const f = await integrationFixture();
  try {
    const target = join(f.config.dataDirectory, "config/workspaces.json"), state = join(f.env.codexHome, ".codex-global-state.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "kept", paths: [join(f.root, "kept")] }] }));
    await mkdir(f.env.codexHome, { recursive: true }); await symlink(target, state);
    const list = await new WorkspaceImporter(f.env, async () => f.config, runSetupImport).list();
    assert.equal(list.planId, null); assert.match(list.reason ?? "", /无法读取 Codex 或 Claude Code/);
    assert.deepEqual(list.registered.map(value => value.name), ["kept"]);
  } finally { await f.cleanup(); }
});
