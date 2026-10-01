import type { AgentDetection, IntegrationStatus } from "../setup/bridge.js";

export function pendingIntegrations(statuses: IntegrationStatus[]) {
  return statuses.flatMap(agent => agent.items.filter(item => item.choice === "enabled" && item.label !== "等待服务"
    && !["正常", "已配置，未验证", "外部已存在"].includes(item.label)).map(item => ({ agent: agent.agent, status: item })));
}
export function cliAvailability(detection: AgentDetection | null | undefined): string {
  return !detection ? "未检测" : !detection.found ? "未在本机找到" : !detection.runnable ? "暂不可用"
    : detection.login === "logged-in" ? "CLI 可用" : detection.login === "logged-out" ? "CLI 可运行 · 未登录" : "CLI 可运行 · 登录未验证";
}
export function displayTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
