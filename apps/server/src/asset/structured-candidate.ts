import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";
import { assetIdSchema, assetTypeSchema } from "./schema.js";
import { candidateSelectionSchema, contentFieldsSchema, versionSchema, inputHash, matchesTarget, requestIdSchema, type CandidateBatchResult, type CandidateService, type CandidateTarget } from "./candidate-service.js";
import { RepositoryOperationError } from "./errors.js";
import { loadWorkspaceConfigSync } from "../workspace/config.js";
import { capabilityIdsSchema } from "../knowledge/model.js";
import type { WorkspaceCapabilityService } from "../workspace/capability.js";
import { checkStructuredContent, checkRelatedAssets } from "./structured-candidate-checks.js";

const text = z.string().trim().min(1).max(256_000);
export const fields = {
  conclusion: text.optional().describe("MEMORY 必填：明确结论，区分规范、历史观察或某时点实现。"),
  conditions: text.optional().describe("MEMORY 必填：适用项目、环境、前提及主要不适用情况。"),
  reasons: text.optional().describe("MEMORY：理由与代价，不编造备选方案。"),
  verified: text.optional().describe("MEMORY 必填：实际验证对象、方式、结果；没有运行写未运行。"),
  unverified: text.optional().describe("MEMORY：尚未核实的内容与边界。"),
  recheckPoints: text.optional().describe("MEMORY 或 SKILL：再次使用须核对的决定性前提。"),
  trigger: text.optional().describe("SKILL 必填：何时使用这个已验证的可重复流程。"),
  prerequisites: text.optional().describe("SKILL：输入与前置条件。"),
  steps: z.array(text).min(1).optional().describe("SKILL 必填：按执行顺序排列的步骤，至少一步。"),
  verification: text.optional().describe("SKILL 必填：如何确认执行正确。"),
  stopConditions: text.optional().describe("SKILL：何时停止或转人工。"),
  purpose: text.optional().describe("DOCUMENT 必填：什么时候查阅这份参考资料。"),
  coverage: text.optional().describe("DOCUMENT 必填：覆盖与不覆盖的范围及内容截至时间。"),
  bodyMarkdown: text.optional().describe("DOCUMENT 必填：自然章节正文，不含 Frontmatter。"),
};
export const allowed: Record<"MEMORY" | "SKILL" | "DOCUMENT", Array<keyof typeof fields>> = {
  MEMORY: ["conclusion", "conditions", "reasons", "verified", "unverified", "recheckPoints"],
  SKILL: ["trigger", "prerequisites", "steps", "verification", "stopConditions", "recheckPoints"],
  DOCUMENT: ["purpose", "coverage", "bodyMarkdown"],
};
export const required: typeof allowed = { MEMORY: ["conclusion", "conditions", "verified"], SKILL: ["trigger", "steps", "verification"], DOCUMENT: ["purpose", "coverage", "bodyMarkdown"] };
export const evidenceFields = {
  supports: text.describe("材料支持哪项判断。"),
  kind: z.enum(["EXCERPT", "EXPLANATION", "INFERENCE", "EXAMPLE"]).describe("区分原文摘录、解释、推断与示例。"),
  processing: z.enum(["ORIGINAL", "PARTIAL", "REDACTED", "PARAPHRASED"]).optional().describe("摘录必填：原始、分段、脱敏或转写。"),
  content: text.describe("只保存足以检查判断的最小材料；不足时缩小结论。"),
  sourceHint: text.optional().describe("可选的项目、相对路径、符号或章节线索。"),
  sourceTime: text.optional().describe("材料所述时间；未知不填，不要推测。"),
};
export const evidenceSchema = z.array(z.object(evidenceFields).strict().refine(value => value.kind !== "EXCERPT" || value.processing !== undefined, { path: ["processing"], message: "摘录必须标明处理方式" })).optional().describe("必要历史依据；区分事实、推断和示例，不编造材料。");
export const candidatePrepareInputSchema = z.object({
  capabilityIds: capabilityIdsSchema.max(1).describe("目标范围：[] 为全局，恰好一个能力为对应工作区。只有同时满足“换一个业务不同的项目仍能直接使用”和“不提本项目的名称、路径、业务术语也能完整表述”时才用全局；拿不准就用工作区；两边都沾时拆成两条候选。"),
  reviewedCandidateIds: z.array(candidateSelectionSchema.shape.candidateId).optional().describe("已逐条比对的待审候选业务 ID（cnd…），必须覆盖 REVIEW_REQUIRED 清单中的全部 candidateId；只在内容能独立成立时带此字段重试。"),
  type: assetTypeSchema.describe("默认 MEMORY 保存判断；已验证可重复流程用 SKILL；参考资料用 DOCUMENT。"),
  title: text.max(300).describe("知识标题，明确独立可复用的主题。"),
  summary: text.max(4000).describe("摘要与结论一致，保留关键前提。"),
  revision: z.object({ assetId: assetIdSchema.describe("待修订正式知识的 ID。"), baseVersion: versionSchema.describe("召回或读取返回的 version。") }).strict().optional().describe("修订时同时提供 assetId 与 baseVersion；不填表示新增。"),
  ...fields,
  evidence: evidenceSchema,
  related: z.array(z.object({ assetId: assetIdSchema.describe("当前正式知识 ID，仅允许目标范围或 GLOBAL。"), relation: text.describe("用一句话说明与本候选的关系。") }).strict()).optional().describe("库内相关知识，服务端核对当前资格与范围并填入标题。"),
  requestId: requestIdSchema.optional().describe("幂等键；省略由服务端生成并返回，重试复用同一键和输入。"),
}).strict().superRefine((value, context) => {
  for (const name of Object.keys(fields) as Array<keyof typeof fields>) {
    if (value[name] !== undefined && !allowed[value.type].includes(name)) context.addIssue({ code: "custom", path: [name], message: "此类型不允许该字段" });
    if (value[name] === undefined && required[value.type].includes(name)) context.addIssue({ code: "custom", path: [name], message: "此类型必须提供该字段" });
  }
  if (value.type === "DOCUMENT" && /^---\s*\n/u.test(value.bodyMarkdown ?? "")) context.addIssue({ code: "custom", path: ["bodyMarkdown"], message: "正文不得含 Frontmatter" });
});
export type StructuredCandidateInput = z.infer<typeof candidatePrepareInputSchema>;
export type StructuredContent = Pick<StructuredCandidateInput, "type" | "title" | "summary" | "evidence" | "revision" | keyof typeof fields>;

export function normalizeStructuredContent(input: StructuredContent): StructuredContent {
  const { type, title, summary, evidence, revision } = input;
  return { type, title, summary, evidence, revision,
    ...Object.fromEntries(allowed[type].map(name => [name, input[name]])) };
}

export const candidateUpdateInputSchema = z.object({
  capabilityIds: capabilityIdsSchema.max(1).describe("必须对应被修改候选的范围：全局候选传 []，工作区候选恰好传该工作区的能力。"),
  candidateId: candidateSelectionSchema.shape.candidateId.describe("要修改的待审候选业务 ID（cnd…）；number 仅用于显示候选 #N。"),
  candidateVersion: versionSchema.describe("REVIEW_REQUIRED 附正文清单项中的 candidateVersion，或 candidate_prepare／candidate_update 返回的 version；"),
  title: contentFieldsSchema.shape.title.describe("修改后的完整标题。"),
  summary: contentFieldsSchema.shape.summary.describe("修改后的完整摘要，与正文结论一致。"),
  bodyMarkdown: contentFieldsSchema.shape.bodyMarkdown.describe("修改后的完整正文，不含 Frontmatter；保留仍然成立的结论、条件和依据。"),
  requestId: requestIdSchema.optional().describe("幂等键；省略由服务端生成并返回，重试复用同一键和输入。"),
}).strict().refine(value => !/^---\s*\n/u.test(value.bodyMarkdown), { path: ["bodyMarkdown"], message: "正文不得含 Frontmatter" });

export const candidateReviewInstruction = "逐条比对以上待审候选：已覆盖就不写，本轮评估记为 NO_INCREMENT 并写明候选编号；与某条属于同一主题（补充、更正或推翻其结论），就用 candidate_update 修改那条候选，范围须与那条候选相符；主题不同、能独立成立，才带 reviewedCandidateIds 重新调用 candidate_prepare。";

export function pendingCandidateComparison(pending: Awaited<ReturnType<CandidateService["pendingCandidates"]>>) {
  let remaining = 30_000; let omittedBodies = 0;
  const pendingCandidates = pending.map(({ record }) => {
    const item = { candidateId: record.candidateId, number: record.number, assetId: record.assetId, type: record.type,
      scope: record.scope, workspace: record.workspace, status: record.status, title: record.title, summary: record.summary };
    const length = [...record.bodyMarkdown].length;
    if (omittedBodies > 0 || length > remaining) { omittedBodies++; return { ...item, bodyOmitted: true as const }; }
    remaining -= length;
    return { ...item, bodyMarkdown: record.bodyMarkdown, candidateVersion: record.version };
  });
  return { pendingCandidates, omittedBodies };
}

export function renderStructuredCandidate(input: StructuredContent, related: Array<{ title: string; assetId: string; relation: string }>, retainedAt: string, origin: "会话" | "导入" = "会话"): string {
  const sections = [`# ${input.title}`];
  const section = (name: string, value: string | undefined) => { if (value) sections.push(`## ${name}\n\n${value}`); };
  if (input.type === "MEMORY") {
    section("结论与适用条件", `${input.conclusion}\n\n${input.conditions}`);
    section("理由与取舍", input.reasons);
    section("依据与验证边界", `已验证：${input.verified}${input.unverified ? `\n\n未验证：${input.unverified}` : ""}`);
  } else if (input.type === "SKILL") {
    section("触发", input.trigger); section("输入与前置条件", input.prerequisites);
    section("步骤", input.steps!.map((step, index) => `${index + 1}. ${step.replaceAll("\n", "\n   ")}`).join("\n\n"));
    section("验证", input.verification); section("停止条件", input.stopConditions);
    section("再次使用时的核验点", input.recheckPoints);
  } else { section("用途与范围", `${input.purpose}\n\n${input.coverage}`); sections.push(input.bodyMarkdown!); }
  const kinds = { EXCERPT: "摘录", EXPLANATION: "解释", INFERENCE: "推断", EXAMPLE: "示例" };
  const processing = { ORIGINAL: "原始", PARTIAL: "分段", REDACTED: "脱敏", PARAPHRASED: "转写" };
  section("历史依据", input.evidence?.map((item, index) => {
    const fence = "`".repeat(Math.max(3, ...[...item.content.matchAll(/`+/gu)].map(match => match[0].length + 1)));
    return `### 依据 ${index + 1}：${item.supports}\n\n材料：${kinds[item.kind]}${item.processing ? `；处理：${processing[item.processing]}` : ""}\n\n留存：${retainedAt}，本次${origin}提交${item.sourceTime ? `\n\n材料所述时间：${item.sourceTime}` : ""}${item.sourceHint ? `\n\n来源线索：${item.sourceHint}` : ""}\n\n${fence}text\n${item.content}\n${fence}`;
  }).join("\n\n"));
  if (input.type === "MEMORY") section("再次使用时的核验点", input.recheckPoints);
  section("相关知识", related.map(item => `${item.title}（${item.assetId}）：${item.relation}`).join("\n\n"));
  if (input.type === "MEMORY" && input.revision) section("本次变更说明", `修订自基线 ${input.revision.baseVersion}`);
  return sections.join("\n\n");
}

export async function prepareStructuredCandidate(rawInput: unknown, candidates: CandidateService, capabilities: WorkspaceCapabilityService) {
  const input = candidatePrepareInputSchema.parse(rawInput);
  const content = normalizeStructuredContent(input);
  const selection = await capabilities.select(input.capabilityIds);
  const target: CandidateTarget = selection.authorizedWorkspaces.length ? { scope: "WORKSPACE", workspace: selection.authorizedWorkspaces[0]! } : { scope: "GLOBAL" };
  checkStructuredContent({ ...content, related: input.related });
  const requestId = input.requestId ?? new SnowflakeIdGenerator().next("tsk");
  const { reviewedCandidateIds, ...contentInput } = input;
  const requestInput = { structuredCandidate: { ...contentInput, requestId }, target };
  const receipt = await candidates.receipt(requestId);
  let result: Awaited<ReturnType<CandidateService["prepare"]>>;
  if (receipt) {
    if (receipt.inputHash !== inputHash({ operation: "prepare", input: requestInput })) throw new RepositoryOperationError("REQUEST_ID_CONFLICT", "同一请求标识不能用于不同内容");
    result = receipt.result as CandidateBatchResult;
  } else {
    const related = checkRelatedAssets(input.related ?? [], target, await candidates.formalAssets());
    result = await candidates.prepare(requestId, [{ type: input.type, title: input.title, summary: input.summary, target,
      bodyMarkdown: renderStructuredCandidate(content, related, new Date().toISOString()),
      ...(input.revision ? { existingAssetId: input.revision.assetId, baseVersion: input.revision.baseVersion } : {}) }], {
      operation: "prepare", requestInput,
      beforeWrite(repository, assets) {
        // The review list and related qualification are checked inside the committing transaction.
        const workspaces = loadWorkspaceConfigSync(candidates.options.workspaceConfigPath).workspaces.map(workspace => workspace.name);
        checkRelatedAssets(input.related ?? [], target, assets.list(workspaces));
        const pending = repository.list().filter(record => record.scope === "GLOBAL" || workspaces.includes(record.workspace!)).map(record => ({ record }));
        if (pending.some(({ record }) => !new Set(reviewedCandidateIds).has(record.candidateId)))
          return { status: "REVIEW_REQUIRED", instruction: candidateReviewInstruction, ...pendingCandidateComparison(pending) };
        return undefined;
      },
    });
  }
  if ("status" in result) return result;
  const candidate = result.candidates[0]!;
  const display = `**${target.scope === "GLOBAL" ? "GLOBAL" : target.workspace} · 知识候选**\n\n**【标题】** ${input.title}\n\n**【摘要】** ${input.summary}\n\n**【原因】** ${candidate.intent === "NEW" ? "建议新增，提交内容待人工审核" : "建议修订，基于已提供的正式基线"}\n\n候选 #${candidate.number}，请在 Hub 候选管理中审核（接受入库｜修改｜暂存｜拒绝）`;
  return { ...candidate, requestId, display };
}

export async function updateStructuredCandidate(rawInput: unknown, candidates: CandidateService, capabilities: WorkspaceCapabilityService) {
  const input = candidateUpdateInputSchema.parse(rawInput);
  const selection = await capabilities.select(input.capabilityIds);
  const target: CandidateTarget = selection.authorizedWorkspaces.length ? { scope: "WORKSPACE", workspace: selection.authorizedWorkspaces[0]! } : { scope: "GLOBAL" };
  const requestId = input.requestId ?? new SnowflakeIdGenerator().next("tsk");
  const requestInput = { candidateUpdate: { ...input, requestId }, target };
  const receipt = await candidates.receipt(requestId);
  if (receipt) {
    if (receipt.inputHash !== inputHash({ operation: "update", input: requestInput })) throw new RepositoryOperationError("REQUEST_ID_CONFLICT", "同一请求标识不能用于不同内容");
    const result = receipt.result as Awaited<ReturnType<CandidateService["rewrite"]>>;
    return { ...result, requestId, display: `已修改候选 #${result.number}，已回到待审，请在 Hub 候选管理中审核` };
  }
  const candidate = (await candidates.pendingCandidates()).find(({ record }) => record.candidateId === input.candidateId)?.record;
  if (!candidate) throw new RepositoryOperationError("CANDIDATE_NOT_FOUND", "候选不存在");
  if (!matchesTarget(candidate, target)) throw new RepositoryOperationError("CAPABILITY_INVALID", "能力与候选范围不符");
  const fields = { title: input.title, summary: input.summary, bodyMarkdown: input.bodyMarkdown };
  checkStructuredContent(fields);
  const result = await candidates.rewrite({ requestId, candidateId: input.candidateId, candidateVersion: input.candidateVersion, assetId: candidate.assetId }, fields, requestInput, "update");
  return { ...result, requestId, display: `已修改候选 #${result.number}，已回到待审，请在 Hub 候选管理中审核` };
}
