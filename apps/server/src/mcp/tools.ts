import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CandidateService } from "../asset/candidate-service.js";
import type { WorkspaceCapabilityService } from "../workspace/capability.js";
import { candidatePrepareInputSchema, candidateUpdateInputSchema, prepareStructuredCandidate, updateStructuredCandidate } from "../asset/structured-candidate.js";
import { RepositoryOperationError } from "../asset/coordination.js";
import { StructuredCandidateError } from "../asset/structured-candidate-checks.js";
import { assetIdSchema } from "../asset/schema.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { KnowledgeError, recallInputSchema, readInputSchema, usedInputSchema, capabilityIdsSchema, referenceSchema, hashSchema } from "../knowledge/model.js";
import { AssetConfirmationError, AssetNotAccessibleError, AssetNotFoundError, AssetSearchUnavailableError } from "../asset/index.js";
export { recallInputSchema };
// MCP requires an object root; services retain the strict mutually exclusive unions.
export const assetReadToolInputSchema = z.object({
  capabilityIds: capabilityIdsSchema,
  recallItemId: referenceSchema.optional(),
  assetId: assetIdSchema.optional(),
  expectedContentHash: hashSchema.optional(),
}).strict().refine((input) => readInputSchema.safeParse(input).success,
  { message: "Provide either recallItemId or assetId with optional expectedContentHash." });
export const assetMarkUsedToolInputSchema = z.object({
  capabilityIds: capabilityIdsSchema,
  recallItemId: referenceSchema.optional(),
  readRef: referenceSchema.optional(),
}).strict().refine((input) => usedInputSchema.safeParse(input).success,
  { message: "Provide exactly one of recallItemId or readRef." });
export interface AssetMcpDependencies {
  knowledgeService: KnowledgeService; onInternalError?: (error: unknown) => void;
  candidateService: CandidateService;
  capabilities: WorkspaceCapabilityService;
  onCandidateWritten?: () => void;
}
export function createAssetMcpServer(dependencies: AssetMcpDependencies): McpServer {
  const server = new McpServer({ name: "precedent", version: "2.4.0" });
  const notifyCandidateWritten = (): void => {
    try { dependencies.onCandidateWritten?.(); }
    catch (error) {
      try {
        if (dependencies.onInternalError) dependencies.onInternalError(error);
        else console.error(JSON.stringify({ event: "open_inbox_error", name: error instanceof Error ? error.name : typeof error }));
      }
      catch { /* Logging must not turn an already committed candidate into an error. */ }
    }
  };
  const execute = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      // Exactly one serialized representation: no duplicate structuredContent.
      return { content: [{ type: "text", text: JSON.stringify(await operation()) }] };
    } catch (error) {
      let code = "INTERNAL_ERROR";
      if (error instanceof KnowledgeError) code = error.code;
      else if (error instanceof RepositoryOperationError || error instanceof AssetConfirmationError) code = error.code;
      else if (error instanceof AssetNotAccessibleError || error instanceof AssetNotFoundError) code = "ASSET_NOT_ACCESSIBLE";
      else if (error instanceof AssetSearchUnavailableError) code = error.reason === "WORKSPACE_CONFIGURATION" ? "WORKSPACE_CONFIG_UNAVAILABLE" : "ASSET_INDEX_UNAVAILABLE";
      else dependencies.onInternalError?.(error);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, ...(error instanceof StructuredCandidateError ? { field: error.field } : {}) } }) }] };
    }
  };
  server.registerTool("knowledge_recall", { description: "Recall knowledge using 1–8 complete literal expressions in queries, matched as case-insensitive substrings with OR across items. Spaces and punctuation are literal, never implicit AND, regex, or Boolean syntax. Reuse visible, applicable native search expressions for the same purpose without rewriting or dropping them; append only evidence-backed alternatives. Otherwise derive precise names, identifiers or phrases from the request; native search is not a prerequisite. One deduplicated result shares the 8-asset/5000-character budget. Explicit capabilityIds selects scope; [] selects GLOBAL only.", inputSchema: recallInputSchema, _meta: { "anthropic/alwaysLoad": true } },
    async (input) => execute(() => dependencies.knowledgeService.recall(input)));
  server.registerTool("asset_read", { description: "Read qualified current content. Pass the same capabilityIds used for the recall, plus exactly one target: recallItemId, or assetId with optional expectedContentHash. Knowledge is a historical judgment; verify current target evidence before describing current behavior, editing or troubleshooting. Use returned contentHash as candidate_prepare revision.baselineHash.", inputSchema: assetReadToolInputSchema },
    async (input) => execute(() => dependencies.knowledgeService.read(input)));
  server.registerTool("asset_mark_used", { description: "Explicitly settle a persistent source that influenced work. Pass the same capabilityIds used for the recall, plus exactly one of recallItemId or readRef. Content evolution does not invalidate Used. Only mark knowledge that actually influenced analysis, decisions, implementation or review; recall or reading alone does not count.", inputSchema: assetMarkUsedToolInputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false } },
    async (input) => execute(() => dependencies.knowledgeService.used(input)));
  server.registerTool("candidate_prepare", { description: "准备结构化 Inbox 候选，不确认或覆盖正式知识。写入前比对全部待审候选（PENDING 与 DEFERRED，NEW 与 REVISION，不分范围）；已有提交回执的请求直接返回原结果。REVIEW_REQUIRED 是正常结果：已覆盖就不写并记录 NO_INCREMENT，写明候选编号；与某条属于同一主题（补充、更正或推翻）时，通过 candidate_update 修改那条候选，范围须与那条候选相符；主题不同、能独立成立，才带覆盖当前清单的 reviewedCandidateIds 重试。状态异常的候选标记 problem: true，不附正文，仍须包含在 reviewedCandidateIds 中。清单只在附正文时返回 candidateHash，缺少正文或 problem: true 的清单项不提供 Hash；修改也可使用 candidate_prepare／candidate_update 返回的 contentHash。不要在聊天中询问用户。返回的 display 可直接展示，正式入库仍需 Hub 人工审核。", inputSchema: candidatePrepareInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false } }, async input => execute(async () => {
      const result = await prepareStructuredCandidate(input, dependencies.candidateService, dependencies.capabilities);
      if ("display" in result) {
        notifyCandidateWritten();
        if (dependencies.onCandidateWritten) result.display = result.display.replace(/请在 Hub 候选管理中审核（接受入库｜修改｜暂存｜拒绝）$/u, "已在 Precedent Loop 中打开候选页，请审核（接受入库｜修改｜暂存｜拒绝）");
      }
      return result;
    }));
  server.registerTool("candidate_update", { description: "修改已有的待审候选（包括暂存候选），用于同一主题的补充、更正或改写。提交修改后的完整 title、summary、bodyMarkdown（不含 Frontmatter）：仍然成立的结论、条件和依据要保留；已过时或被推翻的内容直接改写或删除，不要只在末尾追加与原文矛盾的说明。使用附正文的 REVIEW_REQUIRED 清单项中的 candidateId、candidateHash，或 candidate_prepare／candidate_update 返回的 candidateId、contentHash，以及与候选范围一致的 capabilityIds；缺少正文或 problem: true 的清单项不提供 Hash。类型、范围、Asset ID、修订基线保持不变；类型或范围需要改变时，改用 candidate_prepare 写新候选。修改后回到待审，原来暂存的也一样。不要在聊天中询问用户。返回的 display 可直接展示，正式入库仍需 Hub 人工审核。", inputSchema: candidateUpdateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false } }, async input => execute(async () => {
      const result = await updateStructuredCandidate(input, dependencies.candidateService, dependencies.capabilities);
      notifyCandidateWritten();
      if (dependencies.onCandidateWritten) result.display = `已修改候选 #${result.candidateId}，已回到待审，已在 Precedent Loop 中打开候选页`;
      return result;
    }));
  return server;
}
