import type Database from "better-sqlite3";
import { assertDatabase, CONTENT_VERSION_TABLE_SQL, openDatabase } from "../storage/schema.js";
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

export class AssetContentVersionRepository {
  readonly database: Database.Database;
  readonly #ownsDatabase: boolean;

  constructor(databasePath: string | Database.Database) {
    this.#ownsDatabase = typeof databasePath === "string";
    this.database = typeof databasePath === "string" ? openDatabase(databasePath, { timeout: 0 }) : databasePath;
    try {
      const validate = this.database.transaction(() => {
        assertDatabase(this.database);
        const table = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_content_version'").get();
        if (table === undefined) {
          throw new ContentVersionIntegrityError("Content version table is missing");
        } else {
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
