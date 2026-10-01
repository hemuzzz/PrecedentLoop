import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { APP_NAME, BUNDLE_ID, cleanEnvironment, resolveUserData } from "./config.js";

interface IdentityApp {
  isPackaged: boolean;
  setName(name: string): void;
  getPath(name: "appData"): string;
  setPath(name: "userData", value: string): void;
}
/** Must finish before app.whenReady is registered; no promise or top-level await. */
export function initializeAppIdentity(app: IdentityApp, executable = process.execPath,
  readBundleId = (plist: string) => execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist],
    { encoding: "utf8", env: cleanEnvironment(), timeout: 5000 }).trim(), env = process.env): string {
  const installedPath = dirname(dirname(dirname(executable)));
  const identity = app.isPackaged ? { name: basename(installedPath, ".app"), bundleId: readBundleId(join(installedPath, "Contents/Info.plist")) }
    : { name: APP_NAME, bundleId: BUNDLE_ID };
  app.setName(identity.name);
  const userData = resolveUserData(identity, app.getPath("appData"), env);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  return userData;
}
