import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { workspaceNameSchema, type WorkspaceConfig } from "../asset/schema.js";

const absolutePath = z.string().refine(value => isAbsolute(value) && !value.includes("\0"));
const savedProjectsSchema = z.object({
  "local-projects": z.record(z.string(), z.object({ name: z.string().trim().min(1).max(128),
    rootPaths: z.array(absolutePath).min(1).max(32) })).refine(value => Object.keys(value).length <= 1000),
});
// Claude Code keeps every directory it has been started in as a key of `projects`.
const claudeProjectsSchema = z.object({ projects: z.record(z.string(), z.unknown()).optional() });
export class CodexProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export type ProjectSource = "codex" | "claude";
export interface SavedCodexProject {
  name: string;
  sources: ProjectSource[];
  paths: Array<{ path: string; exists: boolean; reason?: string; registeredAs?: string }>;
}
export interface ProjectSourceOptions { claudeConfigPath?: string | undefined; home?: string | undefined }

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid project state");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}
const validName = (name: string) => workspaceNameSchema.max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).safeParse(name).success;

/**
 * Filesystem-only parser shared by server initialization and the packaged desktop worker.
 * Without `appendTo` (first-use Hub initialization) only Codex projects are read, as before.
 * With `appendTo` (Setup and Settings) Codex and Claude Code projects are merged by exact name,
 * and unusable directories carry a `reason` instead of being imported.
 */
export async function readCodexProjects(statePath: string, appendTo?: WorkspaceConfig, options: ProjectSourceOptions = {}): Promise<SavedCodexProject[]> {
  if (appendTo) return readAgentProjects(statePath, appendTo, options);
  let saved: z.infer<typeof savedProjectsSchema>;
  try { saved = savedProjectsSchema.parse(await readJson(statePath, 32_000_000)); }
  catch { throw new CodexProjectError("CODEX_PROJECTS_UNAVAILABLE", "无法读取 Codex 保存的本地项目。请先在 Codex 中添加本地项目，或手动配置知识工作区"); }
  const result: SavedCodexProject[] = [], paths = new Set<string>(), names = new Set<string>();
  for (const project of Object.values(saved["local-projects"])) {
    if (!validName(project.name)) throw new CodexProjectError("CODEX_PROJECT_NAME_INVALID", "Codex 项目名称不适合作为知识工作区，请先调整项目名称");
    const roots = await canonicalRoots(project.rootPaths, paths);
    if (!roots.length) continue;
    let name = project.name, suffix = 2;
    // Missing projects do not consume names used by importable projects.
    if (roots.some(root => root.exists)) {
      while (names.has(name)) name = `${project.name.slice(0, 118)} (${suffix++})`;
      names.add(name);
    }
    result.push({ name, sources: ["codex"], paths: roots });
  }
  return result;
}

async function canonicalRoots(rootPaths: string[], seen: Set<string>): Promise<SavedCodexProject["paths"]> {
  const roots: SavedCodexProject["paths"] = [];
  for (const root of rootPaths) {
    try {
      const canonical = await realpath(root);
      if (!(await lstat(canonical)).isDirectory() || seen.has(canonical)) continue;
      seen.add(canonical); roots.push({ path: canonical, exists: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!seen.has(root)) { seen.add(root); roots.push({ path: root, exists: false }); }
    }
  }
  return roots;
}

async function readAgentProjects(statePath: string, appendTo: WorkspaceConfig, options: ProjectSourceOptions): Promise<SavedCodexProject[]> {
  const grouped = new Map<string, { sources: Set<ProjectSource>; roots: string[] }>();
  const add = (name: string, source: ProjectSource, roots: string[]) => {
    const entry = grouped.get(name) ?? { sources: new Set<ProjectSource>(), roots: [] };
    entry.sources.add(source); entry.roots.push(...roots); grouped.set(name, entry);
  };
  let readable = 0;
  try {
    const saved = savedProjectsSchema.parse(await readJson(statePath, 32_000_000));
    readable++;
    for (const project of Object.values(saved["local-projects"])) add(project.name, "codex", project.rootPaths);
  } catch { /* Codex may be absent; Claude Code alone is enough. */ }
  if (options.claudeConfigPath) {
    try {
      const config = claudeProjectsSchema.parse(await readJson(options.claudeConfigPath, 64_000_000));
      readable++;
      const keys = Object.keys(config.projects ?? {}).filter(path => absolutePath.safeParse(path).success).slice(0, 1000);
      for (const path of keys) add(basename(path), "claude", [path]);
    } catch { /* Claude Code may be absent or its file unreadable. */ }
  }
  if (!readable) throw new CodexProjectError("CODEX_PROJECTS_UNAVAILABLE", "无法读取 Codex 或 Claude Code 保存的项目。可以先在其中打开项目后重新读取");

  const home = resolve(options.home ?? homedir());
  const realHome = await realpath(home).catch(() => home);
  const registeredNames = new Set(appendTo.workspaces.map(workspace => workspace.name));
  const registered = await Promise.all(appendTo.workspaces.flatMap(workspace => workspace.paths.map(async path =>
    ({ name: workspace.name, path: await realpath(path).catch(() => resolve(path)) }))));
  const result: SavedCodexProject[] = [], seen = new Set<string>();
  for (const [name, entry] of grouped) {
    const roots = await canonicalRoots(entry.roots, seen);
    if (!roots.length) continue;
    const nameReason = registeredNames.has(name) ? "已登记"
      : !validName(name) ? name.toLowerCase() === "global" ? "global 是保留名称，无法登记" : "项目名称不适合作为工作区名称" : null;
    for (const root of roots) {
      const owner = registered.find(value => within(value.path, root.path));
      if (!root.exists) root.reason = "目录不存在";
      else if (within(root.path, realHome) || within(root.path, home)) root.reason = "主目录或其上级目录，会匹配所有项目";
      else if (/\/\.(claude|codex)\/worktrees\//u.test(`${root.path}/`)) root.reason = "临时工作副本";
      else if (owner) { root.reason = "已登记"; root.registeredAs = owner.name; }
      else if (nameReason) { root.reason = nameReason; if (nameReason === "已登记") root.registeredAs = name; }
    }
    result.push({ name, sources: [...entry.sources].sort(), paths: roots });
  }
  return result;
}
