import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { cleanEnvironment } from "./config.js";
import type { AgentDetection, AgentName } from "./setup-contract.js";

export function agentSearchDirectories(path = process.env.PATH ?? "", home = homedir()): string[] {
  return [...new Set([...path.split(":"), "/opt/homebrew/bin", "/usr/local/bin", ...[".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin"].map(part => join(home, part))].filter(isAbsolute))];
}
async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}
export function parseAgentVersion(output: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?)\b/u.exec(output)?.[1];
}
export function parseAgentLogin(agent: AgentName, output: string, exitCode: number | null): AgentDetection["login"] {
  if (agent === "codex") {
    if (exitCode !== 0 || output.includes("Not logged in")) return "logged-out";
    return output.trimStart().startsWith("Logged in") ? "logged-in" : "unverified";
  }
  try {
    const parsed: unknown = JSON.parse(output);
    if (exitCode === 0 && typeof parsed === "object" && parsed !== null && "loggedIn" in parsed && typeof parsed.loggedIn === "boolean") {
      return parsed.loggedIn ? "logged-in" : "logged-out";
    }
  } catch { /* CLI versions may not support JSON status. Never return their raw output. */ }
  return "unverified";
}
export function localCommand(bin: string, args: string[], home: string): Promise<{ output: string; code: number | null }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, cwd: home,
      env: { ...cleanEnvironment(), HOME: home, PATH: `${dirname(bin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } },
    (error, stdout, stderr) => {
      // Error.message contains command output on some platforms. Never persist or surface it.
      resolve({ output: `${stdout}${stderr}`, code: error ? typeof error.code === "number" ? error.code : null : 0 });
    });
  });
}
export async function detectAgent(agent: AgentName, manualPath: string | null, options: { home?: string; directories?: string[] } = {}): Promise<AgentDetection> {
  const home = options.home ?? homedir();
  let path: string | undefined = manualPath ?? undefined;
  if (!path) {
    for (const directory of options.directories ?? agentSearchDirectories(undefined, home)) {
      const candidate = join(directory, agent);
      if (await executable(candidate)) { path = candidate; break; }
    }
  }
  const base: AgentDetection = { agent, source: manualPath ? "manual" : "auto", found: false, runnable: false,
    login: "unverified", checkedAt: new Date().toISOString(), ...(path ? { path } : {}) };
  if (!path) return base;
  try { base.found = (await stat(path)).isFile(); } catch { /* Missing manual path stays visible. */ }
  if (!await executable(path)) return { ...base, reason: "路径无法运行：文件不存在或没有执行权限。知识接入仍可配置，AI 整理暂不可用。" };
  const versionResult = await localCommand(path, ["--version"], home);
  const version = parseAgentVersion(versionResult.output);
  if (versionResult.code !== 0) return { ...base, reason: "命令行工具无法运行或检测超时，AI 整理暂不可用。" };
  const status = await localCommand(path, agent === "codex" ? ["login", "status"] : ["auth", "status", "--json"], home);
  return { ...base, runnable: true, ...(version ? { version } : {}), login: parseAgentLogin(agent, status.output, status.code) };
}
