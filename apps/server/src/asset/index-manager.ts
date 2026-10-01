import { mkdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { watch, type FSWatcher } from "chokidar";
import { hasRepositoryAccess, needsRepositoryAccess, withRepositoryAccess } from "./coordination.js";

import {
  AssetCatalog,
  CatalogRebuildRequiredError,
  type CatalogCounts,
  type CatalogSyncResult,
} from "./catalog.js";
import {
  scanAssetRepository,
  type AssetDiagnostic,
  type AssetScanOptions,
  type AssetScanResult,
} from "./scanner.js";

export type IndexState = "NOT_READY" | "READY" | "DEGRADED" | "REBUILD_REQUIRED";
export type WatcherState = "NOT_STARTED" | "STARTING" | "RUNNING" | "DEGRADED" | "STOPPED";
export type IndexDiagnosticSource = "SCANNER" | "INDEX" | "WATCHER";

export interface IndexDiagnostic {
  code: string;
  message: string;
  occurredAt: string;
  path?: string;
  source: IndexDiagnosticSource;
}

export interface AssetIndexStatus {
  catalogCount: number | null;
  diagnostics: IndexDiagnostic[];
  ftsCount: number | null;
  indexState: IndexState;
  lastSuccessfulScanAt: string | null;
  rebuildRequired: boolean;
  watcherState: WatcherState;
}

type AssetScanner = (options: AssetScanOptions) => Promise<AssetScanResult>;

export interface AssetIndexOptions extends AssetScanOptions {
  databasePath: string;
  debounceMs?: number;
  now?: () => Date;
  scanner?: AssetScanner;
}

export class AssetIndexManager {
  readonly #assetsPath: string;
  readonly #catalog: AssetCatalog;
  readonly #debounceMs: number;
  readonly #now: () => Date;
  readonly #repositoryPath: string;
  readonly #scanOptions: AssetScanOptions;
  readonly #scanner: AssetScanner;
  readonly #workspaceConfigPath: string;
  #closed = false;
  #debounceTimer: NodeJS.Timeout | null = null;
  #indexState: IndexState;
  #lastSuccessfulScanAt: string | null = null;
  #pendingOperation: Promise<void> = Promise.resolve();
  #runtimeDiagnostics: IndexDiagnostic[] = [];
  #scannerDiagnostics: IndexDiagnostic[] = [];
  #watchers: FSWatcher[] = [];
  #watcherState: WatcherState = "NOT_STARTED";
  #starting = false;
  #startPromise: Promise<AssetIndexStatus> | undefined;

  private constructor(options: AssetIndexOptions) {
    this.#repositoryPath = resolve(options.repositoryPath);
    this.#workspaceConfigPath = resolve(options.workspaceConfigPath);
    this.#assetsPath = join(this.#repositoryPath, "assets");
    this.#scanOptions = {
      repositoryPath: this.#repositoryPath,
      workspaceConfigPath: this.#workspaceConfigPath,
    };
    this.#scanner = options.scanner ?? scanAssetRepository;
    this.#debounceMs = options.debounceMs ?? 100;
    this.#now = options.now ?? (() => new Date());
    this.#catalog = new AssetCatalog(options.databasePath);
    this.#indexState = this.#catalog.rebuildReason === null ? "NOT_READY" : "REBUILD_REQUIRED";

    if (this.#catalog.rebuildReason !== null) {
      this.#setRuntimeDiagnostic(
        "INDEX",
        "CATALOG_REBUILD_REQUIRED",
        this.#catalog.rebuildReason,
      );
    }
  }

  static async create(options: AssetIndexOptions): Promise<AssetIndexManager> {
    if (options.databasePath !== ":memory:") {
      await mkdir(dirname(resolve(options.databasePath)), { recursive: true });
    }
    return new AssetIndexManager(options);
  }

  async start(): Promise<AssetIndexStatus> {
    this.#assertOpen();
    if (this.#starting && this.#startPromise !== undefined) return this.#startPromise;
    if (this.#watchers.length > 0) return this.status();
    this.#starting = true;
    this.#startPromise = (async () => {
      try {
        await this.synchronize();
        await this.#startWatcher();
        // ignoreInitial does not report changes between the first scan and ready.
        // Reconcile through the same queue as ordinary watcher events.
        await this.synchronize();
      } finally {
        this.#starting = false;
      }
      return this.status();
    })();
    return this.#startPromise;
  }

  synchronize(): Promise<CatalogSyncResult | null> {
    this.#assertOpen();
    if (hasRepositoryAccess(this.#repositoryPath)) return this.#scanAndApply(false);
    return this.#enqueue(() => this.#scanAndApply(false));
  }

  rebuild(): Promise<CatalogSyncResult | null> {
    this.#assertOpen();
    return this.#enqueue(() => this.#scanAndApply(true));
  }

  status(): AssetIndexStatus {
    this.#assertOpen();
    let counts: CatalogCounts | null = null;
    const consistencyFailure = this.#catalog.checkConsistency();

    if (consistencyFailure !== null) {
      this.#indexState = "REBUILD_REQUIRED";
      this.#setRuntimeDiagnostic(
        "INDEX",
        "CATALOG_REBUILD_REQUIRED",
        consistencyFailure,
      );
    } else {
      try {
        counts = this.#catalog.counts();
      } catch (error) {
        this.#indexState = "REBUILD_REQUIRED";
        this.#setRuntimeDiagnostic(
          "INDEX",
          "CATALOG_REBUILD_REQUIRED",
          `Unable to read Catalog/FTS counts: ${errorMessage(error)}`,
        );
      }
    }

    return {
      catalogCount: counts?.catalog ?? null,
      diagnostics: [...this.#scannerDiagnostics, ...this.#runtimeDiagnostics].sort(compareDiagnostics),
      ftsCount: counts?.fts ?? null,
      indexState: this.#starting && this.#indexState === "READY" ? "NOT_READY" : this.#indexState,
      lastSuccessfulScanAt: this.#lastSuccessfulScanAt,
      rebuildRequired: this.#indexState === "REBUILD_REQUIRED",
      watcherState: this.#watcherState,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    if (this.#watchers.length > 0) {
      await Promise.all(this.#watchers.map((watcher) => watcher.close()));
      this.#watchers = [];
    }
    this.#watcherState = "STOPPED";
    await this.#pendingOperation;
    this.#catalog.close();
  }

  async #scanAndApply(rebuild: boolean): Promise<CatalogSyncResult | null> {
    if (needsRepositoryAccess(this.#repositoryPath)) return withRepositoryAccess(this.#repositoryPath, () => this.#scanAndApply(rebuild));
    if (!rebuild && this.#catalog.rebuildReason !== null) {
      this.#indexState = "REBUILD_REQUIRED";
      this.#setRuntimeDiagnostic(
        "INDEX",
        "CATALOG_REBUILD_REQUIRED",
        this.#catalog.rebuildReason,
      );
      return null;
    }

    let result: AssetScanResult;
    try {
      result = await this.#scanner(this.#scanOptions);
    } catch (error) {
      this.#scannerDiagnostics = [];
      this.#setRuntimeDiagnostic(
        "SCANNER",
        "SCANNER_EXCEPTION",
        `Asset Scanner failed: ${errorMessage(error)}`,
      );
      this.#markRecoverableFailure();
      return null;
    }

    const occurredAt = this.#now().toISOString();
    this.#scannerDiagnostics = result.diagnostics.map((diagnostic) =>
      scannerDiagnostic(diagnostic, occurredAt),
    );
    this.#removeRuntimeDiagnostic("SCANNER", "SCANNER_EXCEPTION");

    if (!result.isComplete) {
      this.#setRuntimeDiagnostic(
        "SCANNER",
        "INCOMPLETE_SCAN_SNAPSHOT",
        "The Asset Scanner could not confirm a complete repository snapshot; Catalog/FTS were not changed",
      );
      this.#markRecoverableFailure();
      return null;
    }

    this.#removeRuntimeDiagnostic("SCANNER", "INCOMPLETE_SCAN_SNAPSHOT");

    try {
      const indexedAt = this.#now().toISOString();
      const syncResult = rebuild
        ? this.#catalog.rebuild(result.assets, indexedAt)
        : this.#catalog.applySnapshot(result.assets, result.diagnostics, indexedAt);

      this.#lastSuccessfulScanAt = indexedAt;
      this.#removeRuntimeDiagnostic("INDEX", "INDEX_UPDATE_FAILED");
      this.#removeRuntimeDiagnostic("INDEX", "CATALOG_REBUILD_REQUIRED");
      this.#indexState = this.#watcherState === "DEGRADED" ? "DEGRADED" : "READY";
      return syncResult;
    } catch (error) {
      const consistencyFailure = this.#catalog.checkConsistency();
      if (error instanceof CatalogRebuildRequiredError || consistencyFailure !== null) {
        this.#indexState = "REBUILD_REQUIRED";
        this.#setRuntimeDiagnostic(
          "INDEX",
          "CATALOG_REBUILD_REQUIRED",
          consistencyFailure ?? errorMessage(error),
        );
      } else {
        this.#setRuntimeDiagnostic(
          "INDEX",
          "INDEX_UPDATE_FAILED",
          `Catalog/FTS transaction failed and was rolled back: ${errorMessage(error)}`,
        );
        this.#markRecoverableFailure();
      }
      return null;
    }
  }

  async #startWatcher(): Promise<void> {
    this.#watcherState = "STARTING";
    const assetWatcher = watch(this.#repositoryPath, {
      atomic: true,
      followSymlinks: false,
      ignoreInitial: true,
      persistent: true,
    });
    const workspaceConfigWatcher = watch(dirname(this.#workspaceConfigPath), {
      atomic: true,
      depth: 0,
      followSymlinks: false,
      ignoreInitial: true,
      persistent: true,
    });
    this.#watchers = [assetWatcher, workspaceConfigWatcher];

    assetWatcher.on("all", (event, changedPath) => {
      if (this.#shouldScheduleScan(event, changedPath)) {
        this.#scheduleScan();
      }
    });
    workspaceConfigWatcher.on("all", (_event, changedPath) => {
      if (resolve(changedPath) === this.#workspaceConfigPath) {
        this.#scheduleScan();
      }
    });
    assetWatcher.on("error", (error) => this.#handleWatcherError(error));
    workspaceConfigWatcher.on("error", (error) => this.#handleWatcherError(error));

    await Promise.all([
      waitForWatcher(assetWatcher),
      waitForWatcher(workspaceConfigWatcher),
    ]);
    this.#markWatcherRunning();
  }

  #shouldScheduleScan(event: string, changedPath: string): boolean {
    const absolutePath = resolve(changedPath);
    if (absolutePath === this.#workspaceConfigPath || absolutePath === this.#assetsPath) {
      return true;
    }

    const relativePath = relative(this.#assetsPath, absolutePath);
    const insideAssets =
      relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
    return (
      insideAssets &&
      (extname(absolutePath).toLowerCase() === ".md" || event === "addDir" || event === "unlinkDir")
    );
  }

  #scheduleScan(): void {
    if (this.#closed) {
      return;
    }

    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.synchronize();
    }, this.#debounceMs);
  }

  #handleWatcherError(error: unknown): void {
    this.#watcherState = "DEGRADED";
    this.#setRuntimeDiagnostic(
      "WATCHER",
      "WATCHER_ERROR",
      `Asset watcher failed: ${errorMessage(error)}`,
    );
    this.#markRecoverableFailure();
  }

  #markWatcherRunning(): void {
    if (this.#watcherState !== "DEGRADED") {
      this.#watcherState = "RUNNING";
    }
  }

  #markRecoverableFailure(): void {
    if (this.#indexState === "REBUILD_REQUIRED") {
      return;
    }
    this.#indexState = this.#lastSuccessfulScanAt === null ? "NOT_READY" : "DEGRADED";
  }

  #setRuntimeDiagnostic(source: IndexDiagnosticSource, code: string, message: string): void {
    this.#removeRuntimeDiagnostic(source, code);
    this.#runtimeDiagnostics.push({
      code,
      message,
      occurredAt: this.#now().toISOString(),
      source,
    });
  }

  #removeRuntimeDiagnostic(source: IndexDiagnosticSource, code: string): void {
    this.#runtimeDiagnostics = this.#runtimeDiagnostics.filter(
      (diagnostic) => diagnostic.source !== source || diagnostic.code !== code,
    );
  }

  #enqueue(operation: () => Promise<CatalogSyncResult | null>): Promise<CatalogSyncResult | null> {
    const result = this.#pendingOperation.then(operation);
    this.#pendingOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("AssetIndexManager is closed");
    }
  }
}

function waitForWatcher(watcher: FSWatcher): Promise<void> {
  return new Promise((resolveReady) => {
    const onReady = (): void => {
      watcher.off("error", onError);
      resolveReady();
    };
    const onError = (): void => {
      watcher.off("ready", onReady);
      resolveReady();
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
}

function scannerDiagnostic(diagnostic: AssetDiagnostic, occurredAt: string): IndexDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    occurredAt,
    path: diagnostic.path,
    source: "SCANNER",
  };
}

function compareDiagnostics(left: IndexDiagnostic, right: IndexDiagnostic): number {
  return (
    left.source.localeCompare(right.source) ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
