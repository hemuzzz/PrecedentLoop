import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Backend, backendStatus } from "./backend.js";
import { APP_NAME, cleanEnvironment, dataPaths, executeFile, readAppConfig, readBuildInfo, runtimeConfig, verifyBundledNode } from "./config.js";
import { backendFailureMode, type StartupMode } from "./startup.js";
import { initializeAppIdentity } from "./identity.js";
import { createSetupDispatcher, isAllowedCaller, isSetupSender, setupRequestSchemas, type SetupMethod } from "./setup-ipc.js";
import { SetupService } from "./setup-service.js";
import { navigationTarget } from "./navigation.js";
import { OnlineUpdater } from "./online-update.js";
import { integrationEnvironment } from "./integrations/environment.js";
import { detectAgent } from "./agent-detection.js";

let backend: Backend | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let mayExit = false;
let ready = false;
let startup: StartupMode | undefined;
let quitPromise: Promise<void> | undefined;
const userData = initializeAppIdentity(app);
const runtime = join(process.resourcesPath, "runtime");
const setupFile = join(runtime, "apps/hub/dist/setup.html");
let setup: SetupService;
const updater = new OnlineUpdater(() => window && !window.isDestroyed() ? window : undefined,
  () => ready && startup?.mode === "NORMAL");
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
function settingsOrigin(): string | null {
  return ready && startup?.mode === "NORMAL" && backend?.isReady && backend.child && backend.child.exitCode === null && backend.child.signalCode === null ? backend.origin : null;
}
async function checkForUpdates(): Promise<void> {
  if (startup?.mode === "NORMAL") { await showWindow(); await updater.check(); }
}
function report(error: unknown): void {
  const options = { type: "error" as const, title: APP_NAME, message: errorMessage(error),
    detail: backend ? `日志：${backend.config.desktopLogPath}` : `配置：${join(app.getPath("userData"), "app-config.json")}` };
  if (window && !window.isDestroyed()) {
    window.show();
    void dialog.showMessageBox(window, options);
  } else void dialog.showMessageBox(options);
}
async function loadWindow(current: BrowserWindow, openInbox = false): Promise<void> {
  if (startup?.mode === "NORMAL" && backend) await current.loadURL(openInbox ? `${backend.origin}/#/inbox` : backend.origin);
  else if (startup && startup.mode !== "NORMAL") await current.loadFile(setupFile, {
    query: { mode: startup.mode },
  });
}
async function showWindow(reload = false, openInbox = false): Promise<void> {
  if (quitting || !ready || !startup) return;
  if (window && !window.isDestroyed()) {
    if (reload) await loadWindow(window);
    if (openInbox && window.isMinimized()) window.restore();
    window.show(); window.focus();
    if (openInbox) {
      if (process.platform === "darwin") app.focus({ steal: true });
      window.webContents.send("hub:open-inbox");
    }
    return;
  }
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 800, minHeight: 560, title: APP_NAME,
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    backgroundColor: "#0d0d0d",
    webPreferences: { preload: join(app.getAppPath(), "dist/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const current = window;
  if (process.platform === "darwin") {
    // Presentation hint only; no privileged renderer bridge is needed for window chrome.
    current.webContents.setUserAgent(`${current.webContents.getUserAgent()} PrecedentLoopDesktop/1`);
  }
  const origin = (): string => backend?.origin ?? "http://127.0.0.1:0";
  const openLink = async (url: string): Promise<void> => {
    if (startup?.mode !== "NORMAL") return;
    const target = navigationTarget(url, origin());
    try {
      if (target.kind === "external") {
        const result = await dialog.showMessageBox(current, {
          type: "question", message: "在系统浏览器中打开此链接？", detail: target.url,
          buttons: ["打开", "取消"], defaultId: 1, cancelId: 1,
        });
        if (result.response === 0) await shell.openExternal(target.url);
      } else if (target.kind === "internal") await current.loadURL(target.url);
      else if (target.kind === "local") {
        if (!(await stat(target.path)).isFile()) throw new Error("链接指向的不是普通文件，请检查知识原文中的路径。");
        // Force text-editor handling: never execute a script or app from a knowledge link.
        await executeFile("/usr/bin/open", ["-t", target.path], { env: cleanEnvironment(), timeout: 10000 });
      } else throw new Error("此链接不是知识库页面，也不是可识别的本地文件或网页地址。");
    } catch (error) {
      if (current.isDestroyed()) return;
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const reason = code === "ENOENT" ? "本地文件不存在，可能已移动或删除。请检查知识原文中的路径。"
        : code === "EACCES" || code === "EPERM" ? "没有权限打开此文件，请检查文件访问权限。"
        : errorMessage(error);
      const reference = target.kind === "local"
        ? `${target.path}${target.line ? `\n引用位置：第 ${target.line} 行${target.column ? `，第 ${target.column} 列` : ""}` : ""}` : url;
      current.show();
      await dialog.showMessageBox(current, { type: "error", title: "无法打开链接",
        message: "无法打开链接", detail: `${reason}\n\n${reference}\n\n当前阅读页面已保留。`, buttons: ["知道了"] });
    }
  };
  current.webContents.setWindowOpenHandler(({ url }) => { void openLink(url).catch(report); return { action: "deny" }; });
  current.webContents.on("will-navigate", (event, url) => {
    if (startup?.mode !== "NORMAL") { event.preventDefault(); return; }
    if (navigationTarget(url, origin()).kind !== "internal") { event.preventDefault(); void openLink(url).catch(report); }
  });
  current.webContents.on("will-redirect", (event, url) => {
    if (startup?.mode !== "NORMAL") { event.preventDefault(); return; }
    if (navigationTarget(url, origin()).kind !== "internal") { event.preventDefault(); report(new Error("已阻止页面重定向到知识库页面以外的地址")); }
  });
  current.webContents.on("will-attach-webview", event => event.preventDefault());
  current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  current.on("closed", () => { if (window === current) window = undefined; });
  await loadWindow(current, openInbox);
  if (openInbox && !quitting && !current.isDestroyed()) {
    current.show(); current.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  }
}

async function recover(error: unknown): Promise<void> {
  if (quitting) return;
  const logPath = backend?.config.desktopLogPath ?? (startup?.mode === "NORMAL"
    ? dataPaths(startup.dataDirectory).desktopLogPath : join(app.getPath("userData"), "desktop.log"));
  startup = backendFailureMode(backend?.config.dataDirectory ?? startup?.dataDirectory ?? "无法读取", error,
    logPath);
  if (setup) setup.startup = startup;
  ready = true;
  const item = Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
  if (item) item.enabled = false;
  const settingsItem = Menu.getApplicationMenu()?.getMenuItemById("settings");
  if (settingsItem) settingsItem.enabled = false;
  await showWindow(true);
}

async function stopBackend(): Promise<void> {
  if (!backend) return;
  // An exited child can be discarded; never adopt/kill a process discovered on the configured port.
  const child = backend.child;
  if (!child || (child.exitCode === null && child.signalCode === null)) await backend.stop();
  backend = undefined;
}
setup = new SetupService({
  userData, runtime,
  detect: detectAgent,
  integrations: integrationEnvironment({ userData, appPath: dirname(dirname(process.resourcesPath)), resources: join(runtime, "apps/server/dist/resources/integrations") }),
  startBackend: async config => {
    if (quitting) throw new Error("应用正在退出。");
    await stopBackend();
    backend = new Backend(runtime, runtimeConfig(config), await readBuildInfo(runtime), join(userData, "app-config.json"));
    backend.on("open-inbox", () => {
      if (startup?.mode === "NORMAL" && !quitting) void showWindow(false, true).catch(report);
    });
    backend.on("unavailable", (error: Error) => {
      if (ready && startup?.mode === "NORMAL" && !setup.restarting) void recover(error).catch(report);
    });
    await backend.start();
  },
  stopBackend,
  reloadSettings: async (port, page = "advanced") => { if (window && !window.isDestroyed()) await window.loadURL(`http://127.0.0.1:${port}/#/settings/${page}`); },
  backendStatus: async config => {
    if (!backend?.child || backend.child.exitCode !== null || backend.child.signalCode !== null ||
      backend.config.dataDirectory !== config.dataDirectory || backend.config.port !== config.port) return { serviceReady: false, mcpReady: false };
    return backendStatus(backend.origin, backend.build.buildId);
  },
  verifyRuntime: async () => {
    const build = await readBuildInfo(runtime);
    await verifyBundledNode(runtime, build);
    return `内置 Node ${build.nodeVersion.slice(1)} · ${build.arch}`;
  },
  changeMode: async mode => {
    startup = mode;
    const item = Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
    if (item) item.enabled = mode.mode === "NORMAL";
    const settingsItem = Menu.getApplicationMenu()?.getMenuItemById("settings");
    if (settingsItem) settingsItem.enabled = mode.mode === "NORMAL";
    if (ready) await showWindow(true);
  },
  progress: progress => {
    if (window && !window.isDestroyed() && isSetupSender(window.webContents.mainFrame.url, setupFile)) window.webContents.send("setup:progress", progress);
  },
  integrationProgress: progress => {
    if (window && !window.isDestroyed() && isAllowedCaller("applyIntegrations",
      { url: window.webContents.mainFrame.url, mainWindow: true, mainFrame: true }, setupFile, settingsOrigin())) window.webContents.send("setup:integration-progress", progress);
  },
});
const selectPath = async (file: boolean): Promise<string | null> => {
  if (!window || window.isDestroyed()) throw new Error("设置窗口已关闭。");
  const result = await dialog.showOpenDialog(window, { title: file ? "选择命令行可执行文件" : "选择数据目录",
    properties: file ? ["openFile", "showHiddenFiles"] : ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
};
const dispatchSetup = createSetupDispatcher(setupFile, setup, {
  selectDirectory: () => selectPath(false), selectExecutable: () => selectPath(true),
  openLogs: async () => {
    const result = await readAppConfig(userData);
    const directory = result.kind === "VALID" ? dirname(dataPaths(result.config.dataDirectory).desktopLogPath) : userData;
    let target = directory;
    try { if (!(await stat(target)).isDirectory()) target = userData; } catch { target = userData; }
    await mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error("无法打开日志目录。");
  },
  quit: () => app.quit(),
  getAppInfo: () => ({ version: app.getVersion() }),
  checkForUpdates,
  revealPath: async path => { shell.showItemInFolder(path); },
  selectDiagnosticDestination: async () => {
    if (!window || window.isDestroyed()) throw new Error("设置窗口已关闭。");
    const result = await dialog.showSaveDialog(window, { title: "导出诊断包", defaultPath: `PrecedentLoop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }], properties: ["showOverwriteConfirmation", "createDirectory"] });
    return result.canceled ? null : result.filePath ?? null;
  },
}, settingsOrigin);
for (const method of Object.keys(setupRequestSchemas) as SetupMethod[]) {
  ipcMain.handle(`setup:${method}`, (event, input: unknown) => {
    return dispatchSetup(method, { url: event.senderFrame?.url ?? "", mainWindow: !!window && !window.isDestroyed() && event.sender === window.webContents,
      mainFrame: !!window && !window.isDestroyed() && event.senderFrame === window.webContents.mainFrame }, input);
  });
}

// Tests use a separately packaged bundle/name, giving a separate userData/single-instance identity.
app.on("window-all-closed", () => { /* Closing the window deliberately keeps MCP available. */ });
app.on("activate", () => { void showWindow().catch(report); });
app.on("second-instance", () => { void showWindow().catch(report); });
app.on("before-quit", event => {
  if (mayExit) return;
  event.preventDefault();
  quitting = true;
  quitPromise ??= (async () => {
    try {
      await backend?.stop();
      await updater.dispose();
      backend?.log("app-stopped");
      mayExit = true;
      app.quit();
    } catch (error) {
      report(error);
      // Stay open when shutdown is incomplete; the updater must not replace this App.
      quitPromise = undefined;
      if (backend?.child && (backend.child.exitCode !== null || backend.child.signalCode !== null)) {
        mayExit = true;
        app.quit();
      }
    }
  })();
});

if (!app.requestSingleInstanceLock()) {
  mayExit = true;
  app.quit();
} else {
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: "about", label: `关于 ${APP_NAME}` },
        { id: "settings", label: "设置…", accelerator: "Command+,", enabled: false,
          click: () => { if (settingsOrigin()) void showWindow().then(async () => { if (window && settingsOrigin()) await window.loadURL(`${settingsOrigin()}/#/settings/general`); }).catch(report); } },
        { id: "check-for-updates", label: "检查更新…", enabled: false,
          click: () => { void checkForUpdates().catch(report); } },
        { type: "separator" }, { label: "打开知识库", click: () => void showWindow().catch(report) },
        { type: "separator" }, { label: "退出", accelerator: "Command+Q", click: () => app.quit() }] },
      { role: "editMenu" }, { role: "windowMenu" },
    ]));
    await setup.initialize();
    if (quitting) return;
    ready = true;
    await showWindow();
  }).catch(error => { void recover(error).catch(report); });
}
