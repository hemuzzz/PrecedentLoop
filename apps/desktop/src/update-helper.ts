import { constants } from "node:fs";
import { cp, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readBuildInfo, verifyBundledNode } from "./config.js";
import { assertClosedDependencies } from "./package-files.js";

/** Both executable and helper survive replacement of the installed App. */
export async function stageUpdateHelper(resources: string, root: string): Promise<{ node: string; entry: string }> {
  const runtime = join(resources, "runtime");
  const build = await readBuildInfo(runtime);
  await verifyBundledNode(runtime, build);
  const source = resolve(resources, "../..");
  const helper = join(root, "helper", basename(source));
  // COPYFILE_FICLONE falls back to a normal copy when cloning is unsupported.
  await cp(source, helper, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
  await assertClosedDependencies(helper);
  const node = await verifyBundledNode(join(helper, "Contents/Resources/runtime"), build);
  return { node, entry: await realpath(join(helper, "Contents/Resources/app/dist/update-app.js")) };
}
