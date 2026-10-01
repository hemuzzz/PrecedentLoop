import { HubApiError } from "../api/client.js";

export interface PresentedError {
  detail: string;
  title: string;
}

export type ReadViewContext =
  | "SYSTEM_STATUS"
  | "USAGE_LIST";

export function asHubApiError(error: unknown): HubApiError {
  return error instanceof HubApiError
    ? error
    : new HubApiError("CLIENT_ERROR", "无法加载页面", true, 0);
}

export function presentReadError(
  error: HubApiError | undefined,
  context: ReadViewContext,
): PresentedError | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error.code === "SERVICE_UNREACHABLE") {
    return {
      title: "本地服务未连接",
      detail: "启动 Precedent Loop 服务后重试。",
    };
  }
  if (error.code === "INVALID_RESPONSE") {
    return {
      title: "无法读取服务响应",
      detail: "服务返回了无法识别的响应，请检查服务后重试。",
    };
  }
  if (error.status === 503) {
    const subject =
      context === "SYSTEM_STATUS"
        ? "系统状态"
        : context === "USAGE_LIST"
          ? "使用记录"
          : "知识";
    return {
      title: `${subject}暂时不可用`,
      detail: "本地服务尚未就绪，请恢复后重试。",
    };
  }
  if (error.status >= 500) {
    return {
      title: "本地服务未能完成请求",
      detail: "请检查服务日志后重试。",
    };
  }
  return { title: "请求未完成", detail: error.message };
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function displayWorkspace(workspace: string | null): string {
  return workspace ?? "GLOBAL";
}

const valueLabels: Record<string, string> = {
  MEMORY: "记忆",
  DOCUMENT: "文档",
  SKILL: "技能",
  GLOBAL: "全局知识",
  WORKSPACE: "工作区",
  RUNNING: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  READY: "就绪",
  DEGRADED: "降级运行",
  REBUILD_REQUIRED: "需要重建",
  NOT_STARTED: "未启动",
  STARTING: "启动中",
  STOPPED: "已停止",
  DIRECT: "直接注入",
  ON_DEMAND: "按需读取",
};

export function displayValue(value: string): string {
  return valueLabels[value] ?? value;
}

export function handleTabKeydown(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const group = event.currentTarget;
  if (!(group instanceof HTMLElement)) return;
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.findIndex((tab) => tab === event.target);
  if (index < 0 || tabs.length === 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
