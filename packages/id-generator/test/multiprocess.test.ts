import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("U03 independent processes at the same millisecond produce distinct IDs for every prefix", async () => {
  const moduleUrl = new URL(process.env.PRECEDENT_LOOP_TEST_DIST === "1" ? "../dist/index.js" : "../src/index.ts", import.meta.url).href;
  const run = () => new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      Date.now = () => 1900000000000;
      const { SnowflakeIdGenerator, ID_PREFIXES } = await import(${JSON.stringify(moduleUrl)});
      const generator = new SnowflakeIdGenerator();
      console.log(JSON.stringify(ID_PREFIXES.map(prefix => generator.next(prefix))));
    `], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let output = ""; let error = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(output) as string[]) : reject(new Error(error)));
  });
  const outputs = await Promise.all(Array.from({ length: 8 }, run));
  console.log(`U03_SAME_CLOCK_PROCESS_IDS ${JSON.stringify(outputs)}`);
  for (const index of outputs[0]!.keys()) {
    assert.equal(new Set(outputs.map(ids => ids[index])).size, outputs.length, "process-local fixed-node Snowflake must not collide across writers");
  }
});
