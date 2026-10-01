import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationEngine } from "../src/integrations/engine.js";
import type { IntegrationEnvironment, CommandInput } from "../src/integrations/environment.js";
import { parseObject } from "../src/integrations/files.js";

export async function integrationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "precedent-integration-")));
  const home = join(root, "User's Home"), userData = join(root, "Application Support/PrecedentLoop-Test-engine");
  await mkdir(home); await mkdir(userData, { recursive: true });
  const packaged = join(root, "resources");
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../server/scripts/copy-resources.mjs", import.meta.url)), packaged]);
  const commands: CommandInput[] = [];
  let failAdd: string | null = null;
  const env: IntegrationEnvironment = {
    home, userData, codexHome: join(home, "custom-codex"), claudeDirectory: join(home, ".claude"), claudeConfig: join(home, ".claude.json"),
    managedSettings: join(root, "managed/managed-settings.json"), appPath: join(root, "App's 测试.app"), resources: join(packaged, "resources/integrations"),
    executables: { codex: join(root, "bin/codex"), claude: join(root, "bin/claude") }, now: () => new Date("2026-09-24T04:00:00.000Z"),
    mcpClientNames: { codex: [], claude: [] },
    run: async input => {
      commands.push(input);
      assert.equal(input.env.HOME, home); assert.equal(input.env.CODEX_HOME, env.codexHome);
      assert.equal(input.cwd, home); assert.equal(input.timeout, 30000);
      assert.equal(input.env.PATH, `${dirname(input.executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`);
      assert.equal(input.env.NODE_OPTIONS, undefined);
      const agent = input.executable.endsWith("codex") ? "codex" : "claude";
      const path = agent === "codex" ? join(env.codexHome, "config.toml") : env.claudeConfig;
      let text = await readFile(path, "utf8").catch(() => "");
      const config = agent === "codex" ? {} : text ? parseObject(text, path) : {};
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      const line = text.split("\n").find(value => value.startsWith("# mock-mcp "));
      const current = agent === "codex" ? line ? JSON.parse(line.slice(11)) : null : servers["precedent"] ?? null;
      const action = input.args[1];
      if (action === "get") {
        assert.equal(agent, "codex");
        return current ? { code: 0, stdout: JSON.stringify(current), stderr: "" } : { code: 1, stdout: "", stderr: "No MCP server named 'precedent' found." };
      }
      if (action === "add" && failAdd === agent) return { code: 1, stdout: "", stderr: "fixture failure secret must not surface" };
      const value = action === "remove" ? null : agent === "codex" ? { name: "precedent", enabled: true, transport: { type: "streamable_http", url: input.args.at(-1) } } : { type: "http", url: input.args.at(-1) };
      if (agent === "codex") text = text.split("\n").filter(value => !value.startsWith("# mock-mcp ")).join("\n") + (value ? `\n# mock-mcp ${JSON.stringify(value)}\n` : "");
      else { if (value) servers["precedent"] = value; else delete servers["precedent"]; config.mcpServers = servers; text = JSON.stringify(config); }
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await mkdir(env.codexHome); await mkdir(env.claudeDirectory);
  const config = { port: 18888, dataDirectory: join(root, "data") };
  await mkdir(join(config.dataDirectory, "config"), { recursive: true });
  await writeFile(join(config.dataDirectory, "config/workspaces.json"), JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  const engine = new IntegrationEngine(env, async () => config);
  return { root, env, engine, config, commands, setFailAdd: (agent: string | null) => { failAdd = agent; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
