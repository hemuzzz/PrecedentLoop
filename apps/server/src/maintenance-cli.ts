import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetCatalog, scanAssetRepository } from "./asset/index.js";
import { KnowledgeRepository } from "./knowledge/repository.js";
import { DatabaseSchemaError, initializeDatabase } from "./storage/schema.js";
import { rebindRepositoryCoordination } from "./asset/coordination.js";

export async function runMaintenanceCli(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const command = args[0];
    const databasePath = absoluteEnvironment(environment, "PRECEDENT_LOOP_DATABASE_PATH");
    if (command === "rebuild-index") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use rebuild-index --offline only after stopping the service and all same-database Hooks/writers");
      const repositoryPath = absoluteEnvironment(environment, "PRECEDENT_LOOP_ASSET_REPOSITORY_PATH");
      const workspaceConfigPath = absoluteEnvironment(environment, "PRECEDENT_LOOP_WORKSPACES_PATH");
      // No Catalog construction or schema writes before the complete Snapshot gate.
      const snapshot = await scanAssetRepository({ repositoryPath, workspaceConfigPath });
      if (!snapshot.isComplete) throw new Error("Complete Asset Snapshot unavailable; database was not changed");
      const catalog = new AssetCatalog(databasePath, { maintenance: true });
      try {
        const result = catalog.rebuild(snapshot.assets, new Date().toISOString());
        stdout.write(`${JSON.stringify({ ok: true, result, diagnostics: snapshot.diagnostics })}\n`);
      } finally { catalog.close(); }
    } else if (command === "init-database") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use init-database --offline for a new, empty database after stopping writers");
      initializeDatabase(databasePath);
      stdout.write('{"ok":true,"schemaVersion":1}\n');
    } else if (command === "rebind-coordination") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use rebind-coordination --offline only for a stopped, copied data directory");
      const repositoryPath = absoluteEnvironment(environment, "PRECEDENT_LOOP_ASSET_REPOSITORY_PATH");
      const rebound = await rebindRepositoryCoordination(repositoryPath, databasePath);
      stdout.write(`${JSON.stringify({ ok: true, rebound })}\n`);
    } else if (command === "revoke-capability") {
      if (args.length !== 3 || args[1] !== "--digest" || !/^[a-f0-9]{64}$/.test(args[2] ?? "")) throw new Error("Use revoke-capability --digest <stored digest>");
      const repository = new KnowledgeRepository(databasePath);
      try { stdout.write(JSON.stringify({ revoked: repository.db.prepare("DELETE FROM workspace_capability WHERE capability_key_hash=?").run(args[2]).changes }) + "\n"); }
      finally { repository.close(); }
    } else { throw new Error("Expected init-database, rebuild-index, rebind-coordination or revoke-capability"); }
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: { code: error instanceof DatabaseSchemaError ? error.code : "MAINTENANCE_FAILED", message: error instanceof Error ? error.message : String(error) } })}\n`);
    return 1;
  }
}

function absoluteEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) process.exitCode = await runMaintenanceCli();
