import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readCodexProjects } from "./codex-project-parser.js";
import { loadWorkspaceConfig } from "./config.js";

const path = z.string().refine(value => isAbsolute(value) && !value.includes("\0"));
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), statePath: path, workspaceConfigPath: path.optional(), claudeConfigPath: path.optional(), home: path.optional() }).strict(),
  z.object({ action: z.literal("import"), statePath: path, databasePath: path, workspaceConfigPath: path,
    paths: z.array(path).min(1), expectedConfig: z.string().nullable(), append: z.boolean().optional(), claudeConfigPath: path.optional(), home: path.optional() }).strict(),
]);
export async function runSetupImport(input: unknown): Promise<unknown> {
  const request = requestSchema.parse(input);
  if (request.action === "list") return readCodexProjects(request.statePath, request.workspaceConfigPath ? await loadWorkspaceConfig(request.workspaceConfigPath) : undefined,
    { claudeConfigPath: request.claudeConfigPath, home: request.home });
  // SQLite is loaded only inside bundled Node, never the Electron main process.
  const { initializeCodexWorkspaces } = await import("./codex-projects.js");
  const config = await initializeCodexWorkspaces(request, request.statePath, request);
  return request.append ? { ...config, workspaces: config.workspaces.filter(workspace => workspace.paths.some(path => request.paths.includes(path))) } : config;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
      if (size > 40_000_000) throw new Error("请求过大");
      chunks.push(bytes);
    }
    process.stdout.write(JSON.stringify({ ok: true, value: await runSetupImport(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "工作区导入失败" }));
    process.exitCode = 1;
  }
}
