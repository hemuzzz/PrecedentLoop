import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function assertClosedDependencies(root: string): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error("App 必须是普通目录");
  const boundary = await realpath(root);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const actual = await realpath(target);
        const rel = relative(boundary, actual);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`生产依赖链接越出 App：${target}`);
      } else if (entry.isDirectory()) await visit(target);
    }
  };
  await visit(root);
}
