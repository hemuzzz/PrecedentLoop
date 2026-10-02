import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RepositoryOperationError } from "../asset/errors.js";
import { writeWorkspaceConfiguration } from "../storage/workspace-write.js";
import { workspaceConfigSchema, type WorkspaceConfig } from "../asset/schema.js";
import { loadWorkspaceConfig } from "./config.js";
import { CodexProjectError, readCodexProjects } from "./codex-project-parser.js";

export function codexProjectStatePath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), ".codex-global-state.json");
}

/** First-use Hub initialization (no selection) keeps the empty-only, Codex-only behavior.
 * Setup and Settings append selected paths; the selection is re-validated against a fresh
 * project list, so volatile source files (e.g. ~/.claude.json) are not compared byte for byte. */
export async function initializeCodexWorkspaces(options: { databasePath: string; workspaceConfigPath: string }, statePath = codexProjectStatePath(), selection?: { paths: string[]; expectedConfig: string | null; append?: boolean | undefined; claudeConfigPath?: string | undefined; home?: string | undefined }): Promise<WorkspaceConfig> {
  return writeWorkspaceConfiguration(options.databasePath, async () => {
    let before: Buffer | null = null;
    let existing: WorkspaceConfig = { schemaVersion: 1, workspaces: [] };
    try {
      const config = await loadWorkspaceConfig(options.workspaceConfigPath);
      if (config.workspaces.length && !selection?.append) {
        if (selection) throw new RepositoryOperationError("WORKSPACE_CONFIG_CHANGED", "已有工作区，本次未导入");
        return config;
      }
      before = await readFile(options.workspaceConfigPath);
      // The bytes used for the replacement check must still describe an empty config.
      const raw: unknown = JSON.parse(before.toString("utf8"));
      const parsed = workspaceConfigSchema.parse(raw);
      if (parsed.workspaces.length && !selection?.append) throw new RepositoryOperationError("WORKSPACE_CONFIG_CHANGED", "工作区配置已变化，请重新打开导入窗口");
      // Validate without replacing the original entries with Zod's trimmed values.
      existing = raw as WorkspaceConfig;
    } catch (error) { if (!isMissing(error)) throw error; }

    let projects;
    try { projects = await readCodexProjects(statePath, selection?.append ? existing : undefined, { claudeConfigPath: selection?.claudeConfigPath, home: selection?.home }); }
    catch (error) { if (error instanceof CodexProjectError) throw new RepositoryOperationError(error.code, error.message); throw error; }
    if (selection && before?.toString("utf8") !== (selection.expectedConfig ?? undefined)) {
      throw new RepositoryOperationError("WORKSPACE_CONFIG_CHANGED", "外部配置已变化，请重新预览");
    }
    const available = new Set(projects.flatMap(project => project.paths.filter(root => root.exists && !root.reason).map(root => root.path)));
    if (selection?.paths.some(path => !available.has(path))) throw new RepositoryOperationError("WORKSPACE_CONFIG_CHANGED", "所选项目目录已变化，请重新预览");
    const workspaces: WorkspaceConfig["workspaces"] = projects.flatMap(project => {
      const paths = project.paths.filter(root => root.exists && !root.reason && (!selection || selection.paths.includes(root.path))).map(root => root.path);
      return paths.length ? [{ name: project.name, paths }] : [];
    });
    if (!workspaces.length) throw new RepositoryOperationError("CODEX_PROJECTS_EMPTY", "Codex 中没有可用的本地项目。请先添加项目，或明确选择全局范围后整理");
    const config: WorkspaceConfig = { schemaVersion: 1, workspaces: [...existing.workspaces, ...workspaces] };
    workspaceConfigSchema.parse(config);
    const target = options.workspaceConfigPath, parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const stage = join(parent, `.workspaces-${randomUUID()}.staging`);
    try {
      const handle = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      if (before === null) await link(stage, target);
      else {
        const stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(target)).equals(before)) throw new RepositoryOperationError("WORKSPACE_CONFIG_CHANGED", "工作区配置已变化，本次未覆盖，请重新打开导入窗口");
        await rename(stage, target);
      }
      const directory = await open(resolve(parent), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(stage).catch(error => { if (!isMissing(error)) throw error; }); }
    return config;
  });
}
function isMissing(error: unknown): boolean { return error instanceof Error && (("code" in error && error.code === "ENOENT") || isMissing(error.cause)); }
