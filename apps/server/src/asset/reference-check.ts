import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { AssetType, WorkspaceConfig } from "./schema.js";

const exec = promisify(execFile);
const extensions = /\.(?:ts|tsx|js|mjs|cjs|json|md|vue|java|kt|py|go|rs|sql|yaml|yml|xml|sh|toml|css|html|properties|gradle)$/iu;

export function extractReferencePaths(type: AssetType, markdown: string): string[] {
  const sections = type === "MEMORY" ? ["结论与适用条件", "再次使用时的核验点"]
    : type === "SKILL" ? ["输入与前置条件", "步骤", "验证"] : null;
  let included = type === "DOCUMENT", fence: string | undefined;
  const lines: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    const heading = !fence ? /^##\s+(.+?)\s*#*\s*$/u.exec(line)?.[1] : undefined;
    if (heading) included = sections ? sections.includes(heading) : heading !== "历史依据";
    if (included) lines.push(line);
  }
  const result = new Set<string>();
  // Consume whole tokens before classifying, so a URL or absolute path cannot
  // leak an apparently relative suffix. This is deliberately not link removal.
  for (const token of lines.join("\n").match(/[^\s`"'<>()[\]{}，。；！？、]+/gu) ?? []) {
    const path = token.replace(/[:：]\d+(?::\d+)?$/u, "").replace(/[.,;:!?]+$/u, "");
    if (!extensions.test(path) || /^(?:\/|~|[A-Za-z]:[\\/])/u.test(path) || /[a-z][a-z\d+.-]*:\/\//iu.test(path)) continue;
    if (!/^(?:\.{1,2}\/)*(?:[\p{L}\p{N}_@.+-]+\/)*[\p{L}\p{N}_@+-][\p{L}\p{N}_@.+-]*$/u.test(path)) continue;
    const normalized = posix.normalize(path);
    result.add(normalized);
  }
  return [...result];
}

export class ReferenceChecker {
  readonly files = new Map<string, Promise<string[] | null>>();
  constructor(readonly config: WorkspaceConfig) {}
  async broken(content: { type: AssetType; scope: string; workspace: string | null; bodyMarkdown: string }): Promise<string[]> {
    if (content.scope !== "WORKSPACE") return [];
    const paths = extractReferencePaths(content.type, content.bodyMarkdown);
    if (!paths.length) return [];
    const workspace = this.config.workspaces.find(row => row.name === content.workspace);
    if (!workspace) return [];
    let cached = this.files.get(workspace.name);
    if (!cached) {
      cached = Promise.all(workspace.paths.map(listFiles)).then(lists => lists.some(list => list === null) ? null : lists.flatMap(list => list!));
      this.files.set(workspace.name, cached);
    }
    const files = await cached;
    return files === null ? [] : paths.filter(path => !files.some(file => file.endsWith(path)));
  }
}

async function listFiles(root: string): Promise<string[] | null> {
  try {
    if (!(await stat(root)).isDirectory()) return null;
    let git = false;
    try { git = (await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, timeout: 10_000 })).stdout.trim() === "true"; }
    catch (error) {
      if (!(error instanceof Error) || !("stderr" in error) || !String(error.stderr).includes("not a git repository")) return null;
    }
    if (git) {
      const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      const files: string[] = [];
      for (const path of new Set(stdout.split("\0").filter(Boolean))) {
        try { if ((await stat(join(root, path))).isFile()) files.push(path); }
        catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return null; }
      }
      return files;
    }
    const files: string[] = [], directories = [""];
    while (directories.length) {
      const relative = directories.pop()!;
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile()) { files.push(path); if (files.length > 50_000) return null; }
      }
    }
    return files;
  } catch { return null; } // Missing/inaccessible/incomplete inventories cannot prove a broken reference.
}
