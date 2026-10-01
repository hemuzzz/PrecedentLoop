import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// This smoke replaces only a disposable build's provider file. Never point it
// at the installed dist, a packaged app, or a real knowledge database.
const build = resolve(process.argv[2] ?? "");
assert.ok(basename(build).startsWith(".candidate-build-"), "Pass an isolated .candidate-build-* directory");
const { startPrecedentLoopServer } = await import(pathToFileURL(join(build, "runtime.js")).href);
const { initializeCodexWorkspaces } = await import(pathToFileURL(join(build, "workspace/codex-projects.js")).href);
const root = await mkdtemp(join(tmpdir(), "candidate-build-smoke-"));
const repository = join(root, "repository"), database = join(root, "data.sqlite"), workspaces = join(root, "workspaces.json");
const providerPath = join(build, "resources/ai-providers.json");
const originalProviders = await readFile(providerPath);
const environment = { ...process.env, PRECEDENT_LOOP_ASSET_REPOSITORY_PATH: repository, PRECEDENT_LOOP_DATABASE_PATH: database, PRECEDENT_LOOP_WORKSPACES_PATH: workspaces };
let runtime, client;
try {
  await mkdir(join(repository, "assets"), { recursive: true });
  await writeFile(workspaces, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  for (const file of ["knowledge-import/SKILL.md", "knowledge-content-model.md"]) {
    assert.ok((await readFile(join(build, "resources", file), "utf8")).length > 0, file);
  }
  assert.doesNotMatch(await readFile(join(build, "resources/knowledge-import/SKILL.md"), "utf8"), /knowledge-capture|KNOWLEDGE/u);
  await cli("maintenance-cli.js", ["init-database", "--offline"]);
  const mockCli = join(root, "mock-codex.mjs");
  await writeFile(mockCli, `#!${process.execPath}\nimport fs from 'node:fs';
    const a=process.argv.slice(2);
    if(a.includes('--help')) console.log('--ignore-rules --output-schema --output-last-message --ephemeral --sandbox');
    else if(a.includes('features')) console.log('hooks stable true\\nshell_tool stable true');
    else if(a.includes('mcp')) console.log('[]');
    else {let prompt='';for await(const part of process.stdin)prompt+=part;
      if(!prompt.includes('知识内容模型') || !prompt.includes('有增量'))process.exit(42);
      const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));
      const result=schema.properties.candidates
        ? {schemaVersion:1,candidates:[],sourceResults:[{sourceKey:'0',explanation:'无独立增量',pendingRef:null}],warnings:[]}
        : {schemaVersion:1,content:{title:'编译验证改稿',summary:'摘要',bodyMarkdown:'compiled-candidate-token'},explanation:'修改正文'};
      fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(result));}
  `, { mode: 0o700 });
  await writeFile(providerPath, JSON.stringify({ providers: [{ id: "codex", executable: mockCli, timeoutMs: 5000 }] }));
  const prepared = await cli("asset/candidate-cli.js", ["prepare"], { requestId: "prepare", candidates: [{ title: "编译验证", summary: "摘要", bodyMarkdown: "原文", type: "MEMORY", target: { scope: "GLOBAL" } }] });
  const item = prepared.data.candidates[0];
  const codexState = join(root, "codex-state.json");
  await writeFile(codexState, JSON.stringify({ "local-projects": { local: { name: "smoke-project", rootPaths: [root] } } }));
  const initialized = await initializeCodexWorkspaces({ repositoryPath: repository, workspaceConfigPath: workspaces }, codexState);
  assert.deepEqual(initialized.workspaces, [{ name: "smoke-project", paths: [await realpath(root)] }]);
  const port = await freePort();
  const configuration = { assetRepositoryPath: repository, databasePath: database, workspaceConfigPath: workspaces, logPath: join(root, "server.log"), port };
  const origin = `http://127.0.0.1:${port}`;
  runtime = await startPrecedentLoopServer(configuration);
  const get = async path => { const response = await fetch(origin + path); assert.equal(response.status, 200, path); return (await response.json()).data; };
  let token = (await get("/api/inbox/session")).token;
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", "x-hub-write-token": token }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  const selected = { candidateId: item.candidateId, assetId: item.assetId, candidateHash: item.contentHash };
  assert.deepEqual((await post("/api/inbox/workspaces", {})).workspaces, ["smoke-project"]);
  assert.equal((await get("/api/inbox")).items[0].candidateId, item.candidateId);
  await post("/api/inbox/defer", { ...selected, requestId: "defer", deferred: true });
  await post("/api/inbox/rewrite", { ...selected, requestId: "rewrite", provider: "codex", instructions: "修改" });
  assert.equal((await finished(get, "rewrite")).state, "SUCCEEDED");
  const rewritten = (await get("/api/inbox")).items[0];
  assert.equal(rewritten.reviewBucket, "PENDING"); assert.notEqual(rewritten.contentHash, item.contentHash);
  await post("/api/inbox/accept", { ...selected, candidateHash: rewritten.contentHash, requestId: "accept" });
  assert.equal((await get("/api/inbox")).items.length, 0);
  assert.match((await get(`/api/assets/${item.assetId}`)).asset.rawMarkdown, /compiled-candidate-token/u);
  await get(`/api/assets/${item.assetId}/diff`);
  client = new Client({ name: "candidate-build-smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.endpoint)));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["asset_mark_used", "asset_read", "candidate_prepare", "candidate_update", "knowledge_recall"]);
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const read = await call("asset_read", { capabilityIds: [], assetId: item.assetId });
  assert.ok(read.readRef); await call("asset_mark_used", { capabilityIds: [], readRef: read.readRef });
  const recall = await call("knowledge_recall", { capabilityIds: [], queries: ["compiled-candidate-token"] });
  assert.equal(recall.items[0].assetId, item.assetId);
  await post("/api/inbox/import", { requestId: "empty-import", provider: "codex", sources: [{ name: "one.markdown", content: "资料" }], targets: [] });
  assert.equal((await finished(get, "empty-import")).result.count, 0);
  await client.close(); client = undefined;
  await runtime.close(); runtime = await startPrecedentLoopServer(configuration);
  token = (await get("/api/inbox/session")).token;
  assert.equal((await get("/api/inbox/operation?requestId=empty-import")).operation.state, "SUCCEEDED");
  assert.equal((await get("/api/inbox/operation?requestId=accept")).operation.state, "SUCCEEDED");
  assert.equal((await cli("asset/candidate-cli.js", ["operation"], { requestId: "empty-import" })).data.count, 0);
  process.stdout.write(JSON.stringify({ event: "CANDIDATE_BUILD_SMOKE", status: "ok", checks: ["compiled CLI", "finite REST writes", "restricted fake CLI", "packaged rules", "Codex project setup", "automatic classification", "five MCP tools", "restart receipts"] }) + "\n");
} finally {
  await client?.close(); await runtime?.close();
  await writeFile(providerPath, originalProviders);
  await rm(root, { recursive: true, force: true });
}

async function cli(file, args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(build, file), ...args], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += String(value); }); child.stderr.on("data", value => { stderr += String(value); });
    child.once("error", reject); child.once("close", code => {
      if (code !== 0) reject(new Error(stderr));
      else { try { resolveResult(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
async function freePort() {
  const server = createServer(); await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady));
  const port = server.address().port; await new Promise(resolveClose => server.close(resolveClose)); return port;
}
async function finished(get, requestId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { operation } = await get(`/api/inbox/operation?requestId=${requestId}`);
    if (operation.state !== "RUNNING") { assert.equal(operation.state, "SUCCEEDED", JSON.stringify(operation)); return operation; }
    await delay(25);
  }
  throw new Error("AI smoke timed out");
}
