import type Database from "better-sqlite3";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { AssetRepository, type AssetRecord } from "./asset-repository.js";
import { CandidateRepository, type CandidateRecord } from "./candidate-repository.js";
import { IssueRepository } from "./issue-repository.js";
import { RepositoryOperationError } from "./errors.js";

export interface CheckTarget { kind: "ASSET" | "CANDIDATE"; id: string }
export interface CheckQuestion { question: string; queries: string[]; hit: boolean; rank: number | null }
export interface RetrievalCheck extends CheckTarget { checkId: string; version: number; result: CheckQuestion[]; passed: boolean }
export interface CheckSnapshot extends CheckTarget { content: AssetRecord | CandidateRecord }
export interface CheckOutcome extends RetrievalCheck { title: string }
export interface RetrievalCheckResult { done: number; total: number; items: CheckOutcome[] }

export class RetrievalCheckRepository {
  readonly ids = new SnowflakeIdGenerator();
  constructor(readonly database: Database.Database) {}
  latest(target: CheckTarget, version: number): RetrievalCheck | null {
    const row = this.database.prepare<[string, string, number], { checkId: string; result: string; passed: number }>(`
      SELECT check_id AS checkId,result,passed FROM retrieval_check
      WHERE target_kind=? AND target_id=? AND target_version=? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`)
      .get(target.kind, target.id, version);
    return row ? { ...target, version, checkId: row.checkId, result: JSON.parse(row.result) as CheckQuestion[], passed: row.passed === 1 } : null;
  }
  targets(workspaces: readonly string[], target?: CheckTarget): CheckSnapshot[] {
    const assets = new AssetRepository(this.database), candidates = new CandidateRepository(this.database);
    const all: CheckSnapshot[] = [
      ...assets.list(workspaces).map(content => ({ kind: "ASSET" as const, id: content.assetId, content })),
      ...candidates.list().filter(row => row.scope === "GLOBAL" || workspaces.includes(row.workspace!))
        .map(content => ({ kind: "CANDIDATE" as const, id: content.candidateId, content })),
    ];
    if (target) {
      const found = all.find(row => row.kind === target.kind && row.id === target.id);
      if (!found) throw new RepositoryOperationError("ASSET_NOT_FOUND", "自测目标不存在、已处理或工作区未登记");
      return [found];
    }
    return all.filter(row => !this.latest(row, row.content.version));
  }
  // Called after AI and file scans, with all writes for a batch in one short transaction.
  commit(batch: Array<{ target: CheckSnapshot; result: CheckQuestion[]; brokenPaths: string[] }>): CheckOutcome[] {
    return this.database.transaction(() => {
      const assets = new AssetRepository(this.database), candidates = new CandidateRepository(this.database), issues = new IssueRepository(this.database);
      return batch.map(({ target, result, brokenPaths }) => {
        const current = target.kind === "ASSET" ? assets.get(target.id) : candidates.get(target.id);
        if (!current || current.version !== target.content.version || ("status" in current && !["PENDING", "DEFERRED"].includes(current.status)))
          throw new RepositoryOperationError("VERSION_CONFLICT", "自测目标已变化，本批未提交，请重新执行");
        const check: CheckOutcome = { kind: target.kind, id: target.id, version: current.version, title: current.title,
          checkId: this.ids.next("chk"), result, passed: result.every(item => item.hit) };
        this.database.prepare(`INSERT INTO retrieval_check (check_id,target_kind,target_id,target_version,result,passed)
          VALUES (?,?,?,?,?,?)`).run(check.checkId, check.kind, check.id, check.version, JSON.stringify(result), Number(check.passed));
        if (target.kind === "ASSET") {
          const missed = result.filter(item => !item.hit);
          if (missed.length) issues.upsertCheckIssue({ assetId: target.id, assetVersion: current.version,
            kind: "UNREACHABLE", source: "RETRIEVAL_CHECK", checkId: check.checkId,
            detail: `3 个问法中 ${missed.length} 个未进入前 8\n${missed.map(item => item.question).join("\n")}`,
            queries: [...new Set(missed.flatMap(item => item.queries))] });
          if (brokenPaths.length) issues.upsertCheckIssue({ assetId: target.id, assetVersion: current.version,
            kind: "BROKEN_REFERENCE", source: "REFERENCE_CHECK", checkId: null,
            detail: `以下引用文件不存在：\n${brokenPaths.join("\n")}`, queries: null });
        }
        return check;
      });
    }).immediate();
  }
}
