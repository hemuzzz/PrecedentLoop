import { constants } from "node:fs";
import { access, readFile, writeFile, lstat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { RepositoryOperationError } from "../asset/coordination.js";

export const providerSchema = z.object({
  id: z.enum(["codex", "claude"]), executable: z.string().refine(isAbsolute),
  model: z.string().trim().min(1).max(256).optional(), profile: z.string().trim().min(1).max(256).optional(),
  // Reasoning level passed as-is to the CLI (Codex model_reasoning_effort, Claude --effort); levels vary by model.
  effort: z.string().regex(/^[a-z]{1,16}$/u).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
}).strict();
export type AiProvider = z.infer<typeof providerSchema>;
export type ResolvedAiProvider = Omit<AiProvider, "executable"> & { executable: string | null };
export const aiOverridesSchema = z.object({
  defaultProvider: providerSchema.shape.id.optional(),
  providers: z.object({
    codex: providerSchema.pick({ model: true, profile: true, effort: true, timeoutMs: true }).partial().strict().optional(),
    claude: providerSchema.pick({ model: true, effort: true, timeoutMs: true }).partial().strict().optional(),
  }).strict().optional(),
}).strict();
export type AiOverrides = z.infer<typeof aiOverridesSchema>;
export interface AiConfiguration { defaults: AiProvider[]; providers: ResolvedAiProvider[]; overrides: AiOverrides; defaultProvider: AiProvider["id"] }
export async function readAiConfiguration(path: string, appConfigPath?: string): Promise<AiConfiguration> {
  const defaults = await readProviders(path);
  try {
    const paths = z.partialRecord(providerSchema.shape.id, providerSchema.shape.executable.max(4096).refine(value => !value.includes("\0")));
    const config = appConfigPath ? z.object({ ai: aiOverridesSchema.optional(), manualPaths: paths.optional(), detectedPaths: paths.optional() })
      .parse(JSON.parse(await readFile(appConfigPath, "utf8"))) : null;
    const overrides = config?.ai ?? {};
    const defaultProvider = overrides.defaultProvider ?? defaults[0]!.id;
    if (!defaults.some(provider => provider.id === defaultProvider) || Object.keys(overrides.providers ?? {}).some(id => !defaults.some(provider => provider.id === id))) throw new Error("unknown provider");
    const providers = defaults.map(provider => {
      const merged = providerSchema.parse({ ...provider, ...overrides.providers?.[provider.id] });
      return { ...merged, executable: config ? config.manualPaths?.[provider.id] ?? config.detectedPaths?.[provider.id] ?? null : merged.executable };
    });
    return { defaults, overrides, defaultProvider, providers };
  } catch { throw new RepositoryOperationError("AI_CONFIGURATION_INVALID", "AI 整理覆盖配置无效，请检查 app-config.json；本次未调用 CLI"); }
}
export interface ClaudePolicyEnvironment {
  managedDirectory: string;
  claudeDirectory: string;
  checkSystemPolicy: () => Promise<void>;
}
export interface CliInput { provider: AiProvider; directory: string; prompt: string; schema: object; signal: AbortSignal; claudePolicy?: ClaudePolicyEnvironment }
export type CliRunner = (input: CliInput) => Promise<unknown>;

export async function readProviders(path: string): Promise<AiProvider[]> {
  try {
    const value = z.object({ providers: z.array(providerSchema).min(1).max(2) }).strict().parse(JSON.parse(await readFile(path, "utf8")));
    if (new Set(value.providers.map(p => p.id)).size !== value.providers.length) throw new Error("duplicate provider");
    if (value.providers.some(p => p.id === "claude" && p.profile)) throw new Error("Claude has no profile flag");
    return value.providers;
  } catch { throw new RepositoryOperationError("AI_CONFIGURATION_INVALID", "AI 静态配置无效，请开发者检查资源文件"); }
}

export async function providerAvailability(provider: ResolvedAiProvider, claudePolicy?: ClaudePolicyEnvironment): Promise<{ available: boolean; reason?: string }> {
  try {
    if (!provider.executable) return { available: false, reason: "尚未检测到 CLI，请在对应 Agent 页重新检测或手动指定" };
    await access(provider.executable, constants.X_OK);
    // Managed Claude hooks cannot be disabled by a per-call override. Do not
    // start a model invocation when that side-effect boundary is unprovable.
    if (provider.id === "claude") await assertNoManagedClaudeSettings(claudePolicy);
    return { available: true };
  } catch (error) { return { available: false, reason: error instanceof RepositoryOperationError ? error.message : "未找到可执行的 CLI，请开发者检查静态配置" }; }
}

export const runAiCli: CliRunner = async input => {
  const { provider, directory, signal } = input;
  const availability = await providerAvailability(provider, input.claudePolicy);
  if (!availability.available) throw new RepositoryOperationError("AI_CLI_UNAVAILABLE", availability.reason!);
  const common = { executable: provider.executable, directory, signal, timeoutMs: 15_000 };
  const help = await runProcess({ ...common, stage: "能力检查", args: provider.id === "codex" ? ["exec", "--help"] : ["--help"] });
  const required = provider.id === "codex"
    ? ["--ignore-rules", "--output-schema", "--output-last-message", "--ephemeral", "--sandbox"]
    : ["--tools", "--strict-mcp-config", "--settings", "--json-schema", "--no-session-persistence", "--disallowedTools", "--disable-slash-commands", ...(provider.effort ? ["--effort"] : [])];
  if (required.some(flag => !help.includes(flag))) throw new RepositoryOperationError("AI_CLI_UNSUPPORTED", "CLI 版本不支持本次受限调用，请开发者检查版本");
  const model = provider.model ? ["--model", provider.model] : [];
  const effort = !provider.effort ? [] : provider.id === "codex" ? ["-c", `model_reasoning_effort="${provider.effort}"`] : ["--effort", provider.effort];
  if (provider.id === "codex") {
    const profile = provider.profile ? ["--profile", provider.profile] : [];
    const config: string[] = ["-c", "notify=[]", "-c", "web_search=\"disabled\"", "-c", "approval_policy=\"never\"", "-c", "agents.enabled=false"];
    const disabled = ["hooks", "apps", "plugins", "remote_plugin", "shell_tool", "unified_exec", "multi_agent", "multi_agent_v2", "computer_use", "image_generation", "view_image", "code_mode", "code_mode_host", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "shell_snapshot"];
    const features = await runProcess({ ...common, stage: "功能配置检查", args: [...profile, "features", "list"] });
    const availableFeatures = new Set(features.split(/\r?\n/u).map(line => line.trim().split(/\s+/u)[0]));
    for (const feature of disabled) if (availableFeatures.has(feature)) config.push("--disable", feature);
    if (!availableFeatures.has("hooks") || !availableFeatures.has("shell_tool")) throw new RepositoryOperationError("AI_CLI_UNSUPPORTED", "无法核实 CLI 的工具与 Hook 限制");
    // Discover under the same feature restrictions as exec: disabling plugins
    // can remove injected servers. An override would recreate an invalid entry.
    // mcp_servers={} merges with inherited tables, so disable each server.
    const servers = parseMcpList(await runProcess({ ...common, stage: "MCP 服务发现", args: [...profile, ...config, "mcp", "list", "--json"] }));
    for (const server of servers) {
      // Codex splits -c keys on dots; quotes are literal key characters, not
      // TOML escaping. Reject names we cannot safely address instead of skipping.
      if (!/^[A-Za-z0-9_-]+$/u.test(server.name)) throw new RepositoryOperationError("AI_CLI_UNSUPPORTED", "MCP 服务名不支持安全的 CLI 参数覆盖，请开发者检查配置；本次未提交");
      config.push("-c", `mcp_servers.${server.name}.enabled=false`);
    }
    const finalServers = parseMcpList(await runProcess({ ...common, stage: "MCP 禁用核验", args: [...profile, ...config, "mcp", "list", "--json"] }));
    if (finalServers.some(server => server.enabled)) throw new RepositoryOperationError("AI_CLI_UNSAFE_CONFIG", "本次调用无法禁用已配置的 MCP");
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "result.json");
    await writeFile(schemaPath, JSON.stringify(input.schema), { flag: "wx", mode: 0o600 });
    await runProcess({ ...common, stage: "模型生成", timeoutMs: provider.timeoutMs, args: [...profile, ...config, ...effort, "exec", "--sandbox", "read-only", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", ...model, "--output-schema", schemaPath, "--output-last-message", outputPath, "-"], stdin: input.prompt });
    const stat = await lstat(outputPath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) throw invalidOutput();
    return parseJson(await readFile(outputPath, "utf8"));
  }
  const auth = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional(), subscriptionType: z.string().nullable().optional() }).passthrough()
    .safeParse(parseJson(await runProcess({ ...common, stage: "登录检查", args: ["auth", "status"] })));
  if (!auth.success || !auth.data.loggedIn) throw new RepositoryOperationError("AI_AUTH_UNAVAILABLE", "无法核实 Claude CLI 登录状态");
  // Team/Enterprise may fetch policy hooks for the first time at startup, even
  // with no cache. This adapter cannot override those policies. Personal plans
  // avoid that uninspectable execution channel without copying credentials.
  if (auth.data.authMethod !== "claude.ai" || !["pro", "max"].includes(auth.data.subscriptionType ?? "")) throw new RepositoryOperationError("AI_CLI_UNSAFE_CONFIG", "当前 Claude 登录无法排除受管理 Hook；首版支持无管理策略的 Pro／Max 直接登录");
  await assertNoManagedClaudeSettings(input.claudePolicy);
  const result = parseJson(await runProcess({ ...common, stage: "模型生成", timeoutMs: provider.timeoutMs, args: ["-p", "--output-format", "json", "--json-schema", JSON.stringify(input.schema), "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--settings", "{\"disableAllHooks\":true,\"autoMemoryEnabled\":false}", "--disable-slash-commands", "--no-session-persistence", ...model, ...effort], stdin: input.prompt }));
  const envelope = z.object({ is_error: z.boolean().optional(), result: z.string().optional(), structured_output: z.unknown().optional() }).passthrough().safeParse(result);
  if (envelope.success && envelope.data.is_error) throw cliFailure(envelope.data.result ?? "", "模型生成");
  if (!envelope.success || envelope.data.structured_output === undefined) throw invalidOutput();
  return envelope.data.structured_output;
};

function parseMcpList(text: string): Array<{ name: string; enabled: boolean }> {
  const parsed = z.array(z.object({ name: z.string().min(1), enabled: z.boolean() }).passthrough()).safeParse(parseJson(text));
  if (!parsed.success) throw new RepositoryOperationError("AI_CLI_UNSUPPORTED", "无法核实 MCP 禁用状态");
  return parsed.data.map(({ name, enabled }) => ({ name, enabled }));
}
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { throw invalidOutput(); } }
function invalidOutput(): RepositoryOperationError { return new RepositoryOperationError("AI_OUTPUT_INVALID", "AI 未返回完整、有效的结构化内容，本次未提交"); }

async function assertNoManagedClaudeSettings(policy?: ClaudePolicyEnvironment): Promise<void> {
  if (process.platform !== "darwin") throw new RepositoryOperationError("AI_CLI_UNSUPPORTED", "首版 Claude 受管理配置检查仅支持 macOS");
  const roots = [policy?.managedDirectory ?? "/Library/Application Support/ClaudeCode"];
  const paths = [...roots.flatMap(root => ["managed-settings.json", "managed-settings.d", "managed-mcp.json"].map(name => join(root, name))),
    join(policy?.claudeDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "remote-settings.json")];
  for (const path of paths) {
    try { await lstat(path); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    throw new RepositoryOperationError("AI_CLI_UNSAFE_CONFIG", "检测到 Claude 受管理配置，无法保证关闭其 Hook，本次调用不可用");
  }
  if (policy) await policy.checkSystemPolicy();
  else await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/defaults", ["read", "com.anthropic.claudecode"], { timeout: 2000, maxBuffer: 64000, env: { ...process.env, LANG: "C", LC_ALL: "C" } }, (error, _stdout, stderr) => {
      if (error?.code === 1 && (stderr.includes("does not exist") || stderr.includes("Domain 'com.anthropic.claudecode' not found"))) resolve();
      else reject(new RepositoryOperationError("AI_CLI_UNSAFE_CONFIG", "检测到或无法排除 Claude 系统管理策略，本次调用不可用"));
    });
  });
  // Environment-delivered managed settings can also force hooks.
  if (process.env.CLAUDE_CODE_MANAGED_SETTINGS) throw new RepositoryOperationError("AI_CLI_UNSAFE_CONFIG", "Claude 受管理配置不支持本次受限调用");
}

type CliStage = "能力检查" | "功能配置检查" | "MCP 服务发现" | "MCP 禁用核验" | "登录检查" | "模型生成";
interface ProcessInput { executable: string; args: string[]; directory: string; signal: AbortSignal; timeoutMs: number; stdin?: string; stage?: CliStage }
export async function runProcess(input: ProcessInput): Promise<string> {
  if (input.signal.aborted) throw new RepositoryOperationError("AI_INTERRUPTED", "AI 操作已中断，本次未提交");
  // Preserve normal login/profile/proxy discovery without handing the child
  // this application's local repository or capability-bearing context.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PRECEDENT_LOOP_") && !key.startsWith("CODEX_HOOK_") && key !== "CLAUDECODE"));
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.directory, env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let output = "", diagnostic = "", size = 0, stopped: RepositoryOperationError | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) stopped ??= new RepositoryOperationError("AI_STOP_FAILED", "无法停止 AI 子进程"); }
    };
    const stop = (error: RepositoryOperationError): void => {
      if (stopped) return;
      stopped = error; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const abort = (): void => stop(new RepositoryOperationError("AI_INTERRUPTED", "AI 操作已中断，本次未提交"));
    const timer = setTimeout(() => stop(new RepositoryOperationError("AI_TIMEOUT", "AI 调用超时，本次未提交")), input.timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { size += Buffer.byteLength(data); if (size > 8_000_000) stop(new RepositoryOperationError("AI_OUTPUT_TOO_LARGE", "AI 输出超出限额，本次未提交")); else output += data; });
    child.stderr.on("data", (data: Buffer) => { size += data.length; diagnostic = (diagnostic + data.toString("utf8")).slice(-12000); if (size > 8_000_000) stop(new RepositoryOperationError("AI_OUTPUT_TOO_LARGE", "AI 输出超出限额，本次未提交")); });
    child.stdin.on("error", () => { /* exit/error decides the result; never log the prompt */ });
    child.stdin.end(input.stdin ?? "");
    const cleanup = (): void => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); input.signal.removeEventListener("abort", abort); kill("SIGKILL"); };
    child.once("error", () => { cleanup(); reject(stopped ?? new RepositoryOperationError("AI_CLI_UNAVAILABLE", "无法启动 AI CLI")); });
    child.once("close", code => { cleanup(); if (stopped) reject(stopped); else if (code !== 0) reject(cliFailure(diagnostic, input.stage)); else resolve(output); });
  });
}

function cliFailure(diagnostic: string, stage?: CliStage): RepositoryOperationError {
  const context = stage ? `（${stage}）` : "";
  // Retain only a fixed reason and stage: stderr may include credentials,
  // configuration paths or input content and must never be returned verbatim.
  if (/invalid transport/iu.test(diagnostic)) return new RepositoryOperationError("AI_CLI_CONFIGURATION_INVALID", `CLI 配置加载失败${context}：MCP 传输配置无效，请开发者检查调用参数与配置；本次未提交`);
  if (/error loading config\.toml|failed to load bootstrap configuration/iu.test(diagnostic)) return new RepositoryOperationError("AI_CLI_CONFIGURATION_INVALID", `CLI 配置加载失败${context}，请开发者检查调用参数与本机配置；本次未提交`);
  if (/not logged in|authentication failed|invalid api key|login required/iu.test(diagnostic)) return new RepositoryOperationError("AI_AUTH_UNAVAILABLE", `CLI 报告登录或认证不可用${context}，请在本机终端完成登录；本次未提交`);
  if (/quota exceeded|rate_limit|usage limit|rate limit/iu.test(diagnostic)) return new RepositoryOperationError("AI_QUOTA_UNAVAILABLE", `CLI 报告用量或速率限制${context}；本次未提交`);
  return new RepositoryOperationError("AI_CLI_FAILED", `AI CLI 调用失败${context}；本次未提交`);
}
