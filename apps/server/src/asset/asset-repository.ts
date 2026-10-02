import type Database from "better-sqlite3";
import { storedRetrievalTermsSchema, retrievalTermsSchema, type AssetScope, type AssetType } from "./schema.js";
import { RepositoryOperationError } from "./errors.js";

export interface AssetContent { title: string; summary: string; retrievalTerms: string[]; bodyMarkdown: string }
export interface PreviousContent extends AssetContent { updatedAt: string }
export interface AssetRecord extends AssetContent {
  assetId: string; knowledgeNumber: number; type: AssetType; scope: AssetScope; workspace: string | null;
  version: number; previousContent: PreviousContent | null; createdAt: string; updatedAt: string;
}
export type NewAsset = AssetContent & Pick<AssetRecord, "assetId" | "type" | "scope" | "workspace">;
type AssetRow = Omit<AssetRecord, "previousContent" | "retrievalTerms"> & { previousContent: string | null; retrievalTerms: string };
const selection = `a.id AS knowledgeNumber, a.asset_id AS assetId, a.asset_type AS type, a.asset_scope AS scope,
  a.workspace, a.title, a.summary, a.retrieval_terms AS retrievalTerms, a.body_markdown AS bodyMarkdown, a.version,
  a.previous_content AS previousContent, a.created_at AS createdAt, a.updated_at AS updatedAt`;
const map = (row: AssetRow): AssetRecord => {
  const previous = row.previousContent === null ? null : JSON.parse(row.previousContent) as PreviousContent;
  return { ...row, retrievalTerms: storedRetrievalTermsSchema.parse(JSON.parse(row.retrievalTerms)),
    previousContent: previous && { ...previous, retrievalTerms: storedRetrievalTermsSchema.parse(previous.retrievalTerms ?? []) } };
};
export interface TermsBackfillItem { assetId: string; version: number; retrievalTerms: string[] }

export class AssetRepository {
  constructor(readonly database: Database.Database) {}

  get(assetId: string): AssetRecord | undefined {
    const row = this.database.prepare<[string], AssetRow>(`SELECT ${selection} FROM asset a WHERE a.asset_id=? AND a.is_deleted = 0`).get(assetId);
    return row && map(row);
  }

  list(workspaces: readonly string[]): AssetRecord[] {
    return this.database.prepare<string[], AssetRow>(`SELECT ${selection} FROM asset a
      WHERE a.is_deleted = 0 AND (a.asset_scope='GLOBAL'${workspaces.length ? ` OR a.workspace IN (${workspaces.map(() => "?").join(",")})` : ""})
      ORDER BY a.updated_at DESC, a.asset_id`).all(...workspaces).map(map);
  }

  search(workspaces: readonly string[], ftsQuery?: string): Array<AssetRecord & { bm25: number | null }> {
    const values = [...workspaces];
    if (ftsQuery !== undefined) values.push(ftsQuery);
    return this.database.prepare<string[], AssetRow & { bm25: number | null }>(`SELECT ${selection}, ${ftsQuery === undefined ? "NULL" : "bm25(asset_fts)"} AS bm25
      FROM asset a ${ftsQuery === undefined ? "" : "JOIN asset_fts ON asset_fts.asset_id=a.asset_id"}
      WHERE a.is_deleted = 0 AND (a.asset_scope='GLOBAL'${workspaces.length ? ` OR a.workspace IN (${workspaces.map(() => "?").join(",")})` : ""})
      ${ftsQuery === undefined ? "" : "AND asset_fts MATCH ?"}`).all(...values).map(row => ({ ...map(row), bm25: row.bm25 }));
  }

  insert(input: NewAsset): AssetRecord {
    this.assertTransaction();
    input = { ...input, retrievalTerms: storedRetrievalTermsSchema.parse(input.retrievalTerms) };
    this.database.prepare(`INSERT INTO asset (asset_id,asset_type,asset_scope,workspace,title,summary,retrieval_terms,body_markdown)
      VALUES (?,?,?,?,?,?,?,?)`).run(input.assetId, input.type, input.scope, input.workspace, input.title, input.summary, JSON.stringify(input.retrievalTerms), input.bodyMarkdown);
    this.index(input);
    return this.get(input.assetId)!;
  }

  revise(assetId: string, version: number, content: AssetContent): AssetRecord {
    this.assertTransaction();
    content = { ...content, retrievalTerms: storedRetrievalTermsSchema.parse(content.retrievalTerms) };
    const current = this.get(assetId);
    if (!current || current.version !== version) throw new RepositoryOperationError("VERSION_CONFLICT", "正式知识版本已变化或已删除");
    if (current.title === content.title && current.summary === content.summary && current.bodyMarkdown === content.bodyMarkdown && JSON.stringify(current.retrievalTerms) === JSON.stringify(content.retrievalTerms)) return current;
    const changed = this.database.prepare(`UPDATE asset SET
      previous_content=json_object('title',title,'summary',summary,'retrievalTerms',json(retrieval_terms),'bodyMarkdown',body_markdown,'updatedAt',updated_at),
      title=?,summary=?,retrieval_terms=?,body_markdown=?,version=version+1,updated_at=? WHERE asset_id=? AND version=? AND is_deleted = 0`)
      .run(content.title, content.summary, JSON.stringify(content.retrievalTerms), content.bodyMarkdown, new Date().toISOString(), assetId, version);
    if (changed.changes !== 1) throw new RepositoryOperationError("VERSION_CONFLICT", "正式知识版本已变化或已删除");
    this.database.prepare("DELETE FROM asset_fts WHERE asset_id=?").run(assetId);
    this.index({ ...current, ...content });
    return this.get(assetId)!;
  }

  delete(assetId: string): void {
    this.assertTransaction();
    if (this.database.prepare(`SELECT candidate_id FROM asset_candidate WHERE asset_id=? AND is_deleted = 0
      AND status IN ('PENDING','DEFERRED')`).get(assetId)) throw new RepositoryOperationError("ASSET_HAS_OPEN_CANDIDATE", "请先处理该知识的待审或暂存候选");
    if (this.database.prepare("UPDATE asset SET is_deleted=1,updated_at=? WHERE asset_id=? AND is_deleted = 0")
      .run(new Date().toISOString(), assetId).changes !== 1) throw new RepositoryOperationError("ASSET_NOT_FOUND", "知识不存在或已删除");
  }

  missingRetrievalTerms(): AssetRecord[] {
    return this.database.prepare<[], AssetRow>(`SELECT ${selection} FROM asset a
      WHERE a.retrieval_terms='[]' AND a.is_deleted = 0 ORDER BY a.asset_id`).all().map(map);
  }

  backfillTerms(items: TermsBackfillItem[]): Array<{ assetId: string; written: boolean }> {
    return this.database.transaction(() => items.map(item => {
      const terms = retrievalTermsSchema.parse(item.retrievalTerms);
      const result = this.database.prepare(`UPDATE asset SET retrieval_terms=?,updated_at=?
        WHERE asset_id=? AND version=? AND retrieval_terms='[]' AND is_deleted = 0`)
        .run(JSON.stringify(terms), new Date().toISOString(), item.assetId, item.version);
      if (result.changes === 1) {
        this.database.prepare("DELETE FROM asset_fts WHERE asset_id=?").run(item.assetId);
        this.index(this.get(item.assetId)!);
      }
      return { assetId: item.assetId, written: result.changes === 1 };
    })).immediate();
  }

  private index(input: NewAsset): void {
    this.database.prepare("INSERT INTO asset_fts (asset_id,title,summary,retrieval_terms,body_markdown) VALUES (?,?,?,?,?)")
      .run(input.assetId, input.title, input.summary, JSON.stringify(input.retrievalTerms), input.bodyMarkdown);
  }
  private assertTransaction(): void {
    if (!this.database.inTransaction) throw new Error("Asset writes require a write transaction");
  }
}
