import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";

import {
  assetIdSchema,
  assetScopeSchema,
  assetTypeSchema,
  workspaceNameSchema,
} from "../../asset/index.js";


const idGenerator = new SnowflakeIdGenerator();

const requiredQueryTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "must contain non-whitespace text");

const limitParameterSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u, "limit must be a positive integer")
  .transform(Number)
  .pipe(z.number().int().safe().min(1).max(100));

export const workspaceParameterSchema = z.union([
  z.literal("null").transform(() => null),
  workspaceNameSchema,
]);

export const assetListQuerySchema = z
  .object({
    limit: limitParameterSchema.optional(),
    offset: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().safe().min(0)).optional(),
    query: requiredQueryTextSchema.optional(),
    scope: assetScopeSchema.optional(),
    type: assetTypeSchema.optional(),
    workspace: workspaceParameterSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workspace === null && value.scope === "WORKSPACE") {
      context.addIssue({
        code: "custom",
        message: "workspace=null cannot be combined with scope=WORKSPACE",
        path: ["workspace", "scope"],
        params: { code: "INVALID_FILTER_COMBINATION" },
      });
    }
    if (typeof value.workspace === "string" && value.scope === "GLOBAL") {
      context.addIssue({
        code: "custom",
        message: "a concrete workspace cannot be combined with scope=GLOBAL",
        path: ["workspace", "scope"],
        params: { code: "INVALID_FILTER_COMBINATION" },
      });
    }
  });

export const assetPathSchema = z.object({ assetId: assetIdSchema }).strict();
export const factListQuerySchema = z.object({
  limit: limitParameterSchema.optional(),
  offset: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().safe().min(0)).optional(),
  assetId: assetIdSchema.optional(),
}).strict();
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export interface RestErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RestErrorResponse {
  error: RestErrorDetail;
  ok: false;
}

export interface RestSuccessResponse<T> {
  data: T;
  ok: true;
}
