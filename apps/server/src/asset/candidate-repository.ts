import Database from "better-sqlite3";
import { assertDatabase } from "../storage/schema.js";
import type { AssetContent, NewAsset } from "./asset-repository.js";
import { RepositoryOperationError } from "./errors.js";

export type CandidateStatus = "PENDING" | "DEFERRED" | "ACCEPTED" | "REJECTED";
export type WriteOperation = "prepare" | "import" | "update" | "rewrite" | "defer" | "reject" | "accept" | "delete";
export interface CandidateRecord extends NewAsset {
  candidateId: string; number: number; intent: "NEW" | "REVISION"; version: number; baseVersion: number | null;
  status: CandidateStatus; createdAt: string; updatedAt: string;
}
export interface OperationReceipt { requestId: string; inputHash: string; operation: WriteOperation; result: unknown }
const selection = `c.id AS number, c.candidate_id AS candidateId, c.asset_id AS assetId, c.intent,
  c.asset_type AS type, c.asset_scope AS scope, c.workspace, c.title, c.summary, c.body_markdown AS bodyMarkdown,
  c.version, c.base_version AS baseVersion, c.status, c.created_at AS createdAt, c.updated_at AS updatedAt`;

export class CandidateRepository {
  constructor(readonly database: Database.Database) { assertDatabase(database); }
  list(): CandidateRecord[] {
    return this.database.prepare<[], CandidateRecord>(`SELECT ${selection} FROM asset_candidate c
      WHERE c.is_deleted = 0 AND c.status IN ('PENDING','DEFERRED') ORDER BY c.updated_at DESC,c.candidate_id DESC`).all();
  }
  get(candidateId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM asset_candidate c
      WHERE c.candidate_id=? AND c.is_deleted = 0`).get(candidateId);
  }
  byAsset(assetId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM asset_candidate c
      WHERE c.asset_id=? AND c.is_deleted = 0 AND c.status IN ('PENDING','DEFERRED')`).get(assetId);
  }
  insert(record: NewAsset & Pick<CandidateRecord, "candidateId" | "intent" | "baseVersion">): CandidateRecord {
    this.assertTransaction();
    this.database.prepare(`INSERT INTO asset_candidate
      (candidate_id,asset_id,intent,asset_type,asset_scope,workspace,title,summary,body_markdown,base_version,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING')`).run(record.candidateId, record.assetId, record.intent, record.type,
      record.scope, record.workspace, record.title, record.summary, record.bodyMarkdown, record.baseVersion);
    return this.get(record.candidateId)!;
  }
  updateContent(candidateId: string, version: number, content: AssetContent): CandidateRecord {
    this.assertTransaction();
    const current = this.get(candidateId);
    if (!current || current.version !== version || !["PENDING", "DEFERRED"].includes(current.status)) this.conflict();
    const changed = current.title !== content.title || current.summary !== content.summary || current.bodyMarkdown !== content.bodyMarkdown;
    if (changed || current.status !== "PENDING") {
      const result = this.database.prepare(`UPDATE asset_candidate SET title=?,summary=?,body_markdown=?,
        version=version+?,status='PENDING',updated_at=? WHERE candidate_id=? AND version=?
        AND status IN ('PENDING','DEFERRED') AND is_deleted = 0`).run(content.title, content.summary, content.bodyMarkdown,
        changed ? 1 : 0, new Date().toISOString(), candidateId, version);
      if (result.changes !== 1) this.conflict();
    }
    return this.get(candidateId)!;
  }
  setStatus(candidateId: string, version: number, status: CandidateStatus): CandidateRecord {
    this.assertTransaction();
    if (this.database.prepare(`UPDATE asset_candidate SET status=?,updated_at=?
      WHERE candidate_id=? AND version=? AND status IN ('PENDING','DEFERRED') AND is_deleted = 0`)
      .run(status, new Date().toISOString(), candidateId, version).changes !== 1) this.conflict();
    return this.get(candidateId)!;
  }
  receipt(requestId: string): OperationReceipt | undefined {
    const row = this.database.prepare<[string], Omit<OperationReceipt, "result"> & { resultJson: string }>(
      `SELECT request_id AS requestId,input_hash AS inputHash,operation,result_json AS resultJson
      FROM write_operation WHERE request_id=? AND is_deleted = 0`).get(requestId);
    return row ? { requestId: row.requestId, inputHash: row.inputHash, operation: row.operation, result: JSON.parse(row.resultJson) as unknown } : undefined;
  }
  write<T>(requestId: string, operation: WriteOperation, inputHash: string, fn: () => T): T {
    this.database.pragma("busy_timeout = 5000");
    try {
      return this.database.transaction(() => {
        const receipt = this.receipt(requestId);
        if (receipt) {
          if (receipt.operation !== operation || receipt.inputHash !== inputHash)
            throw new RepositoryOperationError("REQUEST_ID_CONFLICT", "同一请求标识不能用于不同内容");
          return receipt.result as T;
        }
        const result = fn();
        if (result instanceof Promise) throw new Error("Write transactions must be synchronous");
        if (result && typeof result === "object" && "status" in result &&
          (result.status === "REVIEW_REQUIRED" || result.status === "REVISION_BLOCKED")) {
          // Roll back even if a callback wrote before deciding to block.
          throw new UncommittedResult(result);
        }
        this.database.prepare("INSERT INTO write_operation (request_id,operation,input_hash,result_json) VALUES (?,?,?,?)")
          .run(requestId, operation, inputHash, JSON.stringify(result));
        return result;
      }).immediate();
    } catch (error) {
      if (error instanceof UncommittedResult) return error.result as T;
      if (error instanceof Database.SqliteError && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED"))
        throw new RepositoryOperationError("REPOSITORY_BUSY", "数据库正忙，请稍后重试");
      throw error;
    }
  }
  private conflict(): never { throw new RepositoryOperationError("VERSION_CONFLICT", "候选版本已变化或已处理"); }
  private assertTransaction(): void { if (!this.database.inTransaction) throw new Error("Candidate writes require a write transaction"); }
}
class UncommittedResult { constructor(readonly result: unknown) {} }
