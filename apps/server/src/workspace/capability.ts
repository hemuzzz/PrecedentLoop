import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { generateWorkspaceCapability } from "@precedent-loop/id-generator";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../asset/index.js";
import { KnowledgeError, capabilityIdsSchema } from "../knowledge/model.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import { resolveWorkspaceFromConfig } from "./resolver.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Bounds the Hook context (about 100 characters per workspace). */
export const WORKSPACE_CAPABILITY_LIMIT = 24;
export interface HostWorkspaceCapability {
  capabilityId: string;
  workspace: string;
  aliases: string[];
  description?: string;
}
const canonicalPath = (path: string) => {
  const api = win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
  const normalized = api.resolve(path);
  return api === win32 ? normalized.toLowerCase() : normalized;
};
export class WorkspaceCapabilityService {
  constructor(readonly repository: KnowledgeRepository, readonly configPath: string) {}
  async config(): Promise<WorkspaceConfig> {
    try {
      const config = await loadWorkspaceConfig(this.configPath);
      if (config.workspaces.length > 1000 || config.workspaces.some((w) => w.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(w.name))) throw new Error("Configuration limits exceeded");
      const owners = new Map<string, string>();
      for (const workspace of config.workspaces) {
        for (const path of workspace.paths) {
          const key = canonicalPath(path);
          if (owners.has(key) && owners.get(key) !== workspace.name) throw new Error("Ambiguous mapping");
          owners.set(key, workspace.name);
        }
      }
      return config;
    } catch { throw new KnowledgeError("WORKSPACE_CONFIG_UNAVAILABLE"); }
  }
  /** Grants are bound to the workspace name and its paths: renaming, moving or removing a
   * workspace invalidates them. `legacyPreauthorized` recognises grants issued before
   * 2026-09-25, when cross-project grants carried an explicit PREAUTHORIZED policy. */
  mappingHash(config: WorkspaceConfig, name: string, legacyPreauthorized = false): string | undefined {
    const workspace = config.workspaces.find((item) => item.name === name);
    if (!workspace) return undefined;
    const mapping = { name, paths: [...new Set(workspace.paths.map(canonicalPath))].sort() };
    return digest(JSON.stringify(legacyPreauthorized ? { ...mapping, knowledgeAccess: "PREAUTHORIZED" } : mapping));
  }
  async select(input: unknown): Promise<{ authorizedWorkspaces: string[]; config: WorkspaceConfig }> {
    const parsed = capabilityIdsSchema.safeParse(input);
    if (!parsed.success) throw new KnowledgeError("INPUT_INVALID");
    const config = await this.config();
    const selected = new Set<string>();
    for (const id of [...new Set(parsed.data)].sort()) {
      const row = this.repository.capability(digest(id));
      if (!row || (row.hash !== this.mappingHash(config, row.workspace)
        && row.hash !== this.mappingHash(config, row.workspace, true))) throw new KnowledgeError("CAPABILITY_INVALID");
      selected.add(row.workspace);
    }
    return { authorizedWorkspaces: [...selected].sort(), config };
  }
  /** Trusted host adapter only. Never register this method as an MCP/REST tool. */
  async issueFromTrustedHost(cwd: string): Promise<HostWorkspaceCapability[]> {
    return (await this.issueWithSummary(cwd)).capabilities;
  }
  /**
   * Every registered workspace is available across projects (user decision 2026-09-25): the
   * model still selects capabilities per request. The project containing `cwd` comes first;
   * beyond the context bound the remaining workspaces (by name) are omitted and reported.
   */
  async issueWithSummary(cwd: string): Promise<{ capabilities: HostWorkspaceCapability[]; omitted: number }> {
    const config = await this.config();
    const current = resolveWorkspaceFromConfig(cwd, config);
    const ordered = [...config.workspaces].sort((a, b) => a.name === current ? -1 : b.name === current ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const workspaces = ordered.slice(0, WORKSPACE_CAPABILITY_LIMIT);
    const capabilities = workspaces.map((workspace): HostWorkspaceCapability => ({
      capabilityId: generateWorkspaceCapability(), workspace: workspace.name,
      aliases: [...new Set(workspace.aliases ?? [])],
      ...(workspace.description ? { description: workspace.description } : {}),
    }));
    this.repository.issueCapabilities(capabilities.map(capability => ({
      digest: digest(capability.capabilityId), workspace: capability.workspace, hash: this.mappingHash(config, capability.workspace)!,
    })));
    return { capabilities, omitted: ordered.length - workspaces.length };
  }
}
