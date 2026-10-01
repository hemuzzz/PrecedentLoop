import type Database from "better-sqlite3";

/** SQL fragments accept only the two internal identity expressions, never request input. */
export function knowledgeNumberJoin(identity: "catalog.asset_id" | "candidate.asset_id", revisionOnly = false): string {
  return `LEFT JOIN asset_knowledge_number AS number ON number.asset_id = ${identity}${revisionOnly ? " AND candidate.intent = 'REVISION'" : ""}`;
}
export const knowledgeNumberSelection = "number.knowledge_number AS knowledgeNumber";

/** Called inside the Catalog write transaction. Never delete identities or consume numbers on a replay. */
export function assignKnowledgeNumbers(database: Database.Database, assetIds: readonly string[]): void {
  const insert = database.prepare<[string, string]>(`INSERT INTO asset_knowledge_number (asset_id)
    SELECT ? WHERE NOT EXISTS (SELECT 1 FROM asset_knowledge_number WHERE asset_id=?)`);
  // The generator appends 128 nonce bits to Snowflake (10 node + 12 sequence bits).
  // Comparing the relative timestamp needs no epoch; same-millisecond ties use the ID string.
  const ordered = [...new Set(assetIds)].map(id => ({ id, timestamp: BigInt(id.slice(3)) >> 150n })).sort((a, b) => {
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const { id } of ordered) insert.run(id, id);
}

/** Shared query for file-scan projections; SQL-backed projections use knowledgeNumberJoin. */
export function readKnowledgeNumbers(database: Database.Database): Map<string, number> {
  const rows = database.prepare<[], { assetId: string; knowledgeNumber: number }>(
    "SELECT asset_id AS assetId, knowledge_number AS knowledgeNumber FROM asset_knowledge_number").all();
  return new Map(rows.map(row => [row.assetId, row.knowledgeNumber]));
}
