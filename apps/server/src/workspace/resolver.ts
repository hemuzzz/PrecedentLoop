import { isAbsolute, posix, win32, type PlatformPath } from "node:path";

import { loadWorkspaceConfig, type WorkspaceConfig } from "../asset/index.js";

export class WorkspaceResolutionError extends Error {
  constructor(
    readonly code: "WORKSPACE_CONFIG_INVALID" | "WORKSPACE_CWD_INVALID" | "WORKSPACE_MATCH_AMBIGUOUS",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceResolutionError";
  }
}

interface WorkspaceMatch {
  name: string;
  pathLength: number;
  root: string;
}

export async function resolveTrustedWorkspace(cwd: string, workspaceConfigPath: string): Promise<string | null> {
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new WorkspaceResolutionError("WORKSPACE_CWD_INVALID", `Hook cwd must be an absolute path: ${cwd}`);
  }

  let config: WorkspaceConfig;
  try {
    config = await loadWorkspaceConfig(workspaceConfigPath);
  } catch (error) {
    throw new WorkspaceResolutionError(
      "WORKSPACE_CONFIG_INVALID",
      `Unable to load valid workspace configuration ${workspaceConfigPath}: ${errorMessage(error)}`,
    );
  }

  return resolveWorkspaceFromConfig(cwd, config);
}

export function resolveWorkspaceFromConfig(cwd: string, config: WorkspaceConfig): string | null {
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) throw new WorkspaceResolutionError("WORKSPACE_CWD_INVALID", "Absolute host directory required");
  const matches: WorkspaceMatch[] = [];
  for (const workspace of config.workspaces) {
    for (const configuredPath of workspace.paths) {
      const pathApi = pathImplementation(configuredPath, cwd);
      if (pathApi === null) {
        continue;
      }
      const root = pathApi.resolve(configuredPath);
      const current = pathApi.resolve(cwd);
      if (isWithinPathBoundary(pathApi, root, current)) {
        matches.push({ name: workspace.name, pathLength: root.length, root });
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  const longestLength = Math.max(...matches.map(({ pathLength }) => pathLength));
  const longestMatches = matches.filter(({ pathLength }) => pathLength === longestLength);
  const names = [...new Set(longestMatches.map(({ name }) => name))];
  if (names.length > 1) {
    const roots = [...new Set(longestMatches.map(({ root }) => root))];
    throw new WorkspaceResolutionError(
      "WORKSPACE_MATCH_AMBIGUOUS",
      `cwd ${cwd} matches equally specific workspace paths ${roots.join(", ")} for ${names.join(", ")}`,
    );
  }

  return names[0] ?? null;
}

function pathImplementation(configuredPath: string, cwd: string): PlatformPath | null {
  const configuredIsWindows = win32.isAbsolute(configuredPath) && !posix.isAbsolute(configuredPath);
  const cwdIsWindows = win32.isAbsolute(cwd) && !posix.isAbsolute(cwd);
  if (configuredIsWindows !== cwdIsWindows) {
    return null;
  }
  return configuredIsWindows ? win32 : posix;
}

function isWithinPathBoundary(pathApi: PlatformPath, root: string, candidate: string): boolean {
  const relativePath = pathApi.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relativePath))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
