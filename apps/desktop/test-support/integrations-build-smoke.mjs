import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationEngine } from "../dist/integrations/engine.js";
import { WorkspaceImporter, bundledWorkspaceWorker } from "../dist/integrations/workspaces.js";
import { bundledNodePath } from "../dist/config.js";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = resolve(desktop, "../server");
const root = await realpath(await mkdtemp(join(tmpdir(), "precedent-integration-build-")));
try {
  const runtime = join(root, "PrecedentLoop-Test-engine.app/Contents/Resources/runtime");
  await mkdir(dirname(bundledNodePath(runtime)), { recursive: true });
  await cp(process.execPath, bundledNodePath(runtime));
  await cp(join(server, "dist"), join(runtime, "apps/server/dist"), { recursive: true });
  await symlink(join(server, "node_modules"), join(runtime, "apps/server/node_modules"));
  await writeFile(join(runtime, "apps/server/package.json"), '{"type":"module"}');
  const home = join(root, "home"), codexHome = join(home, ".codex"), dataDirectory = join(root, "data");
  await mkdir(codexHome, { recursive: true }); await mkdir(join(dataDirectory, "config"), { recursive: true });
  await writeFile(join(dataDirectory, "config/workspaces.json"), '{"schemaVersion":1,"workspaces":[]}');
  const project = join(root, "project"); await mkdir(project);
  await writeFile(join(codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": { fixture: { name: "Smoke", rootPaths: [project] } } }));
  const env = { home, codexHome, userData: join(root, "userData"), claudeDirectory: join(home, ".claude"), claudeConfig: join(home, ".claude.json"),
    managedSettings: join(root, "managed/managed-settings.json"), appPath: join(root, "PrecedentLoop-Test-engine.app"),
    resources: join(runtime, "apps/server/dist/resources/integrations"), executables: { codex: null, claude: null },
    now: () => new Date(), mcpClientNames: { codex: [], claude: [] }, run: async () => { throw Error("This smoke never invokes host CLIs"); } };
  const config = async () => ({ port: 18888, dataDirectory });
  const engine = new IntegrationEngine(env, config);
  const result = await engine.apply((await engine.plan({ agent: "claude", items: ["skills", "projectContext", "captureReminder"] })).planId);
  assert.ok(result.items.every(item => item.status === "success"), JSON.stringify(result));
  assert.ok((await readFile(join(home, ".claude/settings.json"), "utf8")).includes("precedent-hook"));
  const importer = new WorkspaceImporter(env, config, bundledWorkspaceWorker(runtime, env));
  const list = await importer.list(); assert.ok(list.planId, list.reason);
  const plan = await importer.plan({ listId: list.planId, candidateIds: [list.projects[0].paths[0].candidateId] });
  assert.deepEqual(await importer.apply(plan.planId), { imported: 1, paths: [project], knowledgeAccess: "HOST_ONLY" });
  assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, "config/workspaces.json"), "utf8")).workspaces,
    [{ name: "Smoke", paths: [project], knowledgeAccess: "HOST_ONLY" }]);
  console.log("PASS: built engine + packaged resources + bundled Node workspace worker; all paths isolated");
} finally { await rm(root, { recursive: true, force: true }); }
