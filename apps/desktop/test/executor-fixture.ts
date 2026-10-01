import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bundledNodePath } from "../src/config.js";

/** A Node-backed Helper fixture; actual Electron/native ABI is checked by smoke:package. */
export async function fixtureExecutor(runtime: string): Promise<string> {
  const helper = bundledNodePath(runtime);
  await mkdir(dirname(helper), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(`${helper}.cjs`, `
    if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw Error('missing ELECTRON_RUN_AS_NODE');
    Object.defineProperty(process.versions, 'electron', { value: '44.4.3' });
  `);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(helper, `#!/bin/sh\nexec ${quote(process.execPath)} --require "$0.cjs" "$@"\n`, { mode: 0o755 });
  return helper;
}
