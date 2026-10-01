import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const LOG_PATH_ENV = "PRECEDENT_LOOP_LOG_PATH";

export type StructuredLogEvent =
  | "HOOK_CONTEXT_UNAVAILABLE"
  | "USAGE_READ_WRITE_FAILED"
  | "USAGE_RECALL_WRITE_FAILED"
  | "USAGE_USED_WRITE_FAILED";

export interface StructuredErrorLogInput {
  assetId?: string;
  assetIds?: readonly string[];
  error: unknown;
  errorCode: string;
  event: StructuredLogEvent;
  operation: string;
}

export interface StructuredLogger {
  error(input: StructuredErrorLogInput): void;
}

export class JsonFileLogger implements StructuredLogger {
  constructor(
    readonly logPath: string,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}

  error(input: StructuredErrorLogInput): void {
    const error = errorDetails(input.error);
    const entry = {
      timestamp: this.now(),
      level: "ERROR",
      event: input.event,
      operation: input.operation,
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      ...(input.assetIds === undefined ? {} : { assetIds: [...input.assetIds] }),
      errorCode: input.errorCode,
      errorMessage: error.message,
      stack: error.stack,
    };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function logPathFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const configured = environment[LOG_PATH_ENV];
  if (configured !== undefined) {
    if (!isAbsolute(configured) && !win32.isAbsolute(configured)) {
      throw new Error(`${LOG_PATH_ENV} must be an absolute path when configured`);
    }
    return configured;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, "../../..", "logs", "precedent-loop.log");
}

function errorDetails(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) {
      return {
        message: `${error.message}: ${cause.message}`,
        stack: `${error.stack ?? `${error.name}: ${error.message}`}\nCaused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`,
      };
    }
    return {
      message: error.message,
      stack: error.stack ?? `${error.name}: ${error.message}`,
    };
  }
  return { message: String(error), stack: String(error) };
}
