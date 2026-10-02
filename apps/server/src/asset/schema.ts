import { isAbsolute, win32 } from "node:path";

import { SnowflakeIdGenerator, type IdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";

export const ASSET_TYPES = ["MEMORY", "DOCUMENT", "SKILL"] as const;
export const ASSET_SCOPES = ["GLOBAL", "WORKSPACE"] as const;

export const assetTypeSchema = z.enum(ASSET_TYPES);
export const assetScopeSchema = z.enum(ASSET_SCOPES);

const idGenerator: IdGenerator = new SnowflakeIdGenerator();

export const assetIdSchema = z
  .string()
  .refine((id) => idGenerator.validate(id, "ast"), "id must be a valid ast-prefixed ID");
export const candidateIdSchema = z.string().refine(id => idGenerator.validate(id, "cnd"), "id must be a valid cnd-prefixed ID");

const requiredTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "must contain non-whitespace text");

export const workspaceNameSchema = requiredTextSchema
  .refine((name) => name === name.trim(), "workspace name must not have surrounding whitespace")
  .refine(
    (name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0"),
    "workspace name must be one safe path segment",
  )
  .refine((name) => name.toLowerCase() !== "global", "global is an Asset scope, not a workspace");

const workspacePathSchema = requiredTextSchema.refine(
  (workspacePath) => isAbsolute(workspacePath) || win32.isAbsolute(workspacePath),
  "workspace path must be absolute",
);

export const workspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z.array(
      z
        .object({
          name: workspaceNameSchema,
          paths: z.array(workspacePathSchema).min(1),
          aliases: z.array(z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/u)).max(4).optional(),
          description: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
          // Legacy (before 2026-09-25): accepted so older files still load, but ignored and never
          // written. Every registered workspace is now available across projects.
          knowledgeAccess: z.enum(["HOST_ONLY", "PREAUTHORIZED"]).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((config, context) => {
    const seenNames = new Set<string>();

    config.workspaces.forEach((workspace, index) => {
      if (seenNames.has(workspace.name)) {
        context.addIssue({
          code: "custom",
          message: `duplicate workspace name: ${workspace.name}`,
          path: ["workspaces", index, "name"],
        });
      }

      seenNames.add(workspace.name);
    });
  });

export type AssetType = z.infer<typeof assetTypeSchema>;
export type AssetScope = z.infer<typeof assetScopeSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
