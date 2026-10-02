import { z } from "zod";
import type { IntegrationPlan, IntegrationResult } from "./integrations/contract.js";

const fields = { model: z.string().trim().min(1).max(256).optional(), effort: z.string().regex(/^[a-z]{1,16}$/u).optional(), timeoutMs: z.number().int().min(1_000).max(3_600_000).optional() };
export const aiOverridesSchema = z.object({
  defaultProvider: z.enum(["codex", "claude"]).optional(),
  providers: z.object({
    codex: z.object({ ...fields, profile: z.string().trim().min(1).max(256).optional() }).strict().optional(),
    claude: z.object(fields).strict().optional(),
  }).strict().optional(),
}).strict();
export type AiOverrides = z.infer<typeof aiOverridesSchema>;
export const portSchema = z.number().int().min(1).max(65535);
export interface LocalSettings {
  dataDirectory: string;
  paths: { databasePath: string; workspaceConfigPath: string; logPath: string; desktopLogPath: string };
  storageVersion: number | null;
  runtime: { nodeVersion: string; arch: string; modules: string };
  port: number;
  pendingPort: number | null;
  lastRestart: PortChangeResult | null;
  lastDataMove: DataMoveResult | null;
}
/** migrate: copy the current data directory to a new, empty location (T2-b).
 * associate: switch to an existing baseline-2 data directory without merging (T2-c). */
export type DataMoveMode = "migrate" | "associate";
export interface DataMovePlan {
  /** null when the selected location cannot be used; `reason` explains why. */
  planId: string | null; mode: DataMoveMode; from: string; to: string; syncRisk: boolean;
  statistics: { workspaces?: number };
  reason: string | null;
}
export interface DataMoveResult {
  mode: DataMoveMode; from: string; to: string;
  /** failed: nothing switched, the original service was restarted; recovery: switched but the new service did not start. */
  status: "success" | "failed" | "recovery";
  files?: number; bytes?: number; reason: string | null;
}
export interface PortChangePlan {
  planId: string; from: number; to: number; target: string; diff: string;
  integration: IntegrationPlan | null;
}
export interface PortChangeResult {
  port: number; status: "success" | "rolled-back" | "recovery";
  reason: string | null; integration: IntegrationResult | null;
  mcpPending?: boolean;
}
