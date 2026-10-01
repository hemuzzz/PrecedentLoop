import type { AgentName, IntegrationItem, IntegrationItemStatus } from "./bridge.js";

export const agents = ["codex", "claude"] as const;
export const agentNames: Record<AgentName, string> = { codex: "Codex", claude: "Claude Code" };
export const items = ["mcp", "projectContext", "captureReminder"] as const;
export const itemNames: Record<IntegrationItem, string> = {
  mcp: "知识库连接（MCP）", projectContext: "项目识别", captureReminder: "沉淀提醒",
};
/** Plain-language effects shown to users (2026-09-24): what gets set up and what it does, no paths. */
export const effectNames: Record<IntegrationItem, string> = {
  mcp: "自动连接知识库", projectContext: "自动识别当前项目", captureReminder: "任务结束提醒沉淀",
};
export function effectText(agent: AgentName, item: IntegrationItem): string {
  const name = agentNames[agent];
  return item === "mcp" ? `${name} 可以检索经你确认的知识。`
      : item === "projectContext" ? `在工作区中工作时，${name} 会使用对应项目的知识。`
        : "完成工程任务时提醒评估是否有值得保存的知识，不阻断任务。";
}
export const trustSteps = ["在 Codex CLI 中运行 /hooks，或打开 Codex 桌面版 设置 → Hooks", "信任 3 个 precedent-hook 条目", "回到这里点“重新检测”"] as const;
export function itemLabel(status: IntegrationItemStatus, selection = false): string {
  if (status.configuration === "pending-trust") return "待信任";
  if (selection && status.configuration === "configured" && !["异常", "待处理", "被策略禁用"].includes(status.label)) return "已配置";
  return status.label;
}
export function statusTone(label: string): string {
  if (["正常", "已配置", "已配置，未验证", "已完成"].includes(label)) return "ok";
  if (["部分完成", "待处理", "待信任", "待确认"].includes(label)) return "warn";
  return ["异常", "写入失败", "未完成"].includes(label) ? "error" : "neutral";
}
