import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "codex-capture-build-"));
const entry = fileURLToPath(new URL("../dist/hook/capture-cli.js", import.meta.url));
const times = { activity: [], record: [], stop: [] };
const environment = { PATH: process.env.PATH, PRECEDENT_LOOP_CAPTURE_CACHE_PATH: root };
function invoke(kind, input, record = false) {
  const start = performance.now();
  const child = spawnSync(process.execPath, [entry, ...(record ? ["--record"] : [])], {
    input: JSON.stringify(input), encoding: "utf8", env: environment, timeout: 1500,
  });
  times[kind].push(performance.now() - start);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
try {
  for (let i = 0; i < 10; i++) {
    const turn = { session_id: "synthetic-build", turn_id: `turn-${i}` };
    assert.deepEqual(invoke("stop", { ...turn, hook_event_name: "Stop" }), {});
    const activity = { ...turn, hook_event_name: "PostToolUse", tool_name: i % 2 ? "apply_patch" : "Bash", tool_response: { exit_code: 1 } };
    assert.deepEqual(invoke("activity", activity), {});
    const warning = invoke("stop", { ...turn, hook_event_name: "Stop" });
    assert.deepEqual(Object.keys(warning), ["systemMessage"]);
    assert.deepEqual(invoke("stop", { ...turn, hook_event_name: "Stop" }), {});
    assert.deepEqual(invoke("record", {
      sessionId: turn.session_id, turnId: turn.turn_id,
      outcome: "CANDIDATE", reason: "隔离构建样本", references: ["synthetic readonly suggestion"],
    }, true), { recorded: true });
    assert.deepEqual(invoke("stop", { ...turn, hook_event_name: "Stop" }), {});
  }
  const allEntries = await readdir(root, { recursive: true });
  assert.equal(allEntries.some(path => /sqlite|database|assets|usage/i.test(path)), false);
  const timings = Object.fromEntries(Object.entries(times).map(([name, samples]) => {
    const sorted = samples.toSorted((a, b) => a - b);
    return [name, { count: samples.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1), maxMs: +sorted.at(-1).toFixed(1) }];
  }));
  console.log(JSON.stringify({ status: "PASS", environment: "isolated compiled CLI, no database or server", timings }));
} finally { await rm(root, { recursive: true, force: true }); }
