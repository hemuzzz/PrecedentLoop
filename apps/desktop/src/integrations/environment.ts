import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { cleanEnvironment } from "../config.js";
import type { AgentName } from "../setup-contract.js";

export interface CommandInput { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeout: number }
export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type CommandRunner = (input: CommandInput) => Promise<CommandResult>;
export const executeMcpCommand: CommandRunner = input => new Promise(resolve => {
  const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0, stopped = false;
  const kill = (): void => {
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
  };
  const timer = setTimeout(() => { stopped = true; kill(); }, input.timeout);
  const collect = (chunk: string, error: boolean): void => {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) { stopped = true; kill(); return; }
    if (error) stderr += chunk; else stdout += chunk;
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => collect(chunk, false));
  child.stderr.on("data", (chunk: string) => collect(chunk, true));
  child.once("error", () => { clearTimeout(timer); kill(); resolve({ code: null, stdout, stderr }); });
  child.once("close", code => { clearTimeout(timer); kill(); resolve({ code: stopped ? null : code, stdout, stderr }); });
});
export interface IntegrationEnvironment {
  home: string;
  codexHome: string;
  claudeDirectory: string;
  claudeConfig: string;
  managedSettings: string;
  userData: string;
  appPath: string;
  resources: string;
  executables: Record<AgentName, string | null>;
  run: CommandRunner;
  now: () => Date;
  /** Only populate with clientInfo names established by an actual initialize observation. */
  mcpClientNames: Record<AgentName, string[]>;
}
/** The only production-default boundary. Tests construct the complete environment explicitly. */
export function integrationEnvironment(input: { userData: string; appPath: string; resources: string }): IntegrationEnvironment {
  const home = homedir();
  return { ...input, home, codexHome: process.env.CODEX_HOME || join(home, ".codex"),
    claudeDirectory: join(home, ".claude"), claudeConfig: join(home, ".claude.json"),
    managedSettings: "/Library/Application Support/ClaudeCode/managed-settings.json",
    executables: { codex: null, claude: null }, run: executeMcpCommand, now: () => new Date(),
    // Observed in real use (2026-09-25): Codex reports clientInfo.name "codex-mcp-client",
    // Claude Code reports "claude-code". Add names only after observing them, never guessed.
    mcpClientNames: { codex: ["codex-mcp-client"], claude: ["claude-code"] } };
}
export async function runMcp(env: IntegrationEnvironment, agent: AgentName, args: string[]): Promise<CommandResult> {
  const allowed = agent === "codex"
    ? (args.length === 4 && args.join(" ") === "mcp get precedent --json") ||
      (args.length === 3 && args.join(" ") === "mcp remove precedent") ||
      (args.length === 5 && args.slice(0, 4).join(" ") === "mcp add precedent --url" && localUrl(args[4]!))
    : (args.length === 5 && args.join(" ") === "mcp remove --scope user precedent") ||
      (args.length === 8 && args.slice(0, 7).join(" ") === "mcp add --transport http --scope user precedent" && localUrl(args[7]!));
  if (!allowed) throw new Error("不允许的 MCP 命令。");
  const executable = env.executables[agent];
  if (!executable || !isAbsolute(executable)) throw new Error(`${agent} CLI 路径不可用，请先检测或指定路径。`);
  const child: NodeJS.ProcessEnv = { ...cleanEnvironment(), HOME: env.home, CODEX_HOME: env.codexHome,
    CLAUDE_CONFIG_DIR: env.claudeDirectory, PATH: `${dirname(executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` };
  // Claude derives its user-level JSON from HOME when CLAUDE_CONFIG_DIR is the default.
  // Custom file locations are supported by injected runners; production follows the CLI's layout.
  if (env.claudeDirectory === join(env.home, ".claude")) delete child.CLAUDE_CONFIG_DIR;
  return env.run({ executable, args, cwd: env.home, env: child, timeout: 30_000 });
}
function localUrl(url: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/mcp$/u.exec(url);
  return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= 65535;
}
