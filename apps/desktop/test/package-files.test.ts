import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cleanEnvironment, nodeEnvironment } from "../src/config.js";
import { assertClosedDependencies, pruneLocales, pruneRuntimeDependencies } from "../src/package-app.js";

test("dependency pruning retains executable assets, licenses and closed pnpm links", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules"), sqlite = ".pnpm/better-sqlite3/node_modules/better-sqlite3";
  const prebuild = `${process.platform}-${process.arch}.node`;
  const retained = [`${sqlite}/lib/index.js`, `${sqlite}/lib/binding.js`, `${sqlite}/lib/database.js`, `${sqlite}/package.json`, `${sqlite}/LICENSE`, `${sqlite}/prebuilds/${prebuild}`,
    "zod/index.js", "zod/index.cjs", "zod/package.json", "zod/LICENSE", "other/NOTICE.md", "other/LICENCE", "other/data.json", "other/index.mjs"];
  const removed = [`${sqlite}/deps/sqlite3.c`, `${sqlite}/src/better_sqlite3.cpp`, `${sqlite}/binding.gyp`, `${sqlite}/build/Release/better_sqlite3.node`, `${sqlite}/build/Release/sqlite3.a`,
    ...["darwin-arm64.node", "darwin-x64.node", "linux-arm64.node", "linux-x64.node", "linuxmusl-arm64.node", "linuxmusl-x64.node", "win32-arm64.node", "win32-x64.node"].filter(name => name !== prebuild).map(name => `${sqlite}/prebuilds/${name}`),
    `${sqlite}/build/Release/obj.target/file.o`, "zod/src/index.ts", "zod/index.d.ts", "zod/index.d.cts", "zod/index.d.mts", "zod/index.js.map", "zod/README.md"];
  for (const name of [...retained, ...removed]) {
    await mkdir(dirname(join(modules, name)), { recursive: true });
    await writeFile(join(modules, name), name);
  }
  await symlink(sqlite, join(modules, "better-sqlite3"));
  await pruneRuntimeDependencies(modules);
  await assertClosedDependencies(root);
  assert.deepEqual(await readdir(join(modules, sqlite, "prebuilds")), [prebuild]);
  for (const name of ["deps", "src", "build"]) await assert.rejects(readdir(join(modules, sqlite, name)), { code: "ENOENT" });
  for (const name of retained) assert.equal(await readFile(join(modules, name), "utf8"), name);
  for (const name of removed) await assert.rejects(readFile(join(modules, name)), { code: "ENOENT" });
});

test("both App resource locations retain only en and zh_CN localizations", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-locales-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locations = ["Contents/Resources", "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"];
  for (const location of locations) {
    for (const name of ["en.lproj", "zh_CN.lproj", "fr.lproj", "zh_TW.lproj"]) await mkdir(join(root, location, name), { recursive: true });
    await writeFile(join(root, location, "LICENSE"), "retained");
  }
  await pruneLocales(root);
  for (const location of locations) assert.deepEqual((await readdir(join(root, location))).sort(), ["LICENSE", "en.lproj", "zh_CN.lproj"]);
});

test("Helper environment removes Node injection and explicitly restores Node mode", t => {
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "ELECTRON_RUN_AS_NODE"]) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    process.env[key] = "injected";
  }
  const clean = cleanEnvironment(), executor = nodeEnvironment();
  assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(executor.ELECTRON_RUN_AS_NODE, "1");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) assert.equal(executor[key], undefined);
});
