import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { APP_NAME, BUNDLE_ID, INSTALL_PATH, buildInfoSchema, buildConfigSchema, bundledNodePath, executeFile, isTestIdentity, readBuildInfo, requireAppConfig, resolveUserData, verifyBundledNode, type AppIdentity } from "./config.js";
import { readyResponse } from "./backend.js";
import { assertClosedDependencies } from "./package-files.js";
import { backendProcesses, processIdentity, requestNormalQuit, runningApplications } from "./macos.js";

export interface DownloadedApp { path: string; version: string; buildId: string }

export async function stageDownloadedApp(source: DownloadedApp, staged: string, identity: AppIdentity): Promise<void> {
  await assertClosedDependencies(source.path);
  const resources = join(source.path, "Contents/Resources");
  const build = buildInfoSchema.parse(JSON.parse(await readFile(join(resources, "runtime/build-info.json"), "utf8")));
  if (build.version !== source.version || build.buildId !== source.buildId || build.arch !== process.arch) {
    throw new Error("更新包的版本、构建标识或架构与发布信息不符");
  }
  await verifyBundledNode(join(resources, "runtime"), build);
  for (const [key, expected] of [["CFBundleIdentifier", identity.bundleId], ["CFBundleShortVersionString", source.version]]) {
    const { stdout } = await executeFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(source.path, "Contents/Info.plist")]);
    if (stdout.trim() !== expected) throw new Error("更新包应用身份或版本不符");
  }
  await cp(source.path, staged, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  // User configuration stays in userData; no configuration is injected into the new App.
  const configPath = join(staged, "Contents/Resources/local-runtime.json");
  try { await lstat(configPath); throw new Error("在线更新包不应包含本机配置"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await assertClosedDependencies(staged);
}

const exitRecord = z.object({ event: z.literal("backend-exited"), mainPid: z.number(), childPid: z.number(),
  buildId: z.string(), startedAt: z.string(), code: z.literal(0), signal: z.null(), normal: z.literal(true) });
const startRecord = z.object({ event: z.literal("backend-starting"), mainPid: z.number(), childPid: z.number(),
  buildId: z.string(), startedAt: z.string() });
async function logRecords(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").flatMap(line => { try { return [JSON.parse(line) as unknown]; } catch { return []; } });
}
export async function ensurePortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolvePort()));
  });
}
export async function replaceApp(staged: string, target: string, backup: string): Promise<void> {
  try { await lstat(target); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await rename(staged, target); return;
  }
  await rename(target, backup);
  try { await rename(staged, target); }
  catch (error) {
    await rename(backup, target);
    throw error;
  }
}

// The CLI has one fixed installation. Integration tests can only select a temporary test bundle.
export async function updateApp(configFile: string | undefined, testInstallation?: AppIdentity & { path: string }, downloaded?: DownloadedApp): Promise<void> {
  if (process.platform !== "darwin") throw new Error("仅支持 macOS 本地更新");
  const requestedPath = testInstallation?.path ?? INSTALL_PATH;
  const targetPath = join(await realpath(dirname(requestedPath)), basename(requestedPath));
  const identity = testInstallation ?? { name: APP_NAME, bundleId: BUNDLE_ID };
  if (testInstallation) {
    const parent = await realpath(dirname(targetPath));
    if (!parent.startsWith((await realpath(tmpdir())) + sep) ||
      !isTestIdentity(identity) ||
      basename(targetPath) !== `${identity.name}.app`) throw new Error("测试安装必须限于临时目录和独立身份");
  }
  const parent = dirname(targetPath);
  const lock = join(parent, `.${identity.name}.update.lock`);
  const inheritedLock = process.env.PRECEDENT_LOOP_UPDATE_LOCK_TOKEN;
  if (inheritedLock) {
    if ((await readFile(join(lock, "shell-owner"), "utf8")).trim() !== inheritedLock) throw new Error("更新锁归属不符");
  } else await mkdir(lock); // EEXIST stops concurrent updates or stale unknown locks.
  const stage = join(parent, `.${APP_NAME}.staging-${randomUUID()}`);
  const backup = join(parent, `.${APP_NAME}.previous-${randomUUID()}.app`);
  try {
    const config = await requireAppConfig(resolveUserData(identity));
    if (!config.setupCompleted) throw new Error("请先完成初始化，再更新应用");
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, stage, backup }));
    try {
      const { stdout } = await executeFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(targetPath, "Contents/Info.plist")]);
      if (stdout.trim() !== identity.bundleId) throw new Error("安装目标属于其他应用，停止更新");
    } catch (error) {
      try { await lstat(targetPath); } catch (statError) {
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") error = undefined;
      }
      if (error) throw error;
    }
    const staged = join(stage, `${identity.name}.app`);
    if (downloaded) {
      await mkdir(stage);
      await stageDownloadedApp(downloaded, staged, identity);
    } else {
      // Build-only dependencies are deliberately absent from installed production Apps.
      const { packageApp } = await import("./package-app.js");
      const { verifyPackagedService } = await import("./verify-service.js");
      if (!configFile) throw new Error("本地重建需要构建配置");
      const buildConfig = buildConfigSchema.parse(JSON.parse(await readFile(configFile, "utf8")));
      await packageApp(buildConfig, stage, identity);
      await verifyPackagedService(join(staged, "Contents/Resources"));
    }
    const apps = (await runningApplications()).filter(item => item.bundleId === identity.bundleId);
    if (apps.length > 1 || apps.some(item => item.path !== targetPath)) throw new Error("存在安装归属不明的 App，停止更新");
    const old = apps[0];
    const entry = join(targetPath, "Contents/Resources/runtime/apps/server/dist/main.js");
    const owners = await backendProcesses(entry);
    if (owners.some(item => item.ppid !== old?.pid) || owners.length > 1) throw new Error("存在额外或孤立后端，停止更新，不接管进程");
    if (old) {
      const oldBuild = await readBuildInfo(join(targetPath, "Contents/Resources/runtime"));
      const records = (await logRecords(config.desktopLogPath)).flatMap(value => {
        const parsed = startRecord.safeParse(value); return parsed.success ? [parsed.data] : [];
      });
      const owned = records.reverse().find(item => item.mainPid === old.pid && item.buildId === oldBuild.buildId);
      if (!owned) throw new Error("无法识别旧 App 的后端归属，停止更新");
      const mainIdentity = await processIdentity(old.pid);
      const childIdentity = await processIdentity(owned.childPid);
      const { stdout: parentPid } = await executeFile("/bin/ps", ["-p", String(owned.childPid), "-o", "ppid="]);
      if (!mainIdentity || !childIdentity?.includes(join(targetPath, "Contents/Resources/runtime/apps/server/dist/main.js")) || Number(parentPid.trim()) !== old.pid) {
        throw new Error("旧后端进程与安装路径/父进程不符");
      }
      await requestNormalQuit(identity.bundleId);
      const deadline = Date.now() + config.shutdownTimeoutMs;
      while (await processIdentity(old.pid) === mainIdentity || await processIdentity(owned.childPid) === childIdentity) {
        if (Date.now() >= deadline) throw new Error("旧 App 或后端未结束，不替换、不强杀");
        await delay(100);
      }
      const stopped = (await logRecords(config.desktopLogPath)).some(value => {
        const parsed = exitRecord.safeParse(value);
        return parsed.success && parsed.data.mainPid === old.pid && parsed.data.childPid === owned.childPid &&
          parsed.data.buildId === owned.buildId && parsed.data.startedAt === owned.startedAt;
      });
      if (!stopped) throw new Error("未取得本次正常退出结果，停止更新");
    }
    if ((await runningApplications()).some(item => item.bundleId === identity.bundleId)) throw new Error("旧 App 被重新打开，停止替换");
    if ((await backendProcesses(entry)).length) throw new Error("包内后端仍存在，停止替换");
    await ensurePortFree(config.port);
    await replaceApp(staged, targetPath, backup);
    const target = await readBuildInfo(join(targetPath, "Contents/Resources/runtime"));
    const openArgs = isTestIdentity(identity) && process.env.PRECEDENT_LOOP_USER_DATA_DIR !== undefined
      ? ["--env", `PRECEDENT_LOOP_USER_DATA_DIR=${resolveUserData(identity)}`, targetPath] : [targetPath];
    try { await executeFile("/usr/bin/open", openArgs); }
    catch (error) {
      throw new Error(`新应用启动失败，旧程序保留在 ${backup}；${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const deadline = Date.now() + config.startupTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await runningApplications()).find(item => item.bundleId === identity.bundleId && item.path === targetPath);
      if (current && await readyResponse(`http://127.0.0.1:${config.port}`, target.buildId).catch(() => false)) {
        const records = await logRecords(config.desktopLogPath);
        const receipt = records.reverse().find(value => typeof value === "object" && value !== null &&
          "event" in value && value.event === "backend-ready" && "mainPid" in value && value.mainPid === current.pid &&
          "buildId" in value && value.buildId === target.buildId);
        if (receipt) {
          let backupRemoved = false;
          try {
            await rm(backup, { recursive: true, force: true });
            backupRemoved = true;
          } catch { /* Cleanup failure must not turn an accepted update into a failure. */ }
          process.stdout.write(JSON.stringify({ updated: true, appPath: targetPath, buildId: target.buildId,
            backupRemoved, ...(backupRemoved ? {} : { backupPath: backup }),
            installedIntegrations: "需按已变更项人工复核" }) + "\n");
          return;
        }
      }
      await delay(200);
    }
    throw new Error(`新服务未通过目标构建验收，旧程序保留在 ${backup}；不会自动启动旧版本或回退数据库`);
  } finally {
    // Only paths created under this invocation's lock are cleaned here.
    // The backup is removed only after READY acceptance; update or backup cleanup failures retain it.
    await rm(stage, { recursive: true, force: true });
    await rm(join(lock, "owner.json"), { force: true });
    if (!inheritedLock) await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const online = process.argv[2] === "--install-downloaded";
  let cleanupRoot: string | undefined;
  const run = async (): Promise<void> => {
    if (online) {
      const [path, version, buildId] = z.tuple([z.string(), z.string(), z.string().uuid()]).parse(process.argv.slice(3));
      const clonedApp = await realpath(fileURLToPath(new URL("../../../../", import.meta.url)));
      const root = await realpath(join(clonedApp, "../.."));
      if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith("codex-online-update-") ||
        dirname(clonedApp) !== join(root, "helper") ||
        await realpath(path) !== join(root, "payload", `${APP_NAME}.app`) ||
        await realpath(process.execPath) !== await realpath(bundledNodePath(join(clonedApp, "Contents/Resources/runtime")))) {
        throw new Error("在线安装器必须从本次独立临时更新目录启动");
      }
      cleanupRoot = root;
      await updateApp(undefined, undefined, { path: resolve(path), version, buildId });
    } else await updateApp(resolve(process.argv[2] ?? fileURLToPath(new URL("../../../.desktop-local.json", import.meta.url))));
  };
  run().catch(async error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
    if (online) await executeFile("/usr/bin/osascript", ["-e", `on run argv
      display dialog (item 1 of argv) with title "Precedent Loop 更新失败" buttons {"知道了"} default button 1 with icon stop
    end run`, `${error instanceof Error ? error.message : String(error)}\n\n请重新打开应用，或查看本机更新日志。`]).catch(() => {});
  }).finally(async () => {
    if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
  });
}
