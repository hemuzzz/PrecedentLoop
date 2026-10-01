import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetCatalog, scanAssetRepository } from "./asset/index.js";
import { KnowledgeRepository, migrateKnowledge, migrateRecallStorage } from "./knowledge/repository.js";
import { migrateCandidateStore } from "./asset/candidate-repository.js";
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
    } else if (command === "migrate-candidates") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use migrate-candidates --offline after stopping writers");
      migrateCandidateStore(databasePath);
      stdout.write('{"ok":true,"schemaVersion":6}\n');
    } else if (command === "migrate-knowledge") {
      if ((args.length !== 2 && args.length !== 3) || args[1] !== "--offline" || (args.length === 3 && args[2] !== "--initialize")) throw new Error("Use migrate-knowledge --offline [--initialize] after stopping writers");
      const schemaVersion = migrateKnowledge(databasePath, false, args[2] === "--initialize");
      stdout.write(`${JSON.stringify({ ok: true, schemaVersion })}\n`);
    } else if (command === "migrate-recall") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use migrate-recall --offline after stopping the service and all same-database Hooks/writers");
      const schemaVersion = migrateRecallStorage(databasePath);
      stdout.write(`${JSON.stringify({ ok: true, schemaVersion })}\n`);
    } else if (command === "retire-old-runtime") {
      if (args.length !== 3 || args[1] !== "--offline" || !["--accept-data-deletion", "--accept-data-deletion-after-manual-verification"].includes(args[2] ?? "")) throw new Error("Explicit deletion acknowledgement required");
      const schemaVersion = migrateKnowledge(databasePath, true);
      stdout.write(`${JSON.stringify({ ok: true, schemaVersion })}\n`);
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
    } else { throw new Error("Expected rebuild-index, migrate-knowledge, migrate-recall, migrate-candidates, rebind-coordination, retire-old-runtime or revoke-capability"); }
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: { code: "MAINTENANCE_FAILED", message: error instanceof Error ? error.message : String(error) } })}\n`);
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
