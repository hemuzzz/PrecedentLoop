import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, executeFile, buildConfigSchema, readBuildInfo } from "./config.js";
import { packageApp, projectRoot } from "./package-app.js";
import { assertClosedDependencies } from "./package-files.js";
import { updateManifestSchema } from "./updates.js";

export async function createRelease(appPath: string, output: string, requiresManualUpgrade = false): Promise<void> {
  const build = await readBuildInfo(join(appPath, "Contents/Resources/runtime"));
  if (!build.version) throw new Error("App 缺少发布版本号，请先重新构建");
  const stage = await mkdtemp(join(tmpdir(), "codex-release-"));
  try {
    await mkdir(output, { recursive: true });
    const imageSource = join(stage, "image");
    const copy = join(imageSource, `${APP_NAME}.app`);
    await mkdir(imageSource);
    await cp(appPath, copy, { recursive: true, verbatimSymlinks: true });
    await symlink("/Applications", join(imageSource, "Applications"));
    const prefix = `PrecedentLoop-${build.version}-${build.arch}`;
    for (const modules of ["app/node_modules", "runtime/apps/server/node_modules"]) {
      // pnpm metadata is not used by Node at runtime and can contain the builder's store path.
      for (const filename of [".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
        await rm(join(copy, "Contents/Resources", modules, filename), { force: true });
      }
    }
    await assertClosedDependencies(copy);
    // Both images contain only the program; userData is independent of the App.
    const bootstrap = join(output, `${prefix}-local-install.dmg`);
    await executeFile("/usr/bin/hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", imageSource, "-fs", "HFS+", "-format", "ULMO", bootstrap]);
    const filename = `${prefix}-update.dmg`;
    const image = join(output, filename);
    await executeFile("/usr/bin/hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", imageSource, "-fs", "HFS+", "-format", "ULMO", image]);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(image)) hash.update(chunk);
    const manifest = updateManifestSchema.parse({ updateProtocol: 1, version: build.version, arch: build.arch,
      buildId: build.buildId, filename, sha256: hash.digest("hex"), size: (await stat(image)).size, requiresManualUpgrade });
    const manifestPath = join(output, `${prefix}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(JSON.stringify({ bootstrap, publishFiles: [image, manifestPath], version: build.version }) + "\n");
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async (): Promise<void> => {
    const config = buildConfigSchema.parse(JSON.parse(await readFile(resolve(process.argv[2] ?? join(projectRoot, ".desktop-local.json")), "utf8")));
    await mkdir(join(projectRoot, "dist/desktop"), { recursive: true });
    const output = await mkdtemp(join(projectRoot, "dist/desktop/release-"));
    const appPath = await packageApp(config, output);
    await createRelease(appPath, output, process.argv.includes("--manual-only"));
  };
  run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
