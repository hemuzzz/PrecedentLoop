import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { parseYamlFrontmatter } from "./frontmatter.js";
import { withRepositoryAccess } from "./coordination.js";
import {
  ASSET_TYPES,
  assetFrontmatterSchema,
  assetIdSchema,
  workspaceConfigSchema,
  type AssetFrontmatter,
  type AssetType,
  type WorkspaceConfig,
} from "./schema.js";

const TYPE_BY_DIRECTORY = {
  documents: "DOCUMENT",
  memories: "MEMORY",
  skills: "SKILL",
} as const satisfies Record<string, AssetType>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type AssetDiagnosticCode =
  | "ASSETS_DIRECTORY_MISSING"
  | "DIRECTORY_ASSET"
  | "DUPLICATE_ASSET_ID"
  | "FILE_READ_ERROR"
  | "GLOBAL_WORKSPACE_FORBIDDEN"
  | "INVALID_ASSET_PATH"
  | "INVALID_FRONTMATTER"
  | "INVALID_WORKSPACE_CONFIG"
  | "MISSING_FRONTMATTER"
  | "NON_MARKDOWN_FILE"
  | "NON_REGULAR_FILE"
  | "PATH_SCOPE_MISMATCH"
  | "PATH_TYPE_MISMATCH"
  | "PATH_WORKSPACE_MISMATCH"
  | "REPOSITORY_UNAVAILABLE"
  | "SYMLINK"
  | "UNKNOWN_ASSET_TYPE"
  | "UNKNOWN_WORKSPACE"
  | "WORKSPACE_REQUIRED";

export interface AssetDiagnostic {
  assetId?: string;
  code: AssetDiagnosticCode;
  message: string;
  path: string;
}

export interface ScannedAsset {
  rawContent: Buffer;
  absolutePath: string;
  content: string;
  contentHash: string;
  fileSize: number;
  frontmatter: AssetFrontmatter;
  markdown: string;
  modifiedAt: string;
  relativePath: string;
}

export interface AssetScanResult {
  assets: ScannedAsset[];
  diagnostics: AssetDiagnostic[];
  isComplete: boolean;
}

export interface AssetScanOptions {
  /** Internal, validated configuration snapshot; never accepted from a model. */
  workspaceConfigSnapshot?: WorkspaceConfig;
  repositoryPath: string;
  workspaceConfigPath: string;
}

export interface AssetFileScanOptions extends AssetScanOptions {
  relativePaths: readonly string[];
}

type AssetLocation =
  | { scope: "GLOBAL"; type: AssetType }
  | { scope: "WORKSPACE"; type: AssetType; workspace: string };

interface ScannedFileRecord {
  asset?: ScannedAsset;
  diagnostics: AssetDiagnostic[];
  id?: string;
  relativePath: string;
}

export function computeContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
  const stats = await lstat(configPath);

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("workspaces.json must be a regular file and must not be a symlink");
  }

  const bytes = await readFile(configPath);
  const source = utf8Decoder.decode(bytes);
  const parsed = JSON.parse(source) as unknown;

  return workspaceConfigSchema.parse(parsed);
}

export async function scanAssetRepository(options: AssetScanOptions): Promise<AssetScanResult> {
  return withRepositoryAccess(options.repositoryPath, () => scanRepositoryDirectory(options, "assets", false));
}

export async function scanInboxRepository(options: AssetScanOptions): Promise<AssetScanResult> {
  return withRepositoryAccess(options.repositoryPath, () => scanRepositoryDirectory(options, "inbox", true));
}

async function scanRepositoryDirectory(
  options: AssetScanOptions,
  rootDirectory: "assets" | "inbox",
  missingIsEmpty: boolean,
): Promise<AssetScanResult> {
  const repositoryPath = resolve(options.repositoryPath);
  const rootPath = join(repositoryPath, rootDirectory);
  let workspaceConfig: WorkspaceConfig;

  try {
    workspaceConfig = options.workspaceConfigSnapshot ?? await loadWorkspaceConfig(resolve(options.workspaceConfigPath));
  } catch (error) {
    return {
      assets: [],
      diagnostics: [
        diagnostic(
          "INVALID_WORKSPACE_CONFIG",
          options.workspaceConfigPath,
          `Unable to load valid schemaVersion=1 workspaces.json: ${errorMessage(error)}`,
        ),
      ],
      isComplete: false,
    };
  }

  let repositoryStats;
  try {
    repositoryStats = await lstat(repositoryPath);
  } catch (error) {
    return {
      assets: [],
      diagnostics: [
        diagnostic(
          "REPOSITORY_UNAVAILABLE",
          rootDirectory,
          `Asset Repository is unavailable: ${errorMessage(error)}`,
        ),
      ],
      isComplete: false,
    };
  }
  if (repositoryStats.isSymbolicLink() || !repositoryStats.isDirectory()) {
    return {
      assets: [],
      diagnostics: [
        diagnostic(
          "REPOSITORY_UNAVAILABLE",
          rootDirectory,
          "Asset Repository must be a regular directory and must not be a symlink",
        ),
      ],
      isComplete: false,
    };
  }

  let rootStats;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    if (missingIsEmpty && isMissingPathError(error)) {
      return { assets: [], diagnostics: [], isComplete: true };
    }
    return {
      assets: [],
      diagnostics: [
        diagnostic(
          rootDirectory === "assets" ? "ASSETS_DIRECTORY_MISSING" : "FILE_READ_ERROR",
          rootDirectory,
          `Asset repository must contain an accessible ${rootDirectory} directory: ${errorMessage(error)}`,
        ),
      ],
      isComplete: false,
    };
  }

  if (rootStats.isSymbolicLink()) {
    return {
      assets: [],
      diagnostics: [diagnostic("SYMLINK", rootDirectory, "Symlinks are not scanned")],
      isComplete: false,
    };
  }

  if (!rootStats.isDirectory()) {
    return {
      assets: [],
      diagnostics: [
        diagnostic("NON_REGULAR_FILE", rootDirectory, `The ${rootDirectory} path must be a directory`),
      ],
      isComplete: false,
    };
  }

  const completeness = { value: true };
  const records: ScannedFileRecord[] = [];
  const diagnostics: AssetDiagnostic[] = [];
  const workspaceNames = new Set(workspaceConfig.workspaces.map(({ name }) => name));

  await scanDirectory({
    absolutePath: rootPath,
    repositoryPath,
    completeness,
    diagnostics,
    records,
    relativeParts: [],
    rootDirectory,
    workspaceNames,
  });

  return finalizeScan(records, diagnostics, completeness.value);
}

export async function scanAssetFiles(options: AssetFileScanOptions): Promise<AssetScanResult> {
  return withRepositoryAccess(options.repositoryPath, () => scanAssetFilesUnlocked(options));
}

async function scanAssetFilesUnlocked(options: AssetFileScanOptions): Promise<AssetScanResult> {
  const repositoryPath = resolve(options.repositoryPath);
  let workspaceConfig: WorkspaceConfig;

  try {
    workspaceConfig = options.workspaceConfigSnapshot ?? await loadWorkspaceConfig(resolve(options.workspaceConfigPath));
  } catch (error) {
    return {
      assets: [],
      diagnostics: [
        diagnostic(
          "INVALID_WORKSPACE_CONFIG",
          options.workspaceConfigPath,
          `Unable to load valid schemaVersion=1 workspaces.json: ${errorMessage(error)}`,
        ),
      ],
      isComplete: false,
    };
  }

  const diagnostics: AssetDiagnostic[] = [];
  const records: ScannedFileRecord[] = [];
  const workspaceNames = new Set(workspaceConfig.workspaces.map(({ name }) => name));
  const relativePaths = [...new Set(options.relativePaths)].sort();

  for (const relativePath of relativePaths) {
    const relativeParts = safeAssetRelativeParts(relativePath);
    if (relativeParts === undefined) {
      diagnostics.push(
        diagnostic(
          "INVALID_ASSET_PATH",
          relativePath,
          "Catalog file path must be a normalized relative path inside assets/",
        ),
      );
      continue;
    }

    const absolutePath = join(repositoryPath, ...relativePath.split("/"));
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      records.push(
        invalidFileRecord(relativePath, [
          diagnostic("FILE_READ_ERROR", relativePath, `Unable to inspect file: ${errorMessage(error)}`),
        ]),
      );
      continue;
    }

    if (stats.isSymbolicLink()) {
      records.push(
        invalidFileRecord(relativePath, [diagnostic("SYMLINK", relativePath, "Symlinks are not scanned")]),
      );
      continue;
    }

    if (stats.isDirectory()) {
      records.push(
        invalidFileRecord(
          relativePath,
          [diagnostic("DIRECTORY_ASSET", relativePath, "Directory Assets are not supported")],
        ),
      );
      continue;
    }

    if (!stats.isFile()) {
      records.push(
        invalidFileRecord(
          relativePath,
          [diagnostic("NON_REGULAR_FILE", relativePath, "Only regular Markdown files can be Assets")],
        ),
      );
      continue;
    }

    // Finder metadata is not an Asset and does not need a file diagnostic.
    if (relativeParts.at(-1) === ".DS_Store") continue;

    if (extname(relativePath).toLowerCase() !== ".md") {
      records.push(
        invalidFileRecord(
          relativePath,
          [diagnostic("NON_MARKDOWN_FILE", relativePath, "Only Markdown .md files can be Assets")],
        ),
      );
      continue;
    }

    records.push(
      await readCandidate({
        absolutePath,
        repositoryPath,
        location: parseAssetLocation(relativeParts),
        relativePath,
        workspaceNames,
      }),
    );
  }

  return finalizeScan(records, diagnostics, true);
}

function finalizeScan(
  records: ScannedFileRecord[],
  diagnostics: AssetDiagnostic[],
  isComplete: boolean,
): AssetScanResult {
  const recordsById = new Map<string, ScannedFileRecord[]>();
  for (const record of records) {
    if (record.id === undefined) {
      continue;
    }

    const sameIdRecords = recordsById.get(record.id) ?? [];
    sameIdRecords.push(record);
    recordsById.set(record.id, sameIdRecords);
  }

  for (const [id, sameIdRecords] of recordsById) {
    if (sameIdRecords.length < 2) {
      continue;
    }

    const conflictingPaths = sameIdRecords.map(({ relativePath }) => relativePath).sort();
    for (const record of sameIdRecords) {
      record.diagnostics.push(
        diagnostic(
          "DUPLICATE_ASSET_ID",
          record.relativePath,
          `Asset ID ${id} is duplicated by: ${conflictingPaths.join(", ")}`,
        ),
      );
    }
  }

  for (const record of records) {
    diagnostics.push(
      ...record.diagnostics.map((item) =>
        record.id === undefined || item.assetId !== undefined
          ? item
          : { ...item, assetId: record.id },
      ),
    );
  }

  return {
    assets: records
      .filter(
        (record): record is ScannedFileRecord & { asset: ScannedAsset } =>
          record.asset !== undefined && record.diagnostics.length === 0,
      )
      .map(({ asset }) => asset)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    diagnostics: diagnostics.sort(compareDiagnostics),
    isComplete,
  };
}

interface ScanDirectoryContext {
  absolutePath: string;
  repositoryPath: string;
  completeness: { value: boolean };
  diagnostics: AssetDiagnostic[];
  records: ScannedFileRecord[];
  relativeParts: string[];
  rootDirectory: "assets" | "inbox";
  workspaceNames: Set<string>;
}

async function scanDirectory(context: ScanDirectoryContext): Promise<void> {
  let entries;
  try {
    entries = await readdir(context.absolutePath, { withFileTypes: true });
  } catch (error) {
    context.completeness.value = false;
    const relativePath = [context.rootDirectory, ...context.relativeParts].join("/");
    context.diagnostics.push(
      diagnostic("FILE_READ_ERROR", relativePath, `Unable to read directory: ${errorMessage(error)}`),
    );
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = join(context.absolutePath, entry.name);
    const relativeParts = [...context.relativeParts, entry.name];
    const relativePath = [context.rootDirectory, ...relativeParts].join("/");
    let stats;

    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      context.completeness.value = false;
      context.diagnostics.push(
        diagnostic("FILE_READ_ERROR", relativePath, `Unable to inspect file: ${errorMessage(error)}`),
      );
      continue;
    }

    if (stats.isSymbolicLink()) {
      context.diagnostics.push(diagnostic("SYMLINK", relativePath, "Symlinks are not scanned"));
      continue;
    }

    if (stats.isDirectory()) {
      if (isAssetContainer(context.relativeParts)) {
        context.diagnostics.push(
          diagnostic("DIRECTORY_ASSET", relativePath, "Directory Assets are not supported"),
        );
        continue;
      }

      if (!isStructuralDirectory(relativeParts)) {
        context.diagnostics.push(
          diagnostic("INVALID_ASSET_PATH", relativePath, "Directory is outside the formal Asset layout"),
        );
        continue;
      }

      await scanDirectory({ ...context, absolutePath, relativeParts });
      continue;
    }

    if (!stats.isFile()) {
      context.diagnostics.push(
        diagnostic("NON_REGULAR_FILE", relativePath, "Only regular Markdown files can be Assets"),
      );
      continue;
    }

    // Shared by the formal Asset and Inbox scans.
    if (entry.name === ".DS_Store") continue;

    if (extname(entry.name).toLowerCase() !== ".md") {
      context.diagnostics.push(
        diagnostic("NON_MARKDOWN_FILE", relativePath, "Only Markdown .md files can be Assets"),
      );
      continue;
    }

    const record = await readCandidate({
      absolutePath,
      repositoryPath: context.repositoryPath,
      location: parseAssetLocation(relativeParts),
      relativePath,
      workspaceNames: context.workspaceNames,
    });

    context.records.push(record);
  }
}

interface ReadCandidateOptions {
  absolutePath: string;
  repositoryPath: string;
  location: AssetLocation | undefined;
  relativePath: string;
  workspaceNames: Set<string>;
}

async function readCandidate(options: ReadCandidateOptions): Promise<ScannedFileRecord> {
  const pathFailure = await validateCurrentFilePath(options);
  if (pathFailure !== undefined) {
    return invalidFileRecord(options.relativePath, [pathFailure]);
  }
  let bytes: Buffer;
  let fileSize: number;
  let modifiedAt: string;

  try {
    const fileHandle = await open(options.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const initialStats = await fileHandle.stat();
      if (!initialStats.isFile()) {
        return invalidFileRecord(
          options.relativePath,
          [
            diagnostic(
              "NON_REGULAR_FILE",
              options.relativePath,
              "Only regular Markdown files can be Assets",
            ),
          ],
        );
      }
      bytes = await fileHandle.readFile();
      const finalStats = await fileHandle.stat();
      fileSize = finalStats.size;
      modifiedAt = finalStats.mtime.toISOString();
    } finally {
      await fileHandle.close();
    }
  } catch (error) {
    return invalidFileRecord(
      options.relativePath,
      [
        diagnostic("FILE_READ_ERROR", options.relativePath, `Unable to read Markdown file: ${errorMessage(error)}`),
      ],
    );
  }

  let source: string;
  try {
    source = utf8Decoder.decode(bytes);
  } catch (error) {
    return invalidFileRecord(
      options.relativePath,
      [
        diagnostic("INVALID_FRONTMATTER", options.relativePath, `Markdown must be valid UTF-8: ${errorMessage(error)}`),
      ],
    );
  }

  let parsedMatter;
  try {
    parsedMatter = parseYamlFrontmatter(source);
  } catch (error) {
    return invalidFileRecord(
      options.relativePath,
      [
        diagnostic("INVALID_FRONTMATTER", options.relativePath, `Unable to parse YAML frontmatter: ${errorMessage(error)}`),
      ],
    );
  }

  if (parsedMatter === undefined) {
    return invalidFileRecord(
      options.relativePath,
      [
        diagnostic("MISSING_FRONTMATTER", options.relativePath, "Markdown file has no YAML frontmatter"),
      ],
    );
  }

  const specialFrontmatterDiagnostic = classifyFrontmatterFailure(parsedMatter.data, options.relativePath);
  const parsedFrontmatter = assetFrontmatterSchema.safeParse(parsedMatter.data);
  const parsedId = isRecord(parsedMatter.data) ? assetIdSchema.safeParse(parsedMatter.data.id) : undefined;

  if (!parsedFrontmatter.success) {
    return invalidFileRecord(
      options.relativePath,
      [
        specialFrontmatterDiagnostic ??
          diagnostic(
            "INVALID_FRONTMATTER",
            options.relativePath,
            `Frontmatter does not match the Asset schema: ${parsedFrontmatter.error.issues
              .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
              .join("; ")}`,
          ),
      ],
      parsedId?.success === true ? parsedId.data : undefined,
    );
  }

  const candidateDiagnostics = validateLocation(
    parsedFrontmatter.data,
    options.location,
    options.relativePath,
    options.workspaceNames,
  );

  return {
    asset: {
      absolutePath: options.absolutePath,
      content: parsedMatter.content,
      contentHash: computeContentHash(bytes),
      fileSize,
      frontmatter: parsedFrontmatter.data,
      markdown: source,
      rawContent: bytes,
      modifiedAt,
      relativePath: options.relativePath,
    },
    diagnostics: candidateDiagnostics,
    id: parsedFrontmatter.data.id,
    relativePath: options.relativePath,
  };
}

// Both full and targeted scans revalidate here immediately before opening a file.
// Only the configured root and descendants reject symlinks; system aliases ABOVE
// the root (e.g. macOS /var) remain valid. This is not an atomic filesystem walk.
async function validateCurrentFilePath(options: ReadCandidateOptions): Promise<AssetDiagnostic | undefined> {
  const { repositoryPath, absolutePath, relativePath } = options;
  const withinRepository = relative(repositoryPath, absolutePath);
  if (withinRepository === "" || withinRepository === ".." || withinRepository.startsWith(`..${sep}`) || isAbsolute(withinRepository)) {
    return diagnostic("INVALID_ASSET_PATH", relativePath, "Asset file must be inside the configured Repository");
  }

  try {
    const root = await lstat(repositoryPath);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      return diagnostic("REPOSITORY_UNAVAILABLE", relativePath, "Asset Repository must be a regular directory and must not be a symlink");
    }
  } catch (error) {
    return diagnostic("REPOSITORY_UNAVAILABLE", relativePath, `Asset Repository is unavailable: ${errorMessage(error)}`);
  }

  try {
    const realRepositoryPath = await realpath(repositoryPath);
    const parts = withinRepository.split(sep);
    let currentPath = repositoryPath;
    for (const [index, part] of parts.entries()) {
      currentPath = join(currentPath, part);
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        return diagnostic("SYMLINK", relativePath, "Asset files and their Repository-relative parents must not be symlinks");
      }
      if (index < parts.length - 1) {
        if (!stats.isDirectory()) {
          return diagnostic("FILE_READ_ERROR", relativePath, "Asset parent must be a directory");
        }
      } else if (!stats.isFile()) {
        return diagnostic(stats.isDirectory() ? "DIRECTORY_ASSET" : "NON_REGULAR_FILE", relativePath, "Only regular Markdown files can be Assets");
      }
    }
    const realRelativePath = relative(realRepositoryPath, await realpath(absolutePath));
    if (realRelativePath === "" || realRelativePath === ".." || realRelativePath.startsWith(`..${sep}`) || isAbsolute(realRelativePath)) {
      return diagnostic("INVALID_ASSET_PATH", relativePath, "Resolved Asset file must remain inside the configured Repository");
    }
  } catch (error) {
    return diagnostic("FILE_READ_ERROR", relativePath, `Unable to validate current Asset path: ${errorMessage(error)}`);
  }
  return undefined;
}

function classifyFrontmatterFailure(data: unknown, relativePath: string): AssetDiagnostic | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  if (typeof data.type === "string" && !ASSET_TYPES.some((type) => type === data.type)) {
    return diagnostic("UNKNOWN_ASSET_TYPE", relativePath, `Unknown Asset type: ${data.type}`);
  }

  if (data.scope === "GLOBAL" && Object.hasOwn(data, "workspace")) {
    return diagnostic(
      "GLOBAL_WORKSPACE_FORBIDDEN",
      relativePath,
      "GLOBAL Asset frontmatter must not contain workspace",
    );
  }

  if (data.scope === "WORKSPACE" && !Object.hasOwn(data, "workspace")) {
    return diagnostic("WORKSPACE_REQUIRED", relativePath, "WORKSPACE Asset frontmatter requires workspace");
  }

  return undefined;
}

function validateLocation(
  frontmatter: AssetFrontmatter,
  location: AssetLocation | undefined,
  relativePath: string,
  workspaceNames: Set<string>,
): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];

  if (location === undefined) {
    diagnostics.push(
      diagnostic("INVALID_ASSET_PATH", relativePath, "File is outside the formal Asset layout"),
    );
    return diagnostics;
  }

  if (frontmatter.type !== location.type) {
    diagnostics.push(
      diagnostic(
        "PATH_TYPE_MISMATCH",
        relativePath,
        `Frontmatter type ${frontmatter.type} does not match directory type ${location.type}`,
      ),
    );
  }

  if (frontmatter.scope !== location.scope) {
    diagnostics.push(
      diagnostic(
        "PATH_SCOPE_MISMATCH",
        relativePath,
        `Frontmatter scope ${frontmatter.scope} does not match directory scope ${location.scope}`,
      ),
    );
  }

  if (frontmatter.scope === "WORKSPACE") {
    if (!workspaceNames.has(frontmatter.workspace)) {
      diagnostics.push(
        diagnostic(
          "UNKNOWN_WORKSPACE",
          relativePath,
          `Frontmatter workspace is not configured: ${frontmatter.workspace}`,
        ),
      );
    }

    if (location.scope === "WORKSPACE" && frontmatter.workspace !== location.workspace) {
      diagnostics.push(
        diagnostic(
          "PATH_WORKSPACE_MISMATCH",
          relativePath,
          `Frontmatter workspace ${frontmatter.workspace} does not match directory workspace ${location.workspace}`,
        ),
      );
    }
  }

  if (
    location.scope === "WORKSPACE" &&
    !workspaceNames.has(location.workspace) &&
    !(frontmatter.scope === "WORKSPACE" && frontmatter.workspace === location.workspace)
  ) {
    diagnostics.push(
      diagnostic(
        "UNKNOWN_WORKSPACE",
        relativePath,
        `Directory workspace is not configured: ${location.workspace}`,
      ),
    );
  }

  return deduplicateDiagnostics(diagnostics);
}

function parseAssetLocation(relativeParts: string[]): AssetLocation | undefined {
  if (relativeParts.length === 3 && relativeParts[0] === "global") {
    const type = typeFromDirectory(relativeParts[1]);
    return type === undefined ? undefined : { scope: "GLOBAL", type };
  }

  if (relativeParts.length === 4 && relativeParts[0] === "workspaces") {
    const workspace = relativeParts[1];
    const type = typeFromDirectory(relativeParts[2]);
    return workspace === undefined || type === undefined
      ? undefined
      : { scope: "WORKSPACE", type, workspace };
  }

  return undefined;
}

function safeAssetRelativeParts(relativePath: string): string[] | undefined {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/")
  ) {
    return undefined;
  }

  const parts = relativePath.split("/");
  if (
    parts[0] !== "assets" ||
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return undefined;
  }

  return parts.slice(1);
}

function isStructuralDirectory(relativeParts: string[]): boolean {
  if (relativeParts.length === 1) {
    return relativeParts[0] === "global" || relativeParts[0] === "workspaces";
  }

  if (relativeParts.length === 2) {
    return (
      (relativeParts[0] === "global" && typeFromDirectory(relativeParts[1]) !== undefined) ||
      (relativeParts[0] === "workspaces" && relativeParts[1] !== undefined)
    );
  }

  return (
    relativeParts.length === 3 &&
    relativeParts[0] === "workspaces" &&
    relativeParts[1] !== undefined &&
    typeFromDirectory(relativeParts[2]) !== undefined
  );
}

function isAssetContainer(relativeParts: string[]): boolean {
  return (
    (relativeParts.length === 2 &&
      relativeParts[0] === "global" &&
      typeFromDirectory(relativeParts[1]) !== undefined) ||
    (relativeParts.length === 3 &&
      relativeParts[0] === "workspaces" &&
      relativeParts[1] !== undefined &&
      typeFromDirectory(relativeParts[2]) !== undefined)
  );
}

function typeFromDirectory(directory: string | undefined): AssetType | undefined {
  if (directory === undefined || !Object.hasOwn(TYPE_BY_DIRECTORY, directory)) {
    return undefined;
  }

  return TYPE_BY_DIRECTORY[directory as keyof typeof TYPE_BY_DIRECTORY];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFileRecord(
  relativePath: string,
  diagnostics: AssetDiagnostic[],
  id?: string,
): ScannedFileRecord {
  return id === undefined
    ? { diagnostics, relativePath }
    : { diagnostics, id, relativePath };
}

function diagnostic(
  code: AssetDiagnosticCode,
  path: string,
  message: string,
  assetId?: string,
): AssetDiagnostic {
  return assetId === undefined ? { code, message, path } : { assetId, code, message, path };
}

function deduplicateDiagnostics(diagnostics: AssetDiagnostic[]): AssetDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = `${item.code}\0${item.path}\0${item.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function compareDiagnostics(left: AssetDiagnostic, right: AssetDiagnostic): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
