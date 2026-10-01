import { z } from "zod";
import type { AgentDetection, AgentName } from "../setup-contract.js";

export const integrationItems = ["mcp", "projectContext", "captureReminder"] as const;
export type IntegrationItem = typeof integrationItems[number];
export const itemSchema = z.enum(integrationItems);
const itemsSchema = z.array(itemSchema).min(1).max(3).refine(items => new Set(items).size === items.length);
const integrationSelectionSchema = z.object({
  agent: z.enum(["codex", "claude"]), items: itemsSchema,
  conflicts: z.partialRecord(itemSchema, z.enum(["preserve", "replace"])).default({}),
}).strict();
export const integrationPlanSchema = z.union([
  integrationSelectionSchema,
  z.object({ selections: z.array(integrationSelectionSchema).min(1).max(2)
    .refine(selections => new Set(selections.map(selection => selection.agent)).size === selections.length) }).strict(),
]);
export const integrationRemoveSchema = z.object({
  agent: z.enum(["codex", "claude", "all"]), items: itemsSchema,
  removeModified: z.array(itemSchema).max(3).default([]),
  removeModifiedByAgent: z.partialRecord(z.enum(["codex", "claude"]), z.array(itemSchema).max(3)).optional(),
}).strict();
export const integrationChoicesSchema = z.partialRecord(z.enum(["codex", "claude"]), z.object({ mcp: z.enum(["enabled", "skipped", "undecided"]).optional(), projectContext: z.enum(["enabled", "skipped", "undecided"]).optional(), captureReminder: z.enum(["enabled", "skipped", "undecided"]).optional(), skills: z.unknown().optional() }).strict().transform(({ skills: _legacy, ...choices }) => choices));
export type IntegrationChoices = z.infer<typeof integrationChoicesSchema>;
export const integrationStatusSchema = z.object({ choices: integrationChoicesSchema.default({}) }).strict();
export const planIdSchema = z.object({ planId: z.string().uuid() }).strict();
export type PlanRequest = z.input<typeof integrationPlanSchema>;
export type RemoveRequest = z.input<typeof integrationRemoveSchema>;
export type StatusRequest = z.input<typeof integrationStatusSchema>;
export interface IntegrationOperation {
  target: string;
  kind: "file" | "directory" | "hook" | "command";
  action: "create" | "modify" | "remove" | "none";
  diff: string;
  commands: string[][];
  backup: string | null;
  conflict: "external" | "modified" | null;
  reason: string | null;
}
export interface IntegrationPlanItem {
  agent: AgentName;
  item: IntegrationItem;
  operations: IntegrationOperation[];
  error: string | null;
}
export interface IntegrationPlan {
  planId: string;
  mode: "install" | "remove";
  createdAt: string;
  fingerprint: string;
  items: IntegrationPlanItem[];
  notices: string[];
}
export interface IntegrationResult {
  planId: string;
  items: Array<{ agent: AgentName; item: IntegrationItem; status: "success" | "partial" | "preserved" | "failed"; reason: string | null; backups: string[] }>;
}
export interface IntegrationProgress {
  planId: string;
  agent: AgentName;
  item: IntegrationItem;
  status: "running" | IntegrationResult["items"][number]["status"];
  reason: string | null;
}
export interface IntegrationItemStatus {
  item: IntegrationItem;
  choice: "enabled" | "skipped" | "undecided";
  detection: "not-checked" | "found" | "not-found" | "failed";
  configuration: "unconfigured" | "configured" | "partial" | "repair" | "external" | "pending-trust" | "policy-disabled";
  verification: "unverified" | "verified" | "failed";
  label: "正常" | "已配置，未验证" | "部分完成" | "待处理" | "异常" | "未配置" | "未接入" | "外部已存在" | "被策略禁用" | "已跳过" | "等待服务";
  targets: string[];
  reasons: string[];
  evidence: { lastTriggered: string | null; lastConnected: string | null; installedAt: string | null; trust: "trusted" | "pending" | "unverified" | null };
}
export interface IntegrationStatus {
  agent: AgentName;
  detection: AgentDetection | null;
  label: string;
  items: IntegrationItemStatus[];
}
export type ProjectSource = "codex" | "claude";
/** A recent project from Codex and/or Claude Code, merged by exact name. */
export interface CodexProject {
  name: string;
  sources: ProjectSource[];
  paths: Array<{ candidateId: string; path: string; exists: boolean; reason?: string | undefined; registeredAs?: string | undefined }>;
}
/** Every registered workspace is available across projects (2026-09-25); there is no per-workspace access level. */
export interface RegisteredWorkspace { name: string; paths: string[]; aliases: string[]; sources: ProjectSource[] }
export interface WorkspaceImportPreview {
  planId: string | null;
  fingerprint: string;
  existingCount: number;
  /** Workspaces already in workspaces.json; they are never changed by an import. */
  registered: RegisteredWorkspace[];
  projects: CodexProject[];
  reason: string | null;
}
export interface WorkspaceImportResult { imported: number; paths: string[] }
export interface WorkspaceImportPlan { planId: string; fingerprint: string; paths: string[]; target: string; diff: string }
export const workspacePlanSchema = z.object({ listId: z.string().uuid(), candidateIds: z.array(z.string().uuid()).min(1).max(32000).refine(ids => new Set(ids).size === ids.length) }).strict();
