import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

// The core startup fields match desktop/config.ts (cross-package parity test).
// Desktop-only settings (Agent choices, CLI paths, AI overrides, ...) are not used
// here and are ignored, so adding a desktop setting never disables the Hook.
// The Hook ships in the server runtime and must not load Electron or the desktop package.
const absolutePath = z.string().min(1).refine(isAbsolute);
export const hookAppConfigSchema = z.object({
  configVersion: z.literal(1),
  setupVersion: z.number().int().nonnegative(),
  setupCompleted: z.boolean(),
  dataDirectory: absolutePath,
  port: z.number().int().min(1).max(65535).default(18888),
  startupTimeoutMs: z.number().int().min(100).max(120000).default(30000),
  shutdownTimeoutMs: z.number().int().min(100).max(120000).default(15000),
});

export function hookUserData(args: string[], env = process.env, home = homedir()): string {
  if (args.length === 0) return join(home, "Library/Application Support/PrecedentLoop");
  const [flag, name, bundleId] = args;
  if (args.length !== 3 || flag !== "--test-identity" || !name?.startsWith("PrecedentLoop-Test-")
    || !bundleId?.startsWith("local.precedentloop.desktop.test.") || name.includes("/")) throw new Error("Invalid test identity");
  return env.PRECEDENT_LOOP_USER_DATA_DIR !== undefined ? absolutePath.parse(env.PRECEDENT_LOOP_USER_DATA_DIR)
    : join(home, "Library/Application Support", name);
}

export async function hookConfiguration(userData: string) {
  const config = hookAppConfigSchema.parse(JSON.parse(await readFile(join(userData, "app-config.json"), "utf8")));
  return {
    ...config,
    databasePath: join(config.dataDirectory, "runtime/precedent-loop.sqlite"),
    workspaceConfigPath: join(config.dataDirectory, "config/workspaces.json"),
    captureCachePath: join(config.dataDirectory, "runtime/capture"),
  };
}
