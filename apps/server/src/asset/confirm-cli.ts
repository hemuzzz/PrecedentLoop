import { isAbsolute, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { RepositoryOperationError } from "./coordination.js";

import {
  AssetConfirmationError,
  confirmInboxAsset,
  type AssetConfirmationInput,
} from "./confirmation.js";

export const CONFIRM_ASSET_REPOSITORY_PATH_ENV = "PRECEDENT_LOOP_ASSET_REPOSITORY_PATH";
export const CONFIRM_WORKSPACE_CONFIG_PATH_ENV = "PRECEDENT_LOOP_WORKSPACES_PATH";

export async function runAssetConfirmationCli(
  args: readonly string[] = process.argv.slice(2),
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const input = parseArguments(args);
    const configuration = configurationFromEnvironment(environment);
    const result = await confirmInboxAsset(input, configuration);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AssetConfirmationError || error instanceof RepositoryOperationError) {
      stderr.write(
        `${JSON.stringify({
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof AssetConfirmationError && error.relativePath !== undefined ? { relativePath: error.relativePath } : {}),
          },
        })}\n`,
      );
      return error instanceof AssetConfirmationError ? (operationalFailure(error.code) ? 1 : 2)
        : /FAILED|RECOVERY|BUSY/u.test(error.code) ? 1 : 2;
    }
    stderr.write(
      `${JSON.stringify({
        ok: false,
        error: { code: "CONFIRM_FAILED", message: "Asset confirmation failed" },
      })}\n`,
    );
    return 1;
  }
}

export function parseArguments(args: readonly string[]): AssetConfirmationInput {
  const commandArguments = args[0] === "--" ? args.slice(1) : args;
  const values = new Map<string, string>();
  const allowed = new Set(["--relative-path", "--expected-content-hash", "--update-asset-id", "--expected-baseline-hash", "--request-id"]);

  for (let index = 0; index < commandArguments.length; index += 2) {
    const name = commandArguments[index];
    const value = commandArguments[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      values.has(name) ||
      value.startsWith("--")
    ) {
      throw new AssetConfirmationError(
        "CONFIRM_INPUT_INVALID",
        "Exactly one --relative-path and one --expected-content-hash are required",
      );
    }
    values.set(name, value);
  }

  const relativePath = values.get("--relative-path");
  const expectedContentHash = values.get("--expected-content-hash");
  if (![2, 3, 4, 5].includes(values.size) || relativePath === undefined || expectedContentHash === undefined) {
    throw new AssetConfirmationError(
      "CONFIRM_INPUT_INVALID",
      "Exactly one --relative-path and one --expected-content-hash are required",
    );
  }
  const updateAssetId = values.get("--update-asset-id");
  const expectedBaselineHash = values.get("--expected-baseline-hash");
  if ((updateAssetId === undefined) !== (expectedBaselineHash === undefined)) {
    throw new AssetConfirmationError("CONFIRM_INPUT_INVALID", "Update requires both --update-asset-id and --expected-baseline-hash");
  }
  const requestId = values.get("--request-id");
  if (requestId !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/u.test(requestId)) throw new AssetConfirmationError("CONFIRM_INPUT_INVALID", "Invalid request ID");
  return { expectedContentHash, relativePath, ...(requestId === undefined ? {} : { requestId }), ...(updateAssetId === undefined ? {} : { updateAssetId, expectedBaselineHash: expectedBaselineHash! }) };
}

function configurationFromEnvironment(environment: NodeJS.ProcessEnv): {
  databasePath: string;
  repositoryPath: string;
  workspaceConfigPath: string;
} {
  const databasePath = environment.PRECEDENT_LOOP_DATABASE_PATH;
  const repositoryPath = environment[CONFIRM_ASSET_REPOSITORY_PATH_ENV];
  const workspaceConfigPath = environment[CONFIRM_WORKSPACE_CONFIG_PATH_ENV];
  if (
    databasePath === undefined || !isAllowedAbsolutePath(databasePath) ||
    repositoryPath === undefined ||
    workspaceConfigPath === undefined ||
    !isAllowedAbsolutePath(repositoryPath) ||
    !isAllowedAbsolutePath(workspaceConfigPath)
  ) {
    throw new AssetConfirmationError(
      "CONFIRM_CONFIGURATION_INVALID",
      `${CONFIRM_ASSET_REPOSITORY_PATH_ENV}, ${CONFIRM_WORKSPACE_CONFIG_PATH_ENV}, and PRECEDENT_LOOP_DATABASE_PATH must be absolute paths`,
    );
  }
  return { databasePath, repositoryPath, workspaceConfigPath };
}

function operationalFailure(code: AssetConfirmationError["code"]): boolean {
  return (
    code === "CONFIRM_BUSY" || code === "CONFIRM_PARTIAL_WRITE" || code === "CONFIRM_RECOVERY_REQUIRED" ||
    code === "ASSET_COPY_FAILED" ||
    code === "POST_MOVE_VALIDATION_FAILED" ||
    code === "SOURCE_REMOVE_FAILED"
  );
}

function isAllowedAbsolutePath(path: string): boolean {
  return path.length > 0 && (isAbsolute(path) || win32.isAbsolute(path));
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  process.exitCode = await runAssetConfirmationCli();
}
