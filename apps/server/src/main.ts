import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  serverConfigurationFromEnvironment,
  startPrecedentLoopServer,
  type RunningPrecedentLoopServer,
} from "./runtime.js";

let runtime: RunningPrecedentLoopServer | undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  stopping = true;
  if (runtime === undefined) return Promise.resolve();
  shutdownPromise ??= runtime.close().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error;
    process.stderr.write(`${JSON.stringify({ event: "shutdown_error", name })}\n`);
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect();
  });
  return shutdownPromise;
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// A normal parent shutdown uses SIGTERM; an IPC disconnect must not orphan the backend.
process.on("disconnect", () => void shutdown());
process.send?.({ type: "booted" });

try {
  const configuration = serverConfigurationFromEnvironment(process.env);
  // Only the packaged entry has a build manifest. Ordinary CLI startup stays unchanged.
  if (process.send !== undefined) {
    const info = z.object({ buildId: z.string().uuid() }).passthrough().parse(
      JSON.parse(await readFile(new URL("../../../build-info.json", import.meta.url), "utf8")),
    );
    configuration.buildId = info.buildId;
  }
  if (!stopping) runtime = await startPrecedentLoopServer(configuration, process.send === undefined ? {} : {
    onCandidateWritten: () => {
      process.send!({ type: "open-inbox" }, (error: Error | null) => {
        if (error) process.stderr.write(`${JSON.stringify({ event: "open_inbox_error", name: error.name })}\n`);
      });
    },
  });
  if (stopping) {
    await shutdown();
    if (process.connected) process.disconnect();
  } else if (runtime !== undefined) {
    const message = { type: "listening", buildId: configuration.buildId, endpoint: runtime.endpoint };
    if (process.send !== undefined) await new Promise<void>((resolve, reject) => {
      process.send!(message, (error: Error | null) => error ? reject(error) : resolve());
    });
    process.stdout.write(`${JSON.stringify({ event: "listening", endpoint: runtime.endpoint })}\n`);
  }
} catch (error) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "SERVER_START_FAILED";
  const name = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`${JSON.stringify({ event: "startup_error", code, name })}\n`);
  process.exitCode = 1;
  await shutdown();
  if (process.connected) process.disconnect();
}
