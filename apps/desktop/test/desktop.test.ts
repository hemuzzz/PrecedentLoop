import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Backend } from "../src/backend.js";
import { appConfigSchema, inspectNode, runtimeConfig, type BuildInfo } from "../src/config.js";
import { fixtureExecutor } from "./executor-fixture.js";
import { navigationTarget } from "../src/navigation.js";
import { assertClosedDependencies } from "../src/package-app.js";
import { replaceApp, updateApp } from "../src/update-app.js";
import { allocatePort } from "../src/verify-service.js";

test("navigation only admits the Hub page, separates local references and blocks executable schemes", () => {
  const origin = "http://127.0.0.1:18888";
  assert.equal(navigationTarget(origin + "/#/library", origin).kind, "internal");
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "data:text/html,x", "not a url",
    origin + "/api/system/status", origin + "/assets/app.js", origin + "/missing", origin + "/?unknown=1",
    "file://remote-host/share/file.md", origin + "/Users/a/%00bad.md", origin + "/Users/a/file.java:0",
    origin + "/Users/a/file.md?query=1", origin + "/Users/a/%E0%A4%A", origin + "/Users/%2F..%2Fetc/passwd"]) {
    assert.equal(navigationTarget(url, origin).kind, "blocked", url);
  }
  for (const url of ["https://example.com", "http://127.0.0.1:18889", "http://127.0.0.1.example.com:18888"]) {
    assert.equal(navigationTarget(url, origin).kind, "external");
  }
  assert.deepEqual(navigationTarget(origin + "/Users/example/project/Service.java:89", origin),
    { kind: "local", path: "/Users/example/project/Service.java", line: 89 });
  assert.deepEqual(navigationTarget(origin + "/Users/example/My%20Project/%E8%AE%BE%E8%AE%A1.md:12:3", origin),
    { kind: "local", path: "/Users/example/My Project/设计.md", line: 12, column: 3 });
  assert.deepEqual(navigationTarget("file:///tmp/source.java#L15", origin),
    { kind: "local", path: "/tmp/source.java", line: 15 });
  assert.deepEqual(navigationTarget(origin + "/Users/example/project/README.md", origin),
    { kind: "local", path: "/Users/example/project/README.md" });
});

test("dependency closure allows internal symlinks, rejects external ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-links-"));
  try {
    await mkdir(join(root, "pkg"));
    await symlink("pkg", join(root, "internal"));
    await assertClosedDependencies(root);
    await symlink(tmpdir(), join(root, "external"));
    await assert.rejects(assertClosedDependencies(root), /越出/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("test installation cannot target Applications or reuse an active update lock", async () => {
  await assert.rejects(updateApp('/unused.json', { name: 'PrecedentLoop-Test-lock',
    bundleId: 'local.precedentloop.desktop.test.lock', path: '/Applications/PrecedentLoop-Test-lock.app' }), /测试安装/);
  const root = await mkdtemp(join(tmpdir(), "desktop-lock-"));
  try {
    const name='PrecedentLoop-Test-lock';
    const config=join(root,'config.json'); await writeFile(config,JSON.stringify({nodePath:process.execPath}));
    await mkdir(join(root,`.${name}.update.lock`));
    await assert.rejects(updateApp(config,{name,bundleId:'local.precedentloop.desktop.test.lock',path:join(root,`${name}.app`)}), {code:'EEXIST'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("replacement failure restores old program, successful replacement preserves backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-replace-"));
  try {
    const target = join(root, "App"), backup = join(root, "backup"), staged = join(root, "stage");
    await mkdir(target); await writeFile(join(target, "version"), "A");
    await assert.rejects(replaceApp(staged, target, backup));
    assert.equal(await readFile(join(target, "version"), "utf8"), "A");
    await mkdir(staged); await writeFile(join(staged, "version"), "B");
    await replaceApp(staged, target, backup);
    assert.equal(await readFile(join(target, "version"), "utf8"), "B");
    assert.equal(await readFile(join(backup, "version"), "utf8"), "A");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(source: string): Promise<{ root: string; backend: Backend }> {
  const root = await mkdtemp(join(tmpdir(), "desktop-process-"));
  const runtime = join(root, "PrecedentLoop-Test-backend.app/Contents/Resources/runtime");
  const helper = await fixtureExecutor(runtime);
  await mkdir(join(runtime, "apps/server/dist"), { recursive: true });
  await writeFile(join(runtime, "apps/server/package.json"), '{"type":"module"}');
  await writeFile(join(runtime, "apps/server/dist/main.js"), source);
  const build: BuildInfo = { buildId: randomUUID(), ...await inspectNode(helper) };
  await writeFile(join(runtime, "build-info.json"), JSON.stringify(build));
  const config = runtimeConfig(appConfigSchema.parse({ configVersion: 1, setupVersion: 1, setupCompleted: true,
    dataDirectory: root, port: await allocatePort(), startupTimeoutMs: 500, shutdownTimeoutMs: 1000 }));
  return { root, backend: new Backend(runtime, config, build) };
}

test("a READY old HTTP server cannot mask a failed new child", async () => {
  const { root, backend } = await fixture("process.exitCode=1;");
  const old = createServer((_req, res) => res.end(JSON.stringify({ ok: true, data: { buildId: backend.build.buildId,
    service: { readiness: "READY" }, mcpEndpoint: { ready: true } } })));
  try {
    await new Promise<void>(resolve => old.listen(backend.config.port, "127.0.0.1", resolve));
    await assert.rejects(backend.start());
    assert.equal(backend.isReady, false);
  } finally {
    await backend.stop().catch(() => {});
    await new Promise<void>(resolve => old.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("open-inbox before and after listening emits events without failing backend readiness", async () => {
  const { root, backend } = await fixture(`
    import { createServer } from 'node:http'; import { readFileSync } from 'node:fs';
    const build = JSON.parse(readFileSync('build-info.json','utf8'));
    const server = createServer((_req,res)=>res.end(JSON.stringify({ok:true,data:{buildId:build.buildId,service:{readiness:'READY'},mcpEndpoint:{ready:true}}})));
    process.on('SIGTERM',()=>server.close(()=>process.disconnect())); process.send({type:'booted'});
    process.send({type:'open-inbox'});
    process.on('message',()=>process.send({type:'open-inbox'}));
    server.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send({type:'listening',buildId:build.buildId,endpoint:'http://127.0.0.1:'+process.env.PORT+'/mcp'}));
  `);
  let inboxEvents = 0;
  const failures: Error[] = [];
  backend.on("open-inbox", () => { inboxEvents++; });
  backend.on("unavailable", (error: Error) => { failures.push(error); });
  try {
    assert.equal(backend.isReady, false);
    const starting = backend.start(); assert.equal(backend.isReady, false);
    await starting; assert.equal(backend.isReady, true);
    assert.equal(inboxEvents, 1);
    const notified = new Promise<void>(resolve => backend.once("open-inbox", resolve));
    backend.child!.send({ type: "notify" });
    await notified;
    assert.equal(inboxEvents, 2); assert.equal(backend.isReady, true);
    assert.deepEqual(failures, []);
    const stopping = backend.stop(); assert.equal(backend.isReady, false); await stopping;
  } finally { await backend.stop(); await rm(root, { recursive: true, force: true }); }
});

test("unknown backend messages still fail listening validation", async () => {
  const { root, backend } = await fixture(`
    process.on('SIGTERM',()=>process.disconnect());
    process.on('message',()=>{});
    process.send({type:'booted'}); process.send({type:'unknown'});
  `);
  const failures: Error[] = [];
  backend.on("unavailable", (error: Error) => { failures.push(error); });
  try {
    await assert.rejects(backend.start(), /后端监听回执与目标构建不匹配/);
    assert.equal(backend.isReady, false);
    assert.match(failures[0]!.message, /后端监听回执与目标构建不匹配/);
  } finally { await backend.stop(); await rm(root, { recursive: true, force: true }); }
});

test("startup cancellation waits for early signal handler and repeated exit shares cleanup", async () => {
  const { root, backend } = await fixture(`
    process.on('SIGTERM',()=>{process.disconnect();});
    process.send({type:'booted'});
    process.on('message',()=>{});
  `);
  try {
    const startup = backend.start();
    const rejected = assert.rejects(startup);
    while (!backend.child) await delay(5);
    const first = backend.stop();
    assert.equal(backend.stop(), first);
    await first;
    await rejected;
    assert.equal(backend.child.exitCode, 0);
  } finally { await backend.stop(); await rm(root, { recursive: true, force: true }); }
});

test("startup timeout retains child for normal cleanup", async () => {
  const { root, backend } = await fixture(`
    process.on('SIGTERM',()=>process.disconnect()); process.send({type:'booted'}); process.on('message',()=>{});
  `);
  try {
    await assert.rejects(backend.start(), /超时/);
    assert.equal(backend.child?.exitCode, null);
    await backend.stop();
    assert.equal(backend.child?.exitCode, 0);
  } finally { await backend.stop(); await rm(root, { recursive: true, force: true }); }
});

test("shutdown timeout never kills or abandons the still-owned child", async () => {
  const { root, backend } = await fixture(`
    process.on('SIGTERM',()=>{}); process.send({type:'booted'});
    process.on('message',message=>{if(message==='release')process.disconnect();});
  `);
  try {
    await assert.rejects(backend.start(), /超时/);
    await assert.rejects(backend.stop(), /不会自动强杀/);
    assert.equal(backend.child?.exitCode, null);
    const closed = new Promise<void>(resolve => backend.child!.once('close',()=>resolve()));
    backend.child!.send('release');
    await closed;
    assert.equal(backend.child?.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
