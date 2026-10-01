import type { AppConfigResult } from "./config.js";
import type { DataDirectoryInspection } from "./data-directory.js";

export type StartupMode =
  | { mode: "NORMAL"; dataDirectory: string }
  | { mode: "SETUP" | "RECOVERY"; code: string; reason: string; dataDirectory: string };

export function determineStartupMode(config: AppConfigResult, checked?: DataDirectoryInspection): StartupMode {
  if (config.kind === "MISSING") return { mode: "SETUP", code: "CONFIG_MISSING", reason: "首次使用，请先完成初始化。", dataDirectory: "未选择" };
  if (config.kind === "INVALID") return { mode: "RECOVERY", code: "CONFIG_INVALID", reason: `配置文件无效，原文件已保留。${config.reason}`, dataDirectory: "无法读取" };
  const dataDirectory = config.config.dataDirectory;
  if (!config.config.setupCompleted) return { mode: "SETUP", code: "SETUP_INCOMPLETE", reason: "初始化尚未完成，已保留现有配置。", dataDirectory };
  const inspection = checked?.kind === "SYNC_RISK" ? checked.inspection : checked;
  if (inspection?.kind === "PRODUCT") return { mode: "NORMAL", dataDirectory };
  const recovery = (code: string, reason: string): StartupMode => ({ mode: "RECOVERY", code, reason, dataDirectory });
  switch (inspection?.kind) {
    case "MISSING": return recovery("DATA_MISSING", "数据目录不存在，请检查目录位置。");
    case "NOT_WRITABLE": return recovery("DATA_INACCESSIBLE", inspection.reason);
    case "EMPTY":
    case "OTHER_NON_EMPTY": return recovery("DATA_NOT_PRODUCT", "所选目录不是本产品数据目录。");
    case "PRODUCT_UPGRADABLE": return recovery("STORAGE_UPGRADE_REQUIRED", "存储版本 5 需要备份并升级后才能使用。");
    case "PRODUCT_INCOMPLETE": return recovery("STORAGE_INCOMPLETE", "数据目录初始化尚未完成。");
    case "PRODUCT_UNSUPPORTED": return recovery("STORAGE_UNSUPPORTED", inspection.reason);
    default: return recovery("DATA_UNCHECKED", "数据目录尚未完成检查。");
  }
}

export function backendFailureMode(dataDirectory: string, error: unknown, logPath: string): StartupMode {
  return { mode: "RECOVERY", code: "BACKEND_FAILED", dataDirectory,
    reason: `本地服务启动或运行失败：${error instanceof Error ? error.message : String(error)}\n日志：${logPath}` };
}
