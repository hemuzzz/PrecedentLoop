import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";

import {
  scanAssetRepository,
  scanInboxRepository,
  type AssetScanOptions,
  type AssetScanResult,
  type ScannedAsset,
} from "./scanner.js";

import { confirmVersionedInboxAsset } from "./versioned-confirmation.js";

export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type AssetConfirmationErrorCode =
  | "CONFIRM_BUSY"
  | "CONFIRM_PARTIAL_WRITE"
  | "CONFIRM_RECOVERY_REQUIRED"
  | "BASELINE_MISMATCH"
  | "UPDATE_ASSET_INVALID"
  | "ASSET_COPY_FAILED"
  | "ASSET_ID_CONFLICT"
  | "CONFIRM_CONFIGURATION_INVALID"
  | "CONFIRM_INPUT_INVALID"
  | "CONTENT_HASH_MISMATCH"
  | "INBOX_ASSET_INVALID"
  | "INBOX_ASSET_NOT_FOUND"
  | "INBOX_SNAPSHOT_UNAVAILABLE"
  | "POST_MOVE_VALIDATION_FAILED"
  | "SOURCE_REMOVE_FAILED"
  | "TARGET_ALREADY_EXISTS";

export interface AssetConfirmationInput {
  requestId?: string;
  updateAssetId?: string;
  expectedBaselineHash?: string;
  expectedContentHash: string;
  relativePath: string;
}

export interface AssetConfirmationResult {
  assetId: string;
  contentHash: string;
  ok: true;
  sourceRelativePath: string;
  targetRelativePath: string;
}

export interface AssetConfirmationOptions extends AssetScanOptions {
  databasePath: string;
  checkpoint?: (stage: "prepared" | "file-written" | "database-committed") => Promise<void>;
}

export class AssetConfirmationError extends Error {
  constructor(
    readonly code: AssetConfirmationErrorCode,
    message: string,
    readonly relativePath?: string,
  ) {
    super(message);
    this.name = "AssetConfirmationError";
  }
}

export async function confirmInboxAsset(
  input: AssetConfirmationInput,
  options: AssetConfirmationOptions,
): Promise<AssetConfirmationResult> {
  return confirmVersionedInboxAsset(input, options);
}

export function targetPathForInboxPath(relativePath: string): string {
  const parts = safeInboxPathParts(relativePath);
  if (parts === undefined) {
    throw new AssetConfirmationError(
      "CONFIRM_INPUT_INVALID",
      "relativePath must identify one normalized Markdown file in the Inbox layout",
    );
  }
  return ["assets", ...parts.slice(1)].join("/");
}

function safeInboxPathParts(relativePath: string): string[] | undefined {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    return undefined;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return undefined;
  }
  const isGlobal =
    parts.length === 4 &&
    parts[0] === "inbox" &&
    parts[1] === "global" &&
    isTypeDirectory(parts[2]);
  const isWorkspace =
    parts.length === 5 &&
    parts[0] === "inbox" &&
    parts[1] === "workspaces" &&
    parts[2] !== undefined &&
    isTypeDirectory(parts[3]);
  const fileName = parts.at(-1);
  return (isGlobal || isWorkspace) && fileName !== undefined && fileName.toLowerCase().endsWith(".md")
    ? parts
    : undefined;
}

function isTypeDirectory(value: string | undefined): boolean {
  return value === "memories" || value === "documents" || value === "skills";
}

export function assertExpectedContentHash(contentHash: string, relativePath: string): void {
  if (typeof contentHash !== "string" || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new AssetConfirmationError(
      "CONFIRM_INPUT_INVALID",
      "expectedContentHash must be a 64-character lowercase SHA-256 value",
      relativePath,
    );
  }
}

export function assertConfiguration(options: AssetScanOptions): void {
  if (
    !isAllowedAbsolutePath(options.repositoryPath) ||
    !isAllowedAbsolutePath(options.workspaceConfigPath)
  ) {
    throw new AssetConfirmationError(
      "CONFIRM_CONFIGURATION_INVALID",
      "Asset Repository and Workspace configuration paths must be absolute",
    );
  }
}

function isAllowedAbsolutePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && (isAbsolute(path) || win32.isAbsolute(path));
}

export async function scanInbox(options: AssetScanOptions): Promise<AssetScanResult> {
  let result: AssetScanResult;
  try {
    result = await scanInboxRepository(options);
  } catch {
    throw new AssetConfirmationError(
      "INBOX_SNAPSHOT_UNAVAILABLE",
      "Inbox Scanner could not produce a complete snapshot",
    );
  }
  if (!result.isComplete) {
    throw new AssetConfirmationError(
      "INBOX_SNAPSHOT_UNAVAILABLE",
      "Inbox Scanner could not produce a complete snapshot",
    );
  }
  return result;
}

export async function scanFormalAssets(options: AssetScanOptions): Promise<AssetScanResult> {
  let result: AssetScanResult;
  try {
    result = await scanAssetRepository(options);
  } catch {
    throw new AssetConfirmationError(
      "INBOX_SNAPSHOT_UNAVAILABLE",
      "Formal Asset Scanner could not produce a complete snapshot",
    );
  }
  if (!result.isComplete) {
    throw new AssetConfirmationError(
      "INBOX_SNAPSHOT_UNAVAILABLE",
      "Formal Asset Scanner could not produce a complete snapshot",
    );
  }
  return result;
}

export function requireEligibleInboxAsset(scan: AssetScanResult, relativePath: string): ScannedAsset {
  const asset = scan.assets.find((item) => item.relativePath === relativePath);
  if (asset !== undefined) {
    return asset;
  }
  if (scan.diagnostics.some((item) => item.path === relativePath)) {
    throw new AssetConfirmationError(
      "INBOX_ASSET_INVALID",
      "Selected Inbox Asset failed Scanner eligibility validation",
      relativePath,
    );
  }
  throw new AssetConfirmationError(
    "INBOX_ASSET_NOT_FOUND",
    "Selected Inbox Asset was not found",
    relativePath,
  );
}

export function assertNoFormalIdConflict(
  scan: AssetScanResult,
  assetId: string,
  relativePath: string,
): void {
  if (
    scan.assets.some((asset) => asset.frontmatter.id === assetId) ||
    scan.diagnostics.some((item) => item.assetId === assetId)
  ) {
    throw new AssetConfirmationError(
      "ASSET_ID_CONFLICT",
      "Inbox Asset ID conflicts with an existing formal Asset",
      relativePath,
    );
  }
}

export async function ensureSafeTargetParent(
  repositoryPath: string,
  targetRelativePath: string,
): Promise<string[]> {
  const parentParts = dirname(targetRelativePath).split("/");
  const createdDirectories: string[] = [];
  let current = repositoryPath;

  for (const part of parentParts) {
    current = join(current, part);
    try {
      await mkdir(current);
      createdDirectories.push(current);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) {
        await removeEmptyCreatedDirectories(createdDirectories);
        throw new AssetConfirmationError(
          "ASSET_COPY_FAILED",
          "Formal Asset parent directory could not be created",
          targetRelativePath,
        );
      }
    }

    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("unsafe target parent");
      }
    } catch {
      await removeEmptyCreatedDirectories(createdDirectories);
      throw new AssetConfirmationError(
        "ASSET_COPY_FAILED",
        "Formal Asset parent path must contain only regular directories",
        targetRelativePath,
      );
    }
  }
  return createdDirectories;
}

async function removeEmptyCreatedDirectories(paths: readonly string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    try {
      await rmdir(path);
    } catch {
      // A non-empty or externally changed directory is not owned exclusively by this command.
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
