import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { KnowledgeRepository } from "./knowledge/repository.js";
import { DATABASE_VERSION, DatabaseSchemaError, initializeDatabase } from "./storage/schema.js";

export async function runMaintenanceCli(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const command = args[0];
    const databasePath = absoluteEnvironment(environment, "PRECEDENT_LOOP_DATABASE_PATH");
    if (command === "init-database") {
      if (args.length !== 2 || args[1] !== "--offline") throw new Error("Use init-database --offline for a new, empty database after stopping writers");
      initializeDatabase(databasePath);
      stdout.write(`${JSON.stringify({ ok: true, schemaVersion: DATABASE_VERSION })}\n`);
    } else if (command === "revoke-capability") {
      if (args.length !== 3 || args[1] !== "--digest" || !/^[a-f0-9]{64}$/.test(args[2] ?? "")) throw new Error("Use revoke-capability --digest <stored digest>");
      const repository = new KnowledgeRepository(databasePath);
      try { stdout.write(JSON.stringify({ revoked: repository.revokeCapability(args[2]!) }) + "\n"); }
      finally { repository.close(); }
    } else { throw new Error("Expected init-database or revoke-capability"); }
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
