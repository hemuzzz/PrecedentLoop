import type Database from "better-sqlite3";
import { assertDatabase } from "../storage/schema.js";
import { knowledgeNumberJoin, knowledgeNumberSelection } from "./knowledge-number.js";
import { RepositoryOperationError } from "./coordination.js";

export interface CandidateRecord {
  candidateId: string; assetId: string; intent: "NEW" | "REVISION"; relativePath: string;
  contentHash: string; baselineHash: string | null; reviewBucket: "PENDING" | "DEFERRED";
  createdAt: string; updatedAt: string;
}
export interface OperationReceipt {
  requestId: string; inputHash: string; writeId: string; operation: string; result: unknown;
}
const selection = `CAST(candidate_id AS TEXT) AS candidateId, candidate.asset_id AS assetId, intent,
  relative_path AS relativePath, content_hash AS contentHash, baseline_hash AS baselineHash,
  review_bucket AS reviewBucket, created_at AS createdAt, updated_at AS updatedAt`;


export class CandidateRepository {
  constructor(readonly database: Database.Database) { assertDatabase(database); }
  list(): Array<CandidateRecord & { knowledgeNumber: number | null }> {
    return this.database.prepare<[], CandidateRecord & { knowledgeNumber: number | null }>(
      `SELECT ${selection}, ${knowledgeNumberSelection} FROM inbox_candidate AS candidate ${knowledgeNumberJoin("candidate.asset_id", true)} ORDER BY candidate_id`).all();
  }
  get(candidateId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM inbox_candidate AS candidate WHERE candidate_id = ?`).get(candidateId);
  }
  byAsset(assetId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM inbox_candidate AS candidate WHERE asset_id = ?`).get(assetId);
  }
  insert(record: Omit<CandidateRecord, "candidateId" | "createdAt" | "updatedAt" | "reviewBucket">): CandidateRecord {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO inbox_candidate
      (asset_id,intent,relative_path,content_hash,baseline_hash,review_bucket,created_at,updated_at)
      VALUES (?,?,?,?,?,'PENDING',?,?)`).run(record.assetId, record.intent, record.relativePath, record.contentHash, record.baselineHash, now, now);
    return this.byAsset(record.assetId)!;
  }
  updateContent(candidateId: string, previousHash: string, contentHash: string): void {
    if (contentHash === previousHash) return;
    const changed = this.database.prepare("UPDATE inbox_candidate SET content_hash=?, review_bucket='PENDING', updated_at=? WHERE candidate_id=? AND content_hash=?")
      .run(contentHash, new Date().toISOString(), candidateId, previousHash);
    if (changed.changes !== 1) throw new RepositoryOperationError("CONTENT_HASH_MISMATCH", "候选内容已变化");
  }
  setDeferred(candidateId: string, deferred: boolean): void {
    this.database.prepare("UPDATE inbox_candidate SET review_bucket=?,updated_at=? WHERE candidate_id=?")
      .run(deferred ? "DEFERRED" : "PENDING", new Date().toISOString(), candidateId);
  }
  remove(candidateId: string): void { this.database.prepare("DELETE FROM inbox_candidate WHERE candidate_id=?").run(candidateId); }
  receipt(requestId: string): OperationReceipt | undefined {
    const row = this.database.prepare<[string], Omit<OperationReceipt, "result"> & { resultJson: string }>(
      "SELECT request_id AS requestId,input_hash AS inputHash,write_id AS writeId,operation,result_json AS resultJson FROM inbox_operation WHERE request_id=?").get(requestId);
    return row ? { requestId: row.requestId, inputHash: row.inputHash, writeId: row.writeId, operation: row.operation, result: JSON.parse(row.resultJson) as unknown } : undefined;
  }
  saveReceipt(receipt: OperationReceipt): void {
    this.database.prepare("INSERT INTO inbox_operation VALUES (?,?,?,?,?,?)").run(receipt.requestId, receipt.inputHash,
      receipt.writeId, receipt.operation, JSON.stringify(receipt.result), new Date().toISOString());
  }
}
