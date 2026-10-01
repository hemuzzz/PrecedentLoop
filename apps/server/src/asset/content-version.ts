import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { computeContentHash } from "./scanner.js";

export interface ContentVersion {
  status: "CURRENT" | "PREVIOUS";
  rawContent: Buffer;
  contentHash: string;
  recordedAt: string;
}

export class ContentVersionIntegrityError extends Error {
  readonly code = "CONTENT_VERSION_INTEGRITY_ERROR";
}

export const CONTENT_VERSION_TABLE_SQL = `CREATE TABLE asset_content_version (
  asset_id TEXT NOT NULL,
  version_status TEXT NOT NULL CHECK (version_status IN ('CURRENT', 'PREVIOUS')),
  raw_content BLOB NOT NULL CHECK (typeof(raw_content) = 'blob'),
  content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, version_status)
)`;

// user_version=1 marks installation of durable content storage. A missing table
// after that is damage, not an empty history. Catalog rebuild does not touch it.
export class AssetContentVersionRepository {
  readonly database: Database.Database;
  readonly #ownsDatabase: boolean;

  constructor(databasePath: string | Database.Database) {
    this.#ownsDatabase = typeof databasePath === "string";
    if (typeof databasePath === "string") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = typeof databasePath === "string" ? new Database(databasePath, { timeout: 0 }) : databasePath;
    try {
      const validate = this.database.transaction(() => {
        const installed = this.database.pragma("user_version", { simple: true });
        const table = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_content_version'").get();
        if (table === undefined) {
          if (installed !== 0) throw new ContentVersionIntegrityError("Content version table is missing");
          this.database.exec(CONTENT_VERSION_TABLE_SQL);
          this.database.pragma("user_version = 1");
        } else {
          if (![1, 2, 3, 4, 5, 6].includes(Number(installed))) throw new ContentVersionIntegrityError("Unsupported content storage version");
          // Validate the actual constraints, not just the column names.
          const sql = (table as { sql: string }).sql;
          if (sql.replace(/\s+/gu, "").toLowerCase() !== CONTENT_VERSION_TABLE_SQL.replace(/\s+/gu, "").toLowerCase()) {
            throw new ContentVersionIntegrityError("Content version schema is invalid");
          }
        }
      });
      if (this.database.readonly) validate(); else validate.immediate();
    } catch (error) {
      if (this.#ownsDatabase) this.database.close();
      throw error;
    }
  }

  close(): void { if (this.#ownsDatabase) this.database.close(); }

  read(assetId: string, maxBytes = Number.MAX_SAFE_INTEGER): ContentVersion[] | "INPUT_LIMIT_EXCEEDED" {
    return this.database.transaction(() => {
      const sizes = this.database.prepare<[string], { size: number }>(
        "SELECT length(raw_content) AS size FROM asset_content_version WHERE asset_id = ?",
      ).all(assetId);
      if (sizes.some(({ size }) => size > maxBytes)) return "INPUT_LIMIT_EXCEEDED" as const;
      const rows = this.database.prepare<[string], ContentVersion>(
        `SELECT version_status AS status, raw_content AS rawContent,
          content_hash AS contentHash, recorded_at AS recordedAt
         FROM asset_content_version WHERE asset_id = ? ORDER BY version_status`,
      ).all(assetId);
      for (const row of rows) {
        if (!Buffer.isBuffer(row.rawContent) || computeContentHash(row.rawContent) !== row.contentHash ||
          !["CURRENT", "PREVIOUS"].includes(row.status) || typeof row.recordedAt !== "string") {
          throw new ContentVersionIntegrityError("Stored content does not match its identity");
        }
      }
      if (rows.length && !rows.some(({ status }) => status === "CURRENT")) {
        throw new ContentVersionIntegrityError("Previous content has no current version");
      }
      return rows;
    })();
  }

  rotate(assetId: string, expectedHash: string | null, rawContent: Buffer): void {
    this.database.transaction(() => {
      const rows = this.read(assetId);
      if (typeof rows === "string") throw new Error("Unexpected content limit");
      const current = rows.find(({ status }) => status === "CURRENT");
      if ((current?.contentHash ?? null) !== expectedHash) {
        throw new ContentVersionIntegrityError("Current content baseline changed");
      }
      const hash = computeContentHash(rawContent);
      if (current?.contentHash === hash) return;
      this.database.prepare("DELETE FROM asset_content_version WHERE asset_id = ? AND version_status = 'PREVIOUS'").run(assetId);
      this.database.prepare("UPDATE asset_content_version SET version_status = 'PREVIOUS' WHERE asset_id = ? AND version_status = 'CURRENT'").run(assetId);
      this.database.prepare("INSERT INTO asset_content_version VALUES (?, 'CURRENT', ?, ?, ?)")
        .run(assetId, rawContent, hash, new Date().toISOString());
    })();
  }
}
