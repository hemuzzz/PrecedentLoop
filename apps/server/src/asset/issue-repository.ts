import type Database from "better-sqlite3";
import type { AssetScope, AssetType } from "./schema.js";
import { RepositoryOperationError } from "./errors.js";

export interface AssetIssue {
  issueId: string; assetId: string; assetVersion: number;
  kind: "OUTDATED" | "INACCURATE" | "INCOMPLETE" | "MISLEADING" | "MISSED" | "UNREACHABLE" | "BROKEN_REFERENCE";
  detail: string; evidence: string | null; queries: string[] | null;
  source: "CODEX" | "CLAUDE" | "RETRIEVAL_CHECK" | "REFERENCE_CHECK";
  status: "OPEN" | "DRAFTED" | "RESOLVED" | "DISMISSED";
  candidateId: string | null; createdAt: string;
}
export interface IssueCard {
  assetId: string; title: string; version: number; scope: AssetScope; workspace: string | null;
  type: AssetType; totalUsedCount: number; issues: AssetIssue[];
}
type IssueRow = Omit<AssetIssue, "queries"> & { queries: string | null };
const selection = `i.issue_id AS issueId,i.asset_id AS assetId,i.asset_version AS assetVersion,
  i.kind,i.detail,i.evidence,i.queries,i.source,i.status,i.candidate_id AS candidateId,i.created_at AS createdAt`;

export class IssueRepository {
  constructor(readonly database: Database.Database) {}
  active(assetId?: string): AssetIssue[] {
    return this.database.prepare<unknown[], IssueRow>(`SELECT ${selection} FROM asset_issue i
      JOIN asset a ON a.asset_id=i.asset_id AND a.is_deleted = 0
      WHERE i.is_deleted = 0 AND i.status IN ('OPEN','DRAFTED') ${assetId ? "AND i.asset_id=?" : ""}
      ORDER BY i.created_at DESC,i.issue_id DESC`).all(...(assetId ? [assetId] : []))
      .map(row => ({ ...row, queries: row.queries === null ? null : JSON.parse(row.queries) as string[] }));
  }
  cards(): IssueCard[] {
    const rows = this.database.prepare<[], Omit<IssueCard, "issues">>(`SELECT a.asset_id AS assetId,a.title,a.version,
      a.asset_scope AS scope,a.workspace,a.asset_type AS type,
      (SELECT count(*) FROM used_event u WHERE u.asset_id=a.asset_id AND u.is_deleted = 0) AS totalUsedCount
      FROM asset a WHERE a.is_deleted = 0 AND EXISTS
      (SELECT 1 FROM asset_issue i WHERE i.asset_id=a.asset_id AND i.is_deleted = 0 AND i.status IN ('OPEN','DRAFTED'))`).all();
    const issues = this.active();
    return rows.map(row => ({ ...row, issues: issues.filter(issue => issue.assetId === row.assetId) }))
      .sort((a, b) => b.totalUsedCount - a.totalUsedCount || b.issues[0]!.createdAt.localeCompare(a.issues[0]!.createdAt) || a.assetId.localeCompare(b.assetId));
  }
  replaceOpen(sessionId: string, turnId: string): void {
    this.assertTransaction();
    this.database.prepare(`UPDATE asset_issue SET is_deleted=1,updated_at=?
      WHERE session_id=? AND turn_id=? AND status='OPEN' AND is_deleted = 0`)
      .run(new Date().toISOString(), sessionId, turnId);
  }
  insert(issue: Pick<AssetIssue, "issueId" | "assetId" | "assetVersion" | "kind" | "detail" | "evidence" | "queries"> & {
    source: "CODEX" | "CLAUDE"; sessionId: string; turnId: string;
  }): void {
    this.assertTransaction();
    this.database.prepare(`INSERT INTO asset_issue
      (issue_id,asset_id,asset_version,kind,detail,evidence,queries,source,session_id,turn_id,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN')`).run(issue.issueId, issue.assetId, issue.assetVersion, issue.kind, issue.detail,
      issue.evidence, issue.queries === null ? null : JSON.stringify(issue.queries), issue.source, issue.sessionId, issue.turnId);
  }
  transition(issue: AssetIssue, status: AssetIssue["status"], candidateId: string | null): void {
    this.assertTransaction();
    if (this.database.prepare(`UPDATE asset_issue SET status=?,candidate_id=?,updated_at=?
      WHERE issue_id=? AND status=? AND is_deleted = 0
      AND EXISTS (SELECT 1 FROM asset a WHERE a.asset_id=asset_issue.asset_id AND a.is_deleted = 0)`)
      .run(status, candidateId, new Date().toISOString(), issue.issueId, issue.status).changes !== 1)
      throw new RepositoryOperationError("VERSION_CONFLICT", "问题已变化或已处理，请刷新后重试");
  }
  draft(assetId: string, issueIds: string[], candidateId: string): void {
    const active = this.active(assetId);
    for (const issueId of issueIds) {
      const issue = active.find(row => row.issueId === issueId && row.status === "OPEN");
      if (!issue) throw new RepositoryOperationError("VERSION_CONFLICT", "问题已变化，请重新起草修订");
      this.transition(issue, "DRAFTED", candidateId);
    }
  }
  resolve(assetId: string): void {
    for (const issue of this.active(assetId)) this.transition(issue, "RESOLVED", issue.candidateId);
  }
  reopen(assetId: string, candidateId: string): void {
    for (const issue of this.active(assetId)) if (issue.status === "DRAFTED" && issue.candidateId === candidateId)
      this.transition(issue, "OPEN", null);
  }
  private assertTransaction(): void { if (!this.database.inTransaction) throw new Error("Issue writes require a write transaction"); }
}
