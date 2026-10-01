import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const server = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(server, "../..");
const target = join(process.argv[2] ? resolve(process.argv[2]) : join(server, "dist"), "resources");
await mkdir(target, { recursive: true });
// Remove only retired generated resources, including incremental build leftovers.
for (const retired of ["KNOWLEDGE.md", "README.md", "data-and-behavior.md", "skills", "integrations/codex", "integrations/claude"]) {
  await rm(join(target, retired), { recursive: true, force: true });
}
await cp(join(server, "resources"), target, { recursive: true });
await mkdir(join(target, "integrations"), { recursive: true });
await cp(join(root, "apps/desktop/resources/precedent-hook.sh.template"), join(target, "integrations/precedent-hook.sh.template"));
