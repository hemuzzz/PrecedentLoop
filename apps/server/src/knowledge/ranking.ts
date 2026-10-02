import type { NewAsset } from "../asset/asset-repository.js";
import { foldCase } from "../asset/schema.js";
import { compareRankedItems, ftsFieldTier, literalFieldTier, normalizeRecallExpression,
  type AssetSearchContext, type AssetSearchService, type RankedSearchItem } from "../asset/search.js";

export type VirtualAsset = NewAsset & { version: number };

// Pure merge: callers supply snapshot search results. No facts, budgets or I/O.
export function rankRecallCandidates(authorizedWorkspaces: readonly string[], queries: readonly string[],
  matches: ReadonlyMap<string, readonly RankedSearchItem[]>, virtual?: VirtualAsset): RankedSearchItem[] {
  const ranks = new Map<string, RankedSearchItem>();
  for (const expression of queries) {
    const query = normalizeRecallExpression(expression);
    const items = [...(matches.get(expression) ?? [])].filter(rank => rank.assetId !== virtual?.assetId);
    if (virtual && (virtual.scope === "GLOBAL" || authorizedWorkspaces.includes(virtual.workspace!))) {
      const title = foldCase(virtual.title), summary = foldCase(virtual.summary), body = foldCase(virtual.bodyMarkdown);
      const retrievalTerms = foldCase(virtual.retrievalTerms.join("\n"));
      const fields = { title, summary, body, retrievalTerms, combined: `${title}\n${summary}\n${retrievalTerms}\n${body}` };
      if (query.terms.every(term => fields.combined.includes(term))) {
        const fieldTier = query.strategy === "LITERAL" ? literalFieldTier(fields, query) : ftsFieldTier(fields, query.terms);
        const workspacePriority = virtual.scope === "WORKSPACE" ? 1 : 0;
        items.push({ assetId: virtual.assetId, bm25: null, fieldTier, workspacePriority,
          item: { assetId: virtual.assetId, version: virtual.version, title: virtual.title, summary: virtual.summary,
            type: virtual.type, scope: virtual.scope, ...(virtual.workspace ? { workspace: virtual.workspace } : {}),
            matchedSnippet: "", searchStrategy: query.strategy, score: fieldTier * 100 + workspacePriority * 10 } });
      }
    }
    for (const rank of items) {
      if (rank.item.scope !== "GLOBAL" && !authorizedWorkspaces.includes(rank.item.workspace!)) continue;
      const prior = ranks.get(rank.assetId);
      if (!prior || compareRankedItems(rank, prior) < 0) ranks.set(rank.assetId, rank);
    }
  }
  return [...ranks.values()].sort(compareRankedItems);
}

// Must run in the caller's read snapshot, shared by recall and self checks.
export function recallRanking(search: AssetSearchService, context: AssetSearchContext, queries: readonly string[], virtual?: VirtualAsset): RankedSearchItem[] {
  return rankRecallCandidates(context.authorizedWorkspaces, queries,
    new Map(queries.map(query => [query, search.rankedCandidates(context, query)])), virtual);
}
