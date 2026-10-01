import { packager } from "@electron/packager";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, BUNDLE_ID, bundledNodePath, cleanEnvironment, nodeEnvironment, executeFile, inspectNode, verifyBundledNode, buildConfigSchema, type BuildConfig, type AppIdentity } from "./config.js";
import { assertClosedDependencies } from "./package-files.js";
export { assertClosedDependencies } from "./package-files.js";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const ELECTRON_VERSION = "44.4.3";
export const RETAINED_LOCALES = new Set(["en.lproj", "zh_CN.lproj"]);
export async function pnpm(args: string[], cwd = projectRoot): Promise<void> {
  const { stdout } = await executeFile("npx", ["-y", "-p", "node@24.21.0", "-p", "pnpm@11.1.3", "pnpm", ...args], {
    cwd, env: cleanEnvironment(), maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(stdout);
}
export async function verifyNativeRuntime(runtime: string, nodePath: string): Promise<void> {
  await assertClosedDependencies(runtime);
  const fixture = await mkdtemp(join(tmpdir(), "codex-desktop-native-"));
  try {
    await executeFile(nodePath, ["--input-type=module", "-e", `
      import {createRequire} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const require=createRequire(pathToFileURL(process.argv[1]));
      const Database=require('better-sqlite3');
      const db=new Database(process.argv[2]);
      try { db.exec('CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)');
        if(db.prepare('SELECT value FROM probe').get().value!==42) throw Error('SQLite probe failed');
      } finally { db.close(); }
      await import(pathToFileURL(process.argv[1]));
    `, join(runtime, "apps/server/dist/runtime.js"), join(fixture, "probe.sqlite")], {
      cwd: fixture, env: nodeEnvironment(), timeout: 15000,
    });
    await lstat(join(runtime, "apps/hub/dist/index.html"));
    await lstat(join(runtime, "apps/hub/dist/setup.html"));
    for (const resource of ["ai-providers.json", "knowledge-import/SKILL.md", "knowledge-content-model.md"]) {
      await lstat(join(runtime, "apps/server/dist/resources", resource));
    }
    await lstat(join(runtime, "apps/server/dist/hook/precedent-hook.js"));
    await lstat(join(runtime, "apps/server/dist/resources/integrations/precedent-hook.sh.template"));
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

export async function pruneLocales(app: string): Promise<void> {
  for (const directory of ["Contents/Frameworks/Electron Framework.framework/Versions/A/Resources", "Contents/Resources"]) {
    for (const name of await readdir(join(app, directory))) {
      if (name.endsWith(".lproj") && !RETAINED_LOCALES.has(name)) await rm(join(app, directory, name), { recursive: true });
    }
  }
}
export async function pruneRuntimeDependencies(modules: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const license = /^(?:licen[cs]e|notice)(?:[.-]|$)/iu.test(entry.name);
      if (entry.isFile() && !license && /(?:\.map|\.d\.(?:ts|cts|mts)|\.md)$/iu.test(entry.name)) await rm(path);
      else if (entry.isDirectory()) {
        if (entry.name === "src" && directory.endsWith("/node_modules/zod")) await rm(path, { recursive: true });
        else if (entry.name === "better-sqlite3" && directory.endsWith("/node_modules")) {
          for (const name of await readdir(path)) {
            if (!["lib", "package.json", "prebuilds"].includes(name) && !/^(?:licen[cs]e|notice)(?:[.-]|$)/iu.test(name)) await rm(join(path, name), { recursive: true });
          }
          for (const name of await readdir(join(path, "prebuilds"))) {
            if (name !== `${process.platform}-${process.arch}.node`) await rm(join(path, "prebuilds", name), { recursive: true });
          }
          await walk(path);
        } else await walk(path);
      }
    }
  };
  await walk(modules);
}
export async function packageApp(_config: BuildConfig, output: string, identity: AppIdentity = { name: APP_NAME, bundleId: BUNDLE_ID }): Promise<string> {
  if (process.platform !== "darwin") throw new Error("首版只支持本机 macOS 打包");
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error("不支持当前打包架构");
  const { version } = JSON.parse(await readFile(join(projectRoot, "apps/desktop/package.json"), "utf8")) as { version: string };
  const { engines } = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { engines: { node: string } };
  const stage = await mkdtemp(join(tmpdir(), "codex-desktop-package-"));
  try {
    const desktop = join(stage, "desktop");
    const runtime = join(stage, "runtime");
    // Deploy in a disposable workspace: pnpm legacy deploy also writes workspace install state.
    const workspace = join(stage, "workspace");
    await mkdir(workspace);
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) {
      await cp(join(projectRoot, file), join(workspace, file));
    }
    for (const pkg of ["apps/server", "apps/hub", "apps/desktop", "packages/id-generator"]) {
      await mkdir(join(workspace, pkg), { recursive: true });
      await cp(join(projectRoot, pkg, "package.json"), join(workspace, pkg, "package.json"));
      await cp(join(projectRoot, pkg, "dist"), join(workspace, pkg, "dist"), { recursive: true });
    }
    await mkdir(join(runtime, "apps"), { recursive: true });
    // N-API prebuilds ship in the package; deployment needs no install scripts or native rebuild.
    await pnpm(["--filter", "@precedent-loop/server", "deploy", "--prod", "--legacy", "--ignore-scripts", "--config.hoist-workspace-packages=false", join(runtime, "apps/server")], workspace);
    await pruneRuntimeDependencies(join(runtime, "apps/server/node_modules"));
    await pnpm(["--filter", "@precedent-loop/desktop", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", "--config.hoist-workspace-packages=false", desktop], workspace);
    await pruneRuntimeDependencies(join(desktop, "node_modules"));
    await cp(join(projectRoot, "apps/desktop/static"), join(desktop, "static"), { recursive: true });
    await cp(join(projectRoot, "apps/hub/dist"), join(runtime, "apps/hub/dist"), { recursive: true });
    await assertClosedDependencies(desktop);
    const { name, bundleId } = identity;
    const [built] = await packager({
      dir: desktop, name, appBundleId: bundleId,
      appVersion: version, platform: "darwin", arch: process.arch, electronVersion: ELECTRON_VERSION,
      out: join(stage, "packaged"), asar: false, prune: false,
    });
    if (!built) throw new Error("打包未生成 App");
    const app = join(built, `${name}.app`);
    await pruneLocales(app);
    const packagedRuntime = join(app, "Contents/Resources/runtime");
    const node = await inspectNode(bundledNodePath(packagedRuntime));
    if (node.nodeVersion !== `v${engines.node}` || node.electronVersion !== ELECTRON_VERSION || node.arch !== process.arch) {
      throw new Error("Electron 内置 Node 版本或架构与构建要求不一致");
    }
    const build = { buildId: randomUUID(), version, ...node };
    await writeFile(join(runtime, "build-info.json"), JSON.stringify(build, null, 2) + "\n");
    // Preserve relative pnpm links; generic extraResource copying resolves them to staging paths.
    await cp(runtime, join(app, "Contents/Resources/runtime"), { recursive: true, verbatimSymlinks: true });
    await verifyNativeRuntime(packagedRuntime, await verifyBundledNode(packagedRuntime, build));
    await assertClosedDependencies(app);
    await mkdir(output, { recursive: true });
    const destination = join(output, `${name}.app`);
    // A unique output directory is required; never silently overwrite a prior artifact.
    await cp(app, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await assertClosedDependencies(destination);
    return destination;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configFile = resolve(process.argv[2] ?? join(projectRoot, ".desktop-local.json"));
    const config = buildConfigSchema.parse(JSON.parse(await readFile(configFile, "utf8")));
    const output = resolve(process.argv[3] ?? join(projectRoot, "dist/desktop", randomUUID()));
    process.stdout.write(JSON.stringify({ appPath: await packageApp(config, output) }) + "\n");
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
