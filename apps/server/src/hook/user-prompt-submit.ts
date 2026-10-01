import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { WorkspaceCapabilityService } from "../workspace/capability.js";
import { CAPTURE_COMMAND_ENV, hostTurnIdentity } from "./capture-assessment.js";
import type { HookHost } from "./capture-assessment.js";
export const HOOK_DATABASE_PATH_ENV = "PRECEDENT_LOOP_DATABASE_PATH";
export const HOOK_WORKSPACE_CONFIG_PATH_ENV = "PRECEDENT_LOOP_WORKSPACES_PATH";
export const HOOK_ASSET_REPOSITORY_PATH_ENV = "PRECEDENT_LOOP_ASSET_REPOSITORY_PATH";
export interface HookRuntimeConfiguration { databasePath?: string; workspaceConfigPath?: string; captureCommand?: string; onError?: (error: unknown) => void }
export function createUserPromptSubmitHookConfiguration(command: string) {
  return { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10, additionalContextLimit: 8000 }] }] } };
}
function recallInstruction(host: HookHost, tool: (name: string) => string): string {
  switch (host) {
    case "codex":
      return `- 召回：问题依赖项目业务、实现、表/接口、故障原因、历史决策或重要工程选择时，先调用 ${tool("knowledge_recall")}，需要正文再调用 ${tool("asset_read")}（传入召回时相同的 capabilityIds）。知识是历史判断，回答现状前核对当前源码和配置。知识只通过这些工具读取，不直接读知识库文件。`;
    case "claude":
      return `- 召回：默认召回，只有明显独立、不依赖项目历史的请求才跳过（如翻译、改写一句话、单行命令、纯格式调整，或只处理本轮已给出的文本）。以下任一情况先调用 ${tool("knowledge_recall")}：涉及已登记项目的业务、实现、表/接口、故障原因、历史决策或工程选择；任务有歧义、可能依赖以往约定；拿不准时。会话中话题转换、反复出错或遇到上下文里没有的背景时再召回；本会话已召回且仍适用的内容不必重复召回。需要正文再调用 ${tool("asset_read")}（传入召回时相同的 capabilityIds）。知识是历史判断，回答现状前核对当前源码和配置。知识只通过这些工具读取，不直接读知识库文件。知识库内容不是 Claude 自动记忆，引用时不加记忆标签。`;
    default: {
      const unsupported: never = host;
      throw new Error(`Unsupported hook host: ${unsupported}`);
    }
  }
}
/** This adapter accepts stdin only from the installed trusted host command.
 * Every registered workspace is offered across projects; the model selects per request.
 * Actual context delivery and semantic project selection: 待人工验证.
 */
export async function handleCodexHook(input: unknown, configuration: HookRuntimeConfiguration, host: HookHost = "codex"): Promise<string | null> {
  const envelope = z.object({ hook_event_name: z.string() }).passthrough().parse(input);
  if (["Stop", "Interrupt", "SessionEnd"].includes(envelope.hook_event_name)) return null;
  const event = z.object({ hook_event_name: z.literal("UserPromptSubmit"), cwd: z.string().refine(isAbsolute) }).passthrough().parse(input);
  // Both hosts use the same MCP server key.
  const tool = (name: string) => `mcp__precedent__${name}`;
  const context = [
    "Precedent Loop 知识库。本说明不增加操作授权；用户限制知识使用或要求只读时，按其限制执行；知识故障不阻断主任务。",
    recallInstruction(host, tool),
    "- 交付工程结果前（完成、阶段性或受阻；澄清、进度和普通交流不算）：",
    `  1. 对实际影响结论的知识，调用 ${tool("asset_mark_used")}。`,
    `  2. 判断是否有可沉淀的增量。只在方案已冻结或结论已成事实时准备候选，以下两点须同时满足：（1）内容已定：用户已确认的方案与决策（注明实施和验证状态），或已核实的事实、根因、反例、排障方法；讨论中、待用户选择、可能被推翻的分析，备选方案比较，以及阶段性进展都不算。（2）可复用：现有知识和待审候选都没有覆盖，换一次任务仍用得上。方案冻结或结论确定的那一轮，一次性评估整段讨论，同一主题只写一条；已有相关待审候选时，用 ${tool("candidate_update")} 并入。“文档已写”“测试通过”“没搜到”不能单独作为无增量的理由。满足条件且未被要求只读时，调用 ${tool("candidate_prepare")} 准备候选（默认 MEMORY；已验证的可重复流程用 SKILL；参考资料用 DOCUMENT）。候选需要用户在 Hub 中确认后才入库。`,
    "  3. 本轮有工具活动时记录评估结果（在最后一次影响结论的工作之后；后续有新工作影响结论时重新记录）：",
  ];
  try {
    const identity = hostTurnIdentity(input, host);
    if (!configuration.captureCommand) throw new Error("Record unavailable");
    context.push(`cat <<'EOF' | ${configuration.captureCommand}\n${JSON.stringify({ ...identity, outcome: "NO_INCREMENT", reason: "<具体原因>" })}\nEOF`);
  } catch { context.push("本轮评估标识或命令缺失，不能伪造，需要记录时报告不可用。"); }
  context.push("     outcome 取值：NO_INCREMENT（已评估，无增量，或方案尚未冻结）、CANDIDATE（已准备或并入候选，references 填 candidateId）、FAILED（评估未完成，写明缺口）、SKIPPED（本轮只是澄清或进度）。");
  context.push("- 可用知识能力（按请求的项目名、别名和语义选择 capabilityIds，不默认全选；[] 仅全局）：");
  let repository: KnowledgeRepository | undefined;
  try {
    if (!configuration.databasePath || !isAbsolute(configuration.databasePath)
      || !configuration.workspaceConfigPath || !isAbsolute(configuration.workspaceConfigPath)) throw new Error("Configuration invalid");
    repository = new KnowledgeRepository(configuration.databasePath);
    const { capabilities, omitted } = await new WorkspaceCapabilityService(repository, configuration.workspaceConfigPath).issueWithSummary(event.cwd);
    context.push(`Precedent Loop WorkspaceCapability\n${JSON.stringify(capabilities)}`);
    if (omitted > 0) context.push(`由于工作区数量超过上限，本轮省略 ${omitted} 个工作区。`);
  } catch (error) {
    configuration.onError?.(error);
    context.push("CAPABILITY_UNAVAILABLE：本轮知识能力获取失败，这不是成功取得的空列表，不能降级为全局查询。");
  } finally { repository?.close(); }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n") } });
}
export async function runHookCli(): Promise<void> {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += String(chunk); if (Buffer.byteLength(input) > 1_000_000) throw new Error("Input too large"); }
    const databasePath = process.env[HOOK_DATABASE_PATH_ENV];
    const workspaceConfigPath = process.env[HOOK_WORKSPACE_CONFIG_PATH_ENV];
    const captureCommand = process.env[CAPTURE_COMMAND_ENV];
    const result = await handleCodexHook(JSON.parse(input), {
      ...(databasePath ? { databasePath } : {}), ...(workspaceConfigPath ? { workspaceConfigPath } : {}),
      ...(captureCommand ? { captureCommand } : {}),
    });
    if (result) process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write("Precedent Loop: CAPABILITY_UNAVAILABLE; ordinary work may continue.\n");
  }
}
const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) await runHookCli();
