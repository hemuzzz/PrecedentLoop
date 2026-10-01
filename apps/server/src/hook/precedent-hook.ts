import { appendFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hookConfiguration, hookUserData } from "./launcher-config.js";
import { integrationActivityDirectory, recordHookActivity } from "../integration-activity.js";
import type { HookEvent } from "../integration-activity.js";
import type { HookHost } from "./capture-assessment.js";

const events = { "user-prompt-submit": "UserPromptSubmit", "post-tool-use": "PostToolUse", stop: "Stop", record: "record" } as const;
function logFailure(userData: string, error: unknown): void {
  try {
    mkdirSync(join(userData, "logs"), { recursive: true, mode: 0o700 });
    // Codes only: validation errors may contain prompt/session/config values.
    const code = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : "HOOK_UNAVAILABLE";
    appendFileSync(join(userData, "logs/hook.log"), `${new Date().toISOString()} ${code}\n`, { mode: 0o600 });
  } catch { /* Logging must never change Hook exit semantics. */ }
}

export async function runPrecedentHook(args = process.argv.slice(2)): Promise<void> {
  const recording = args[1] === "record";
  let userData = join(homedir(), "Library/Application Support/PrecedentLoop");
  const fail = (error: unknown) => {
    logFailure(userData, error);
    if (recording) {
      process.stderr.write("Precedent Loop: assessment not recorded.\nFormat: sessionId, turnId, outcome (NO_INCREMENT|CANDIDATE|FAILED|SKIPPED), reason, references (required for CANDIDATE).\n");
      process.exitCode = 1;
    }
  };
  // Set before reading stdin/importing SQLite; capture never waits for a database.
  const timer = setTimeout(() => {
    fail(new Error("Hook timeout"));
    process.exit(recording ? 1 : 0);
  }, args[1] === "user-prompt-submit" ? 9000 : 750);
  try {
    userData = hookUserData(args.slice(2));
    const host = args[0]; const event = args[1];
    if ((host !== "codex" && host !== "claude") || !Object.hasOwn(events, event ?? "")) throw new Error("Invalid Hook arguments");
    const hostName: HookHost = host;
    const eventName = event as HookEvent;
    const configuration = await hookConfiguration(userData);
    for (const directory of [configuration.dataDirectory, join(configuration.dataDirectory, "runtime")]) {
      if (!(await stat(directory)).isDirectory()) throw new Error("Data directory unavailable");
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > (recording ? 8192 : 1_000_000)) throw new Error("Input too large");
      chunks.push(bytes);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!recording && (typeof input !== "object" || input === null || !("hook_event_name" in input)
      || input.hook_event_name !== events[eventName])) throw new Error("Hook event mismatch");
    let output: string | null;
    let handlerSucceeded = true;
    // A handler may recover with useful context. Diagnostics never discard it.
    const onError = (error: unknown) => { handlerSucceeded = false; logFailure(userData, error); };
    if (eventName === "user-prompt-submit") {
      const { handleCodexHook } = await import("./user-prompt-submit.js");
      output = await handleCodexHook(input, {
        ...configuration,
        captureCommand: `"$HOME/.precedent/bin/precedent-hook" ${hostName} record`, onError,
      }, hostName);
    } else {
      const { handleCaptureHook, recordAssessment } = await import("./capture-assessment.js");
      if (recording) {
        await recordAssessment(configuration.captureCachePath, input, hostName);
        output = '{"recorded":true}';
      } else output = JSON.stringify(await handleCaptureHook(input, configuration.captureCachePath, hostName, onError));
    }
    if (!recording) {
      const { hostTurnIdentity } = await import("./capture-assessment.js");
      // Missing identity is another handled degradation, without an onError callback.
      try { hostTurnIdentity(input, hostName); } catch { handlerSucceeded = false; }
    }
    // Only full handler success is verification evidence. Observation failures
    // cannot invalidate returned context or a successfully saved assessment.
    if (handlerSucceeded) {
      try { await recordHookActivity(integrationActivityDirectory(configuration.databasePath), hostName, eventName); }
      catch (error) { logFailure(userData, error); }
    }
    if (output) process.stdout.write(output + "\n");
  } catch (error) { fail(error); }
  finally { clearTimeout(timer); }
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) await runPrecedentHook();
