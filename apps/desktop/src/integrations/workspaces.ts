import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { bundledNodePath, nodeEnvironment, dataPaths } from "../config.js";
import { setupPathSchema } from "../setup-state.js";
import type { IntegrationConfiguration } from "./engine.js";
import type { IntegrationEnvironment } from "./environment.js";
import { workspacePlanSchema, type CodexProject, type RegisteredWorkspace, type WorkspaceImportPlan, type WorkspaceImportPreview, type WorkspaceImportResult } from "./contract.js";
import { hash, json, message, parseObject, readText } from "./files.js";

export type WorkspaceWorker = (request: Record<string, unknown>) => Promise<unknown>;
export function bundledWorkspaceWorker(runtime: string, env: IntegrationEnvironment): WorkspaceWorker {
  return request => new Promise((resolve, reject) => {
    const child = spawn(bundledNodePath(runtime), [join(runtime, "apps/server/dist/workspace/setup-import-cli.js")], {
      env: { ...nodeEnvironment(), HOME: env.home, CODEX_HOME: env.codexHome, CLAUDE_CONFIG_DIR: env.claudeDirectory },
      cwd: env.home, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", bytes = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8_000_000) { failed = true; child.kill("SIGKILL"); } else output += chunk.toString("utf8"); });
    child.stderr.resume();
    child.stdin.on("error", () => { /* Process result determines success. */ });
    child.on("error", () => { clearTimeout(timer); reject(new Error("无法启动包内工作区导入进程。")); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        if (failed) throw new Error("工作区导入超时或输出过大。");
        const result = parseObject(output, "工作区导入进程输出");
        if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "工作区导入失败。");
        resolve(result.value);
      } catch (error) { reject(error); }
    });
    child.stdin.end(json(request));
  });
}
const projectsSchema = z.array(z.object({ name: z.string(), sources: z.array(z.enum(["codex", "claude"])),
  paths: z.array(z.object({ path: setupPathSchema, exists: z.boolean(), reason: z.string().optional(), registeredAs: z.string().optional() }).strict()) }).strict());
const configSchema = z.object({ schemaVersion: z.literal(1), workspaces: z.array(z.object({ name: z.string(), paths: z.array(z.string()),
  aliases: z.array(z.string()).optional() }).passthrough()) }).strict();
interface Snapshot { config: string | null; target: string; statePath: string; dataDirectory: string; fingerprint: string }
interface ProjectList { snapshot: Snapshot; projects: CodexProject[] }
/**
 * Setup and Settings both append: registered workspaces keep every value and only selected new
 * projects (Codex and Claude Code, merged by exact name) are added, as name and paths only.
 * Plans are bound to workspaces.json bytes and to the parsed project list, not to the raw
 * source files, which Claude Code rewrites during normal use.
 */
export class WorkspaceImporter {
  private readonly lists = new Map<string, ProjectList>();
  private readonly plans = new Map<string, { snapshot: Snapshot; paths: string[]; projects: unknown }>();
  constructor(readonly env: IntegrationEnvironment, readonly configuration: () => Promise<IntegrationConfiguration>, readonly worker: WorkspaceWorker) {}
  private sources() { return { claudeConfigPath: this.env.claudeConfig, home: this.env.home }; }
  private listRequest(snapshot: Snapshot) { return { action: "list", statePath: snapshot.statePath, workspaceConfigPath: snapshot.target, ...this.sources() }; }
  private async snapshot(): Promise<Snapshot> {
    const { dataDirectory } = await this.configuration();
    const target = dataPaths(dataDirectory).workspaceConfigPath, statePath = join(this.env.codexHome, ".codex-global-state.json");
    const config = await readText(target);
    return { config, target, statePath, dataDirectory, fingerprint: hash(json({ config, target, statePath, dataDirectory })) };
  }
  private registered(config: string | null, projects: CodexProject[]): RegisteredWorkspace[] {
    if (config === null) return [];
    const parsed = configSchema.safeParse(parseObject(config, "workspaces.json"));
    if (!parsed.success) throw new Error("工作区配置格式无效，已保留原文件。");
    return parsed.data.workspaces.map(workspace => ({ name: workspace.name, paths: workspace.paths, aliases: workspace.aliases ?? [],
      sources: [...new Set(projects.filter(project => project.paths.some(path => path.registeredAs === workspace.name)).flatMap(project => project.sources))].sort() }));
  }
  async list(): Promise<WorkspaceImportPreview> {
    const snapshot = await this.snapshot();
    let registered = this.registered(snapshot.config, []);
    try {
      const projects = projectsSchema.parse(await this.worker(this.listRequest(snapshot))).map(project => ({ ...project, paths: project.paths.map(path => ({ ...path, candidateId: randomUUID() })) }));
      if ((await this.snapshot()).fingerprint !== snapshot.fingerprint) throw new Error("外部配置已变化，请重新读取");
      registered = this.registered(snapshot.config, projects);
      const planId = randomUUID();
      if (this.lists.size >= 16) this.lists.delete(this.lists.keys().next().value!);
      this.lists.set(planId, { snapshot, projects: structuredClone(projects) });
      return { planId, fingerprint: snapshot.fingerprint, existingCount: registered.length, registered, projects, reason: null };
    } catch (error) { return { planId: null, fingerprint: snapshot.fingerprint, existingCount: registered.length, registered, projects: [], reason: message(error) }; }
  }
  async plan(raw: z.input<typeof workspacePlanSchema>): Promise<WorkspaceImportPlan> {
    const input = workspacePlanSchema.parse(raw), list = this.lists.get(input.listId);
    if (!list || (await this.snapshot()).fingerprint !== list.snapshot.fingerprint) throw new Error("外部配置已变化，请重新读取");
    const available = list.projects.flatMap(project => project.paths).filter(path => path.exists && !path.reason);
    const paths = input.candidateIds.map(id => {
      const candidate = available.find(value => value.candidateId === id);
      if (!candidate) throw new Error("所选项目不是本次列出的可用目录。");
      return candidate.path;
    });
    const current = projectsSchema.parse(await this.worker(this.listRequest(list.snapshot)));
    const previous = list.projects.map(project => ({ ...project, paths: project.paths.map(({ candidateId: _id, ...path }) => path) }));
    if (json(current) !== json(previous)) throw new Error("项目列表已变化，请重新读取");
    const workspaces = current.flatMap(project => {
      const selected = project.paths.filter(path => path.exists && paths.includes(path.path)).map(path => path.path);
      return selected.length ? [{ name: project.name, paths: selected }] : [];
    });
    const planId = randomUUID();
    if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(planId, { snapshot: list.snapshot, paths, projects: current });
    return { planId, fingerprint: list.snapshot.fingerprint, paths, target: list.snapshot.target, diff: json({ workspaces }) };
  }
  async apply(planId: string): Promise<WorkspaceImportResult> {
    const plan = this.plans.get(planId); this.plans.delete(planId);
    if (!plan) throw new Error("导入计划不存在或已失效，请重新读取。");
    const current = await this.snapshot();
    if (current.fingerprint !== plan.snapshot.fingerprint) throw new Error("外部配置已变化，请重新读取");
    if (json(await this.worker(this.listRequest(current))) !== json(plan.projects)) throw new Error("项目列表已变化，请重新读取");
    const result = z.object({ workspaces: z.array(z.object({ paths: z.array(z.string()) }).passthrough()) }).parse(await this.worker({
      action: "import", statePath: current.statePath, repositoryPath: join(current.dataDirectory, "repository"), workspaceConfigPath: current.target,
      paths: plan.paths, expectedConfig: current.config, append: true, ...this.sources(),
    }));
    return { imported: result.workspaces.length, paths: result.workspaces.flatMap(workspace => workspace.paths) };
  }
}
