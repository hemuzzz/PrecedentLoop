import Database from "better-sqlite3";
import { RepositoryOperationError } from "./coordination.js";

export interface CandidateRecord {
  candidateId: string; assetId: string; intent: "NEW" | "REVISION"; relativePath: string;
  contentHash: string; baselineHash: string | null; reviewBucket: "PENDING" | "DEFERRED";
  createdAt: string; updatedAt: string;
}
export interface OperationReceipt {
  requestId: string; inputHash: string; writeId: string; operation: string; result: unknown;
}
const selection = `CAST(candidate_id AS TEXT) AS candidateId, asset_id AS assetId, intent,
  relative_path AS relativePath, content_hash AS contentHash, baseline_hash AS baselineHash,
  review_bucket AS reviewBucket, created_at AS createdAt, updated_at AS updatedAt`;

export const CANDIDATE_SCHEMA_SQL = `
CREATE TABLE inbox_candidate (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL CHECK(intent IN ('NEW','REVISION')),
  relative_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  baseline_hash TEXT,
  review_bucket TEXT NOT NULL CHECK(review_bucket IN ('PENDING','DEFERRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((intent = 'NEW' AND baseline_hash IS NULL) OR (intent = 'REVISION' AND baseline_hash IS NOT NULL))
);
CREATE TABLE inbox_operation (
  request_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  write_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);`;

/** Explicit migration; never invoked by a GET or ordinary runtime startup. */
export function migrateCandidateStore(databasePath: string): void {
  const database = new Database(databasePath, { fileMustExist: true, timeout: 0 });
  try {
    database.transaction(() => {
      const version = Number(database.pragma("user_version", { simple: true }));
      if (version === 6) { assertCandidateStore(database); return; }
      if (version !== 5) throw new RepositoryOperationError("CANDIDATE_MIGRATION_REQUIRED", "请先完成知识与召回存储的显式迁移至版本 5");
      for (const table of ["workspace_capability", "recall_operation", "recall_item", "read_operation", "used_event", "asset_content_version"]) database.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
      database.prepare("SELECT queries_json FROM recall_operation LIMIT 0").all();
      database.exec(CANDIDATE_SCHEMA_SQL);
      database.pragma("user_version = 6");
    }).exclusive();
  } finally { database.close(); }
}

export function assertCandidateStore(database: Database.Database): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_candidate'").get() ||
      !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_operation'").get()) {
    throw new RepositoryOperationError("CANDIDATE_MIGRATION_REQUIRED", "候选管理需要先执行显式存储迁移");
  }
}

export class CandidateRepository {
  constructor(readonly database: Database.Database) { assertCandidateStore(database); }
  list(): CandidateRecord[] { return this.database.prepare<[], CandidateRecord>(`SELECT ${selection} FROM inbox_candidate ORDER BY candidate_id`).all(); }
  get(candidateId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM inbox_candidate WHERE candidate_id = ?`).get(candidateId);
  }
  byAsset(assetId: string): CandidateRecord | undefined {
    return this.database.prepare<[string], CandidateRecord>(`SELECT ${selection} FROM inbox_candidate WHERE asset_id = ?`).get(assetId);
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
