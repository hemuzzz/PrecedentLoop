import { isAbsolute, win32 } from "node:path";

import { SnowflakeIdGenerator, type IdGenerator } from "@precedent-loop/id-generator";
import { z } from "zod";

export const ASSET_TYPES = ["MEMORY", "DOCUMENT", "SKILL"] as const;
export const ASSET_SCOPES = ["GLOBAL", "WORKSPACE"] as const;

export const assetTypeSchema = z.enum(ASSET_TYPES);
export const assetScopeSchema = z.enum(ASSET_SCOPES);

export function foldCase(value: string): string { return value.toLocaleLowerCase("en-US"); }
const retrievalTermSchema = z.string()
  .refine(value => !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value), "检索词不能含换行、控制字符或无效 Unicode")
  .trim().refine(value => [...value].length >= 2 && [...value].length <= 64, "检索词须为 2–64 个 Unicode 字符")
  .refine(value => !/[。！？；，、;!?]/u.test(value) && !value.endsWith("."), "检索词不能是整句：不能含中文。！？；，、或英文 ; ! ?，也不能以英文句号结尾");
export const storedRetrievalTermsSchema = z.array(retrievalTermSchema).max(16).overwrite(values => {
  const seen = new Set<string>();
  return values.filter(value => { const key = foldCase(value); if (seen.has(key)) return false; seen.add(key); return true; });
});
export const retrievalTermsSchema = storedRetrievalTermsSchema.min(3)
  .refine(values => values.length >= 3, "去重后至少需要 3 个检索词")
  .describe("完整检索词列表，3–16 个：代码标识（类名、表名、接口、错误码、文件名）、中文业务叫法、同义词或缩写，不写整句；每个 2–64 个 Unicode 字符。不要过宽：不用单独的普通英文词（如 current、operator）或跨很多条知识通用的大词；优先写具体标识或组合词，如 currentVersion、candidate_update、候选版本冲突。");

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
