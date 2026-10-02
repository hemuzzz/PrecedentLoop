import { z } from "zod";

const bounded = (min: number, max: number) => z.string().trim().refine(value => [...value].length >= min && [...value].length <= max, `须为 ${min}–${max} 个字符`);
export const knowledgeIssueSchema = z.object({
  // Identity errors skip just this issue after the assessment cache is saved.
  assetId: z.string(),
  kind: z.enum(["OUTDATED", "INACCURATE", "INCOMPLETE", "MISLEADING", "MISSED"]),
  detail: bounded(1, 500), evidence: bounded(0, 500).optional(),
  missedQueries: z.array(bounded(1, 256)).min(1).max(8).optional(),
}).strict().superRefine((issue, context) => {
  if ((issue.kind === "MISSED") !== (issue.missedQueries !== undefined))
    context.addIssue({ code: "custom", path: ["missedQueries"], message: "MISSED 必须提供 missedQueries，其他类型不得提供" });
});
export const knowledgeIssuesSchema = z.array(knowledgeIssueSchema).max(4);
export type KnowledgeIssueInput = z.infer<typeof knowledgeIssueSchema>;
