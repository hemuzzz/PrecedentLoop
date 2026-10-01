import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { packageApp } from '../dist/package-app.js';
import { prepareFixture } from '../dist/verify-service.js';
import { readyResponse } from '../dist/backend.js';
import { APP_NAME, BUNDLE_ID, appConfigSchema, executeFile, readAppConfig, readBuildInfo, resolveUserData, writeAppConfig } from '../dist/config.js';
import { backendProcesses, requestNormalQuit, runningApplications } from '../dist/macos.js';
import { updateApp } from '../dist/update-app.js';

const template = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'codex-online-macos-test-'));
const id = randomUUID();
const identity = { name: `PrecedentLoop-Test-update-${id}`, bundleId: `${BUNDLE_ID}.test.${id}` };
const previousOverride = process.env.PRECEDENT_LOOP_USER_DATA_DIR;
process.env.PRECEDENT_LOOP_USER_DATA_DIR = join(root, 'userData');
let installed;
async function waitUntil(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await delay(150); }
  throw new Error(message);
}
try {
  const { config, assetId } = await prepareFixture(join(template, 'Contents/Resources'), join(root, 'fixture'));
  const { assetRepositoryPath, databasePath, workspaceConfigPath, logPath, desktopLogPath, ...userConfig } = config;
  await writeAppConfig(resolveUserData(identity), appConfigSchema.parse(userConfig));
  const buildConfig = {};
  installed = await packageApp(buildConfig, join(root, 'installed'), identity);
  const before = await readBuildInfo(join(installed, 'Contents/Resources/runtime'));
  const origin = `http://127.0.0.1:${config.port}`;
  await executeFile('/usr/bin/open', ['--env', `PRECEDENT_LOOP_USER_DATA_DIR=${process.env.PRECEDENT_LOOP_USER_DATA_DIR}`, installed]);
  await waitUntil(() => readyResponse(origin, before.buildId).catch(() => false), '测试 A 未启动');
  const old = (await runningApplications()).find(item => item.bundleId === identity.bundleId);
  assert.ok(old);
  const source = await packageApp(buildConfig, join(root, 'downloaded'), identity);
  const next = await readBuildInfo(join(source, 'Contents/Resources/runtime'));
  await updateApp(undefined, { ...identity, path: installed }, { path: source, version: next.version, buildId: next.buildId });
  const after = await readBuildInfo(join(installed, 'Contents/Resources/runtime'));
  const actualConfig = await readAppConfig(resolveUserData(identity));
  assert.equal(actualConfig.kind, 'VALID');
  const { detectedPaths, ...preservedConfig } = actualConfig.config;
  assert.deepEqual(preservedConfig, userConfig);
  assert.equal(after.buildId, next.buildId);
  assert.notEqual(after.buildId, before.buildId);
  assert.equal((await fetch(`${origin}/api/assets/${assetId}`)).status, 200);
  assert.ok(!(await runningApplications()).some(item => item.pid === old.pid));
  assert.deepEqual((await readdir(dirname(installed))).filter(name =>
    name.startsWith(`.${APP_NAME}.previous-`) && name.endsWith('.app')), [], '更新成功后不应保留旧程序备份');
  process.stdout.write(JSON.stringify({ isolatedMacUpdate: 'PASS', oldBuild: before.buildId,
    newBuild: after.buildId, configPreserved: true, assetPreserved: true }) + '\n');
} finally {
  if ((await runningApplications()).some(item => item.bundleId === identity.bundleId)) await requestNormalQuit(identity.bundleId);
  await waitUntil(async () => !(await runningApplications()).some(item => item.bundleId === identity.bundleId), '测试 App 未退出，保留临时目录');
  if (installed) {
    const entry = join(installed, 'Contents/Resources/runtime/apps/server/dist/main.js');
    await waitUntil(async () => !(await backendProcesses(entry)).length, '测试后端未退出，保留临时目录');
  }
  await rm(root, { recursive: true, force: true });
  if (previousOverride === undefined) delete process.env.PRECEDENT_LOOP_USER_DATA_DIR;
  else process.env.PRECEDENT_LOOP_USER_DATA_DIR = previousOverride;
}
