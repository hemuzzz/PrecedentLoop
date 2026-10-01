// Actual Codex CLI and Hook transport, scripted loopback model only.
// No live-model decisions, credentials copied, or real knowledge data in the fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateKnowledge } from "../dist/knowledge/repository.js";

const root = await mkdtemp(join(tmpdir(), "codex-protocol-client-"));
const installedHome = process.env.PRECEDENT_LOOP_TEST_CODEX_HOME;
const home = installedHome ?? join(root, "codex-home");
const project = join(root, "project");
const requests = [];
const model = createServer(async (request, response) => {
  if (request.url !== "/v1/responses") { response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PROTOCOL_CLIENT_COMPLETE", annotations: [] }] };
  const result = { id: "resp_fixture", object: "response", created_at: 1900000000, status: "completed", model: "fixture", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: result },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});

try {
  await mkdir(project); await writeFile(join(project, "AGENTS.md"), "保护已有文件；不提交代码。\n");
  if (!installedHome) {
    await mkdir(home);
    await writeFile(join(home, "AGENTS.md"), "保护已有文件；不提交代码。\n");
    const databasePath = join(root, "fixture.sqlite"); migrateKnowledge(databasePath, false, true);
    const workspaceConfigPath = join(root, "workspaces.json");
    await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
    const wrapper = join(root, "hook.mjs");
    await writeFile(wrapper, `import {runHookCli} from ${JSON.stringify(new URL("../dist/hook/user-prompt-submit.js", import.meta.url).href)}; Object.assign(process.env, ${JSON.stringify({ PRECEDENT_LOOP_DATABASE_PATH: databasePath, PRECEDENT_LOOP_WORKSPACES_PATH: workspaceConfigPath })}); await runHookCli();\n`);
    const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
    await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(wrapper)}`, timeout: 10, additionalContextLimit: 8000 }] }] } }));
  }
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const config = {
    model: "fixture", model_provider: "fixture",
    "model_providers.fixture.name": "Local protocol fixture",
    "model_providers.fixture.base_url": `http://127.0.0.1:${model.address().port}/v1`,
    "model_providers.fixture.wire_api": "responses",
    "model_providers.fixture.requires_openai_auth": false,
  };
  // Installed trust lives in config.toml. Ignoring that file would test an
  // untrusted setup instead of the user's existing, normally trusted Hook.
  if (installedHome) {
    const settings = await readFile(join(home, "config.toml"), "utf8");
    for (const match of settings.matchAll(/^\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\]$/gm)) config[`mcp_servers.${match[1]}.enabled`] = false;
  }
  const args = ["exec", ...(!installedHome ? ["--ignore-user-config"] : []), "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "-C", project,
    ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ...(!installedHome ? ["--dangerously-bypass-hook-trust"] : []), "你好，简短打个招呼。"];
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.env.PRECEDENT_LOOP_TEST_CODEX ?? "/opt/homebrew/bin/codex", args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home, TMPDIR: tmpdir() }, stdio: ["ignore", "pipe", "pipe"], timeout: 45000,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
  // Do not print raw model requests: installed-home context can contain capabilities.
  assert.equal(outcome.code, 0, `Codex CLI did not complete the loopback fixture: ${outcome.stderr.replace(/cap_[A-Za-z0-9_-]+/g, "[capability]").slice(-2000)}`);
  assert.match(outcome.stdout, /PROTOCOL_CLIENT_COMPLETE/);
  assert.ok(requests.length > 0);
  const delivered = JSON.stringify(requests[0]);
  if (!delivered.includes("Precedent Loop 知识库")) console.error(JSON.stringify({ hookDiagnostics: outcome.stderr.split("\n").filter(line => /hook|trust|error/i.test(line)).slice(-12), requests: requests.length }));
  for (const marker of ["Precedent Loop 知识库", "knowledge_recall", "asset_mark_used", "candidate_prepare"]) assert.ok(delivered.includes(marker), `Missing ${marker}`);
  assert.doesNotMatch(delivered, /KNOWLEDGE\.md|memory-recall|knowledge-capture|memory-usage-settlement/);
  if (process.env.PRECEDENT_LOOP_TEST_NO_LEGACY === "1" || !installedHome) {
    assert.equal(delivered.includes("### 工程知识（Precedent Loop 2.4）"), false, "Legacy global section leaked into the test");
    assert.equal(delivered.includes("### 交付前知识评估"), false, "Legacy delivery section leaked into the test");
  }
  assert.ok(delivered.includes("outcome"));
  console.log(JSON.stringify({ status: "PASS", client: "actual Codex CLI", home: installedHome ? "installed" : "isolated", hookTrust: installedHome ? "normal existing trust" : "fixture-only bypass", model: "scripted loopback; no live model", requests: requests.length, contextDelivered: true, selfContainedContext: true, automaticBehavior: "NOT_TESTED" }));
} finally {
  await new Promise(resolve => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
