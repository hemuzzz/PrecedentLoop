import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonFileLogger, LOG_PATH_ENV, logPathFromEnvironment } from "../src/logging.js";

test("N08 resolves one log path and writes required structured failure fields", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n08-log-"));
  const logPath = join(rootPath, "logs", "precedent-loop.log");
  try {
    assert.equal(logPathFromEnvironment({ [LOG_PATH_ENV]: logPath }), logPath);
    assert.throws(() => logPathFromEnvironment({ [LOG_PATH_ENV]: "relative.log" }));
    assert.match(logPathFromEnvironment({}), /\/logs\/precedent-loop\.log$/u);

    const logger = new JsonFileLogger(logPath, () => "2026-09-04T13:00:00.000Z");
    logger.error({
      event: "USAGE_RECALL_WRITE_FAILED",
      operation: "RECALL",
      assetIds: ["ast100", "ast101"],
      errorCode: "USAGE_WRITE_FAILED",
      error: new Error("database is read-only"),
    });
    const entry = JSON.parse((await readFile(logPath, "utf8")).trim()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(entry),
      [
        "timestamp",
        "level",
        "event",
        "operation",
        "assetIds",
        "errorCode",
        "errorMessage",
        "stack",
      ],
    );
    assert.equal(entry.timestamp, "2026-09-04T13:00:00.000Z");
    assert.equal(entry.level, "ERROR");
    assert.equal(entry.errorMessage, "database is read-only");
    assert.match(String(entry.stack), /Error: database is read-only/u);
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
});
