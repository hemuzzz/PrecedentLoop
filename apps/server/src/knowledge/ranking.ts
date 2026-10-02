import { compareRankedItems,
  type AssetSearchContext, type AssetSearchService, type RankedSearchItem } from "../asset/search.js";

// Pure merge: callers supply snapshot search results. No facts, budgets or I/O.
export function rankRecallCandidates(authorizedWorkspaces: readonly string[], queries: readonly string[],
  matches: ReadonlyMap<string, readonly RankedSearchItem[]>): RankedSearchItem[] {
  const ranks = new Map<string, RankedSearchItem>();
  for (const expression of queries) {
    for (const rank of matches.get(expression) ?? []) {
      if (rank.item.scope !== "GLOBAL" && !authorizedWorkspaces.includes(rank.item.workspace!)) continue;
      const prior = ranks.get(rank.assetId);
      if (!prior || compareRankedItems(rank, prior) < 0) ranks.set(rank.assetId, rank);
    }
  }
  return [...ranks.values()].sort(compareRankedItems);
}

// Must run in the caller's read snapshot.
export function recallRanking(search: AssetSearchService, context: AssetSearchContext, queries: readonly string[]): RankedSearchItem[] {
  return rankRecallCandidates(context.authorizedWorkspaces, queries,
    new Map(queries.map(query => [query, search.rankedCandidates(context, query)])));
}
