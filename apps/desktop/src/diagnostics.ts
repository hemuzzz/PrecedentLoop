import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataPaths, type AppConfig, type BuildInfo } from "./config.js";
import { atomicWrite } from "./integrations/files.js";
import { readLedger } from "./integrations/ledger.js";
import type { IntegrationStatus } from "./integrations/contract.js";

const timestamp = z.iso.datetime();
const desktopEvent = z.object({
  event: z.enum(["backend-starting", "backend-ready", "backend-exited", "app-stopped"]),
  at: timestamp, startedAt: timestamp, mainPid: z.number().int().positive(), childPid: z.number().int().positive().optional(), buildId: z.uuid(),
  code: z.number().int().nullable().optional(), signal: z.enum(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT", "SIGBUS", "SIGTRAP"]).nullable().optional(), normal: z.boolean().optional(),
}).strict();
/** Read bounded tails only; never follow log symlinks or export free-form text. */
async function tail(path: string): Promise<string[]> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return [];
      const size = Math.min(stat.size, 64 * 1024), data = Buffer.alloc(size), start = stat.size - size;
      await file.read(data, 0, size, start);
      const lines = data.toString("utf8").split(/\r?\n/u);
      if (start > 0) lines.shift();
      return lines.filter(Boolean).slice(-200);
    } finally { await file.close(); }
  } catch { return []; }
}
export async function exportDiagnostics(target: string, input: {
  version: string; build: BuildInfo; config: AppConfig; userData: string;
  statuses: IntegrationStatus[]; backend: { serviceReady: boolean; mcpReady: boolean };
}): Promise<void> {
  const paths = dataPaths(input.config.dataDirectory), ledger = await readLedger(input.userData);
  const desktopLines = await tail(paths.desktopLogPath), hookLines = await tail(join(input.userData, "logs/hook.log"));
  const desktop = desktopLines.flatMap(line => {
    try { const parsed = desktopEvent.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data] : []; } catch { return []; }
  });
  const hook = hookLines.flatMap(line => {
    const match = /^(\S+) (HOOK_UNAVAILABLE|WORKSPACE_CONFIG_INVALID|WORKSPACE_CONFIG_CHANGED|DATABASE_MISMATCH|ASSET_FROZEN)$/u.exec(line);
    return match && timestamp.safeParse(match[1]).success ? [{ at: match[1], code: match[2] }] : [];
  });
  const diagnostics = {
    formatVersion: 1, exportedAt: new Date().toISOString(), application: { version: input.version, ...input.build },
    appConfig: input.config,
    integrations: Object.entries(ledger.artifacts).map(([id, record]) => ({ id, target: record.target, kind: record.kind,
      hash: /^[a-f0-9]{64}$/u.test(record.hash) ? record.hash : null,
      installedAt: timestamp.safeParse(record.installedAt).success ? record.installedAt : null })),
    status: input.statuses.map(status => ({ agent: status.agent, label: status.label,
      detection: status.detection ? { agent: status.detection.agent, source: status.detection.source, path: status.detection.path,
        found: status.detection.found, runnable: status.detection.runnable, login: status.detection.login,
        version: status.detection.version && /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/u.test(status.detection.version) ? status.detection.version : null,
        checkedAt: timestamp.safeParse(status.detection.checkedAt).success ? status.detection.checkedAt : null } : null,
      items: status.items.map(item => ({ item: item.item, choice: item.choice, configuration: item.configuration, verification: item.verification, label: item.label, targets: item.targets,
        evidence: { installedAt: timestamp.safeParse(item.evidence.installedAt).success ? item.evidence.installedAt : null,
          lastConnected: timestamp.safeParse(item.evidence.lastConnected).success ? item.evidence.lastConnected : null,
          lastTriggered: timestamp.safeParse(item.evidence.lastTriggered).success ? item.evidence.lastTriggered : null,
          trust: item.evidence.trust } })) })),
    backend: input.backend,
    logs: {
      desktop: { path: paths.desktopLogPath, entries: desktop, excludedLines: desktopLines.length - desktop.length },
      server: { path: paths.logPath, entries: [], omitted: "结构化错误含 errorMessage/stack，可能包含正文或输入；整份日志不导出。" },
      hook: { path: join(input.userData, "logs/hook.log"), entries: hook, excludedLines: hookLines.length - hook.length },
    },
    exclusions: ["知识与候选文件、数据库、用户提示词、AI 输入输出", "stdout/stderr、自由文本错误原因及未知日志行", "集成文件内容、信任记录和凭据"],
  };
  await atomicWrite(target, JSON.stringify(diagnostics, null, 2) + "\n", 0o600);
}
