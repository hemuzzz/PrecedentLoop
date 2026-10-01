import { app, dialog, Menu, shell, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import { APP_NAME, INSTALL_PATH, nodeEnvironment, executeFile, requireAppConfig } from "./config.js";
import { stageUpdateHelper } from "./update-helper.js";
import { assertClosedDependencies } from "./package-files.js";
import { checkForUpdate, downloadUpdate, RELEASE_REPOSITORY, type UpdateManifest } from "./updates.js";

async function copyUpdateImage(image: string, output: string): Promise<string> {
  // Keep mounts outside the disposable download directory: a failed detach must never be recursively removed.
  const mount = await mkdtemp(join(tmpdir(), "codex-update-volume-"));
  try {
    await executeFile("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, image], { timeout: 120000 });
    const source = join(mount, `${APP_NAME}.app`);
    await assertClosedDependencies(source);
    await mkdir(output);
    const destination = join(output, `${APP_NAME}.app`);
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await assertClosedDependencies(destination);
    return destination;
  } finally {
    try {
      await executeFile("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
      await rm(mount, { recursive: true });
    } catch {
      throw new Error(`无法卸载更新映像，未安装更新。临时挂载位置：${mount}`);
    }
  }
}

export class OnlineUpdater {
  #busy = false;
  #installing = false;
  #pending: { root: string; path: string; manifest: UpdateManifest } | undefined;
  constructor(readonly getWindow: () => BrowserWindow | undefined, readonly canUpdate: () => boolean) {}

  #label(value: string): void {
    const item = Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
    if (item) { item.label = value; item.enabled = this.canUpdate() && !this.#busy && !this.#installing; }
  }

  async #message(message: string, detail: string, buttons = ["知道了"]): Promise<number> {
    const current = this.getWindow();
    const options = { type: "info" as const, title: APP_NAME, message, detail, buttons, cancelId: buttons.length - 1 };
    const result = current && !current.isDestroyed() ? await dialog.showMessageBox(current, options) : await dialog.showMessageBox(options);
    return result.response;
  }

  async check(): Promise<void> {
    if (!this.canUpdate() || this.#busy || this.#installing) return;
    this.#busy = true;
    this.#label("正在检查更新…");
    let downloadRoot: string | undefined;
    try {
      if (!app.isPackaged || await realpath(dirname(dirname(dirname(process.execPath)))) !== INSTALL_PATH) {
        throw new Error("请先将应用安装到 /Applications/PrecedentLoop.app，再检查更新。");
      }
      if (!this.#pending) {
        const result = await checkForUpdate(app.getVersion(), process.arch);
        if (result.kind !== "available") {
          await this.#message(result.kind === "unpublished" ? "尚未发布在线版本" : "已是最新版本",
            `当前版本：${app.getVersion()}\n更新来源：GitHub ${RELEASE_REPOSITORY}`);
          return;
        }
        const { manifest } = result;
        if (manifest.requiresManualUpgrade) {
          if (await this.#message("此版本需要手动升级", `版本 ${manifest.version} 包含需人工处理的配套变更，请先查看版本说明。`, ["查看版本说明", "取消"]) === 0) {
            await shell.openExternal(`https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${manifest.version}`);
          }
          return;
        }
        if (await this.#message(`发现新版本 ${manifest.version}`, `当前版本：${app.getVersion()}\n下载大小：${Math.ceil(manifest.size / 1024 / 1024)} MB\n更新保留本机配置和知识库数据。`, ["下载更新", "取消"]) !== 0) return;
        downloadRoot = await mkdtemp(join(tmpdir(), "codex-online-update-"));
        const image = join(downloadRoot, "update.dmg");
        let lastPercent = -1;
        await downloadUpdate(result.url, manifest, image, fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.#label(`正在下载更新… ${percent}%`);
            this.getWindow()?.setProgressBar(fraction);
          }
        });
        this.#label("正在准备更新…");
        const path = await copyUpdateImage(image, join(downloadRoot, "payload"));
        await rm(image);
        this.#pending = { root: downloadRoot, path, manifest };
        downloadRoot = undefined;
      }
      const pending = this.#pending;
      if (await this.#message(`版本 ${pending.manifest.version} 已下载`, "安装时应用会正常退出并重新打开。请先结束正在使用知识库的任务。", ["安装并重启", "稍后"]) !== 0) return;
      if (!this.canUpdate()) return;
      const config = await requireAppConfig(app.getPath("userData"));
      const helper = await stageUpdateHelper(process.resourcesPath, pending.root);
      await mkdir(dirname(config.desktopLogPath), { recursive: true });
      const log = await open(join(dirname(config.desktopLogPath), "update.log"), "a", 0o600);
      try {
        const env = nodeEnvironment();
        delete env.PRECEDENT_LOOP_UPDATE_LOCK_TOKEN;
        const child = spawn(helper.node, [helper.entry, "--install-downloaded",
          pending.path, pending.manifest.version, pending.manifest.buildId], {
          cwd: pending.root, env, detached: true, stdio: ["ignore", log.fd, log.fd],
        });
        await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
        this.#installing = true;
        this.#pending = undefined;
        child.once("exit", () => { this.#installing = false; this.#label("检查更新…"); });
        child.unref();
      } finally { await log.close(); }
    } catch (error) {
      if (downloadRoot) await rm(downloadRoot, { recursive: true, force: true });
      if (this.#pending) { await rm(this.#pending.root, { recursive: true, force: true }); this.#pending = undefined; }
      const message = error instanceof ZodError ? "版本信息格式不正确，未安装更新。"
        : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "连接更新服务器超时，请稍后重试。"
        : error instanceof Error ? error.message : String(error);
      await this.#message("更新未完成", `${message}\n\n当前应用和知识库数据未被此下载步骤替换。`);
    } finally {
      this.#busy = false;
      this.getWindow()?.setProgressBar(-1);
      this.#label(this.#installing ? "正在安装更新…" : this.#pending ? `安装版本 ${this.#pending.manifest.version}…` : "检查更新…");
    }
  }

  async dispose(): Promise<void> {
    if (this.#pending) { await rm(this.#pending.root, { recursive: true, force: true }); this.#pending = undefined; }
  }
}
