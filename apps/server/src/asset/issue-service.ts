import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";
import { openDatabase } from "../storage/schema.js";
import { AssetRepository } from "./asset-repository.js";
import { CandidateRepository } from "./candidate-repository.js";
import { IssueRepository } from "./issue-repository.js";
import { RepositoryOperationError } from "./errors.js";
import { assetIdSchema, issueIdSchema } from "./schema.js";
import { knowledgeIssueSchema } from "./issue-schema.js";
export interface IssueRecordResult { recorded: number; skipped: Array<{ index: number; code: string }> }
export interface IssueDraft { assetId: string; assetVersion: number; issueIds: string[]; requestHash: string; explanation: string }

export class IssueService {
  constructor(readonly databasePath: string) {}
  record(input: { sessionId: string; turnId: string; knowledgeIssues: unknown[] }, source: "CODEX" | "CLAUDE"): IssueRecordResult {
    const inputs = input.knowledgeIssues;
    const database = openDatabase(this.databasePath, { timeout: 1000 });
    try { return database.transaction(() => {
      const issues = new IssueRepository(database), assets = new AssetRepository(database), ids = new SnowflakeIdGenerator();
      const result: IssueRecordResult = { recorded: 0, skipped: [] };
      issues.replaceOpen(input.sessionId, input.turnId);
      for (const [index, value] of inputs.entries()) {
        if (index >= 4) { result.skipped.push({ index, code: "TOO_MANY_ISSUES" }); continue; }
        const parsed = knowledgeIssueSchema.safeParse(value);
        if (!parsed.success) { result.skipped.push({ index, code: "ISSUE_INVALID" }); continue; }
        const issue = parsed.data;
        if (!assetIdSchema.safeParse(issue.assetId).success) { result.skipped.push({ index, code: "ASSET_ID_INVALID" }); continue; }
        const asset = assets.get(issue.assetId);
        if (!asset) { result.skipped.push({ index, code: "ASSET_NOT_FOUND" }); continue; }
        issues.insert({ ...issue, issueId: ids.next("isu"), assetVersion: asset.version, source,
          sessionId: input.sessionId, turnId: input.turnId, evidence: issue.evidence ?? null, queries: issue.missedQueries ?? null });
        result.recorded++;
      }
      return result;
    }).immediate(); } finally { database.close(); }
  }
  dismiss(input: unknown) {
    const { issueId } = z.object({ issueId: issueIdSchema }).strict().parse(input);
    const database = openDatabase(this.databasePath);
    try { return database.transaction(() => {
      const repository = new IssueRepository(database);
      const issue = repository.active().find(row => row.issueId === issueId);
      if (!issue) throw new RepositoryOperationError("VERSION_CONFLICT", "问题已变化或已处理，请刷新后重试");
      repository.transition(issue, "DISMISSED", issue.candidateId);
      return { dismissed: true, issueId };
    }).immediate(); } finally { database.close(); }
  }
  draftInput(assetId: string) {
    assetIdSchema.parse(assetId);
    const database = openDatabase(this.databasePath, { readonly: true });
    try { return database.transaction(() => {
      const asset = new AssetRepository(database).get(assetId);
      if (!asset) throw new RepositoryOperationError("ASSET_NOT_FOUND", "正式知识不存在或已删除");
      const issues = new IssueRepository(database).active(assetId).filter(issue => issue.status === "OPEN");
      if (!issues.length) throw new RepositoryOperationError("VERSION_CONFLICT", "没有待处理问题，请刷新后重试");
      return { asset, issues, candidate: new CandidateRepository(database).byAsset(assetId) };
    })(); } finally { database.close(); }
  }
}
