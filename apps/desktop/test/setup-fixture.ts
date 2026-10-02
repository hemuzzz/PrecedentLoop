import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPaths, inspectNode } from "../src/config.js";
import { fixtureExecutor } from "./executor-fixture.js";

export function sqliteHeader(version: number): Buffer {
  const header = Buffer.alloc(100); header.write("SQLite format 3\0"); header.writeUInt32BE(version, 60); return header;
}
export async function fixtureProduct(path: string, version = 2, marker = true): Promise<void> {
  for (const directory of ["runtime", "config"]) await mkdir(join(path, directory), { recursive: true });
  await writeFile(dataPaths(path).databasePath, sqliteHeader(version));
  if (marker) await writeFile(join(path, ".precedentloop.json"), JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), dataId: randomUUID() }));
}
export async function fixtureRuntime(root: string): Promise<string> {
  const runtime = join(root, "PrecedentLoop-Test-fixture.app/Contents/Resources/runtime");
  const helper = await fixtureExecutor(runtime);
  await writeFile(join(runtime, "build-info.json"), JSON.stringify({ buildId: randomUUID(), ...await inspectNode(helper) }));
  await mkdir(join(runtime, "apps/server/dist"), { recursive: true });
  await writeFile(join(runtime, "apps/server/dist/maintenance-cli.js"), `
    const fs = require('node:fs');
    const command = process.argv[2];
    fs.appendFileSync('commands.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
    if (fs.existsSync('fail-migration')) { console.error('fixture migration failure'); process.exit(3); }
    const header = Buffer.alloc(100); header.write('SQLite format 3\\0');
    header.writeUInt32BE(2, 60);
    fs.writeFileSync(process.env.PRECEDENT_LOOP_DATABASE_PATH, header);
  `);
  return runtime;
}
