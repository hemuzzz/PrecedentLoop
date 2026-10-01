import {
  scanInboxRepository,
  type AssetDiagnostic,
  type AssetDiagnosticCode,
  type AssetScanOptions,
} from "./scanner.js";
import type { AssetSearchService } from "./search.js";
import type { AssetFrontmatter } from "./schema.js";

export type InboxDiagnosticCode = AssetDiagnosticCode | "ID_CONFLICT";

export interface InboxDiagnostic {
  assetId?: string;
  code: InboxDiagnosticCode;
  message: string;
  relativePath: string;
}

export interface InboxItem {
  knowledgeNumber: number | null;
  candidateId?: string;
  assetId: string;
  contentHash: string;
  frontmatter: AssetFrontmatter;
  modifiedAt: string;
  rawMarkdown: string;
  relativePath: string;
  scope: AssetFrontmatter["scope"];
  summary: string;
  title: string;
  type: AssetFrontmatter["type"];
  workspace: string | null;
}

export interface InboxResult {
  diagnostics: InboxDiagnostic[];
  items: InboxItem[];
}

export class InboxUnavailableError extends Error {
  readonly code = "INBOX_SCAN_UNAVAILABLE";

  constructor(readonly reason: "REPOSITORY" | "SCANNER" | "WORKSPACE_CONFIGURATION") {
    super("Inbox could not be scanned completely");
    this.name = "InboxUnavailableError";
  }
}

export class InboxApplicationService {
  constructor(
    readonly options: AssetScanOptions,
    readonly assetSearchService: Pick<AssetSearchService, "existingCatalogAssetIds">,
  ) {}

  async scan(): Promise<InboxResult> {
    let result;
    try {
      result = await scanInboxRepository(this.options);
    } catch {
      throw new InboxUnavailableError("SCANNER");
    }
    if (!result.isComplete) {
      if (result.diagnostics.some(({ code }) => code === "INVALID_WORKSPACE_CONFIG")) {
        throw new InboxUnavailableError("WORKSPACE_CONFIGURATION");
      }
      if (result.diagnostics.some(({ code }) => code === "REPOSITORY_UNAVAILABLE")) {
        throw new InboxUnavailableError("REPOSITORY");
      }
      throw new InboxUnavailableError("SCANNER");
    }

    const formalIds = this.assetSearchService.existingCatalogAssetIds(
      result.assets.map(({ frontmatter }) => frontmatter.id),
    );
    const diagnostics: InboxDiagnostic[] = result.diagnostics.map((item) =>
      inboxDiagnostic(item, this.options)
    );
    for (const asset of result.assets) {
      if (formalIds.has(asset.frontmatter.id)) {
        diagnostics.push({
          assetId: asset.frontmatter.id,
          code: "ID_CONFLICT",
          message: "Inbox Asset ID conflicts with an existing formal Asset",
          relativePath: asset.relativePath,
        });
      }
    }

    return {
      items: result.assets
        .filter(({ frontmatter }) => !formalIds.has(frontmatter.id))
        .map((asset) => ({
          knowledgeNumber: null,
          assetId: asset.frontmatter.id,
          contentHash: asset.contentHash,
          frontmatter: asset.frontmatter,
          modifiedAt: asset.modifiedAt,
          rawMarkdown: asset.markdown,
          relativePath: asset.relativePath,
          scope: asset.frontmatter.scope,
          summary: asset.frontmatter.summary,
          title: asset.frontmatter.title,
          type: asset.frontmatter.type,
          workspace: asset.frontmatter.scope === "WORKSPACE" ? asset.frontmatter.workspace : null,
        })),
      diagnostics: diagnostics.sort(compareInboxDiagnostics),
    };
  }
}

export function inboxDiagnostic(diagnostic: AssetDiagnostic, options: AssetScanOptions): InboxDiagnostic {
  return {
    code: diagnostic.code,
    message: redactDiagnosticMessage(diagnostic.message, options),
    relativePath: diagnostic.path,
  };
}

function redactDiagnosticMessage(message: string, options: AssetScanOptions): string {
  let safe = message
    .replaceAll(options.repositoryPath, "<asset-repository>")
    .replaceAll(options.workspaceConfigPath, "<workspace-config>");
  safe = safe.replace(/(^|[\s('"`])(?:[A-Za-z]:[\\/]|\/)[^\s)'"`,;]*/gu, "$1<redacted-path>");
  return safe;
}

function compareInboxDiagnostics(left: InboxDiagnostic, right: InboxDiagnostic): number {
  return left.relativePath.localeCompare(right.relativePath) || left.code.localeCompare(right.code);
}
