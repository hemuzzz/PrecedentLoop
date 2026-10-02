import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { workspaceConfigSchema, type WorkspaceConfig } from "../asset/schema.js";

export async function loadWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
  try {
    const stats = await lstat(configPath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("workspaces.json must be a regular file and must not be a symlink");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(configPath));
    return workspaceConfigSchema.parse(JSON.parse(source));
  } catch (cause) { throw new WorkspaceConfigError(cause); }
}

// Commit-time qualification must finish while the SQLite write lock is held.
export function loadWorkspaceConfigSync(configPath: string): WorkspaceConfig {
  try {
    const stats = lstatSync(configPath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("workspaces.json must be a regular file and must not be a symlink");
    return workspaceConfigSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(configPath))));
  } catch (cause) { throw new WorkspaceConfigError(cause); }
}

export class WorkspaceConfigError extends Error {
  readonly code = "WORKSPACE_CONFIG_UNAVAILABLE";
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : "Workspace configuration unavailable", { cause }); }
}
