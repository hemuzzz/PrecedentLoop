import { z } from "zod";
import { assetIdSchema } from "../asset/schema.js";

export class KnowledgeError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = "KnowledgeError"; }
}
export const capabilityIdsSchema = z.array(z.string().regex(/^cap_[A-Za-z0-9_-]{43}$/u)).max(8);
export const referenceSchema = z.string().regex(/^usg[0-9]+$/u);
export const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recallInputSchema = z.object({
  capabilityIds: capabilityIdsSchema,
  queries: z.array(z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u)).min(1).max(8)
    .describe("Complete literal substrings, OR across items; preserve internal spaces and punctuation. Case-insensitive; no regex or Boolean syntax."),
}).strict();
export const readInputSchema = z.union([
  z.object({ capabilityIds: capabilityIdsSchema, recallItemId: referenceSchema }).strict(),
  z.object({ capabilityIds: capabilityIdsSchema, assetId: assetIdSchema, expectedVersion: versionSchema.optional() }).strict(),
]);
export const usedInputSchema = z.union([
  z.object({ capabilityIds: capabilityIdsSchema, recallItemId: referenceSchema }).strict(),
  z.object({ capabilityIds: capabilityIdsSchema, readRef: referenceSchema }).strict(),
]);
export interface Source {
  assetId: string; version: number; assetScope: "GLOBAL" | "WORKSPACE"; assetWorkspace: string | null;
}
export interface RecallItem extends Source {
  recallItemId: string | null; title: string; type: "MEMORY" | "DOCUMENT" | "SKILL";
  deliveredMode: "DIRECT" | "ON_DEMAND"; deliveryReasons: string[]; summary?: string;
}
export interface Budget {
  maxAssets: number; maxModelVisibleCharacters: number; modelVisibleCharacters: number;
  knowledgeContentCharacters: number; metadataCharacters: number; deliveredAssets: number;
  omittedCount: number; downgradedCount: number;
}
export interface RecallResult {
  usageRecorded: boolean; recallId: string | null; authorizedWorkspaces: string[]; queries: string[];
  occurredAt: string; items: RecallItem[]; diagnostics: string[]; budget: Budget;
}
export interface RecallResponse {
  usageRecorded: boolean; authorizedWorkspaces: string[]; reference: string;
  items: Array<Pick<RecallItem, "recallItemId" | "assetId" | "version" | "title" | "type" | "summary"> & {
    workspace: string | null; deliveryReasons?: string[];
  }>;
  diagnostics: string[]; budget: Pick<Budget, "omittedCount" | "downgradedCount">;
}
export interface ReadFact extends Source {
  readRef: string; authorizedWorkspaces: string[]; recallItemId: string | null; occurredAt: string;
}
export interface UsedFact { usedId: string; assetId: string; authorizedWorkspaces: string[];
  recallItemId: string | null; directReadRef: string | null; occurredAt: string; }
