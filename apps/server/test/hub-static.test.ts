import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";

test("N10 serves only the built Hub entry and real static assets without SPA fallback", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n10-static-"));
  try {
    await mkdir(join(rootPath, "assets"), { recursive: true });
    await writeFile(join(rootPath, "index.html"), "<!doctype html><title>Asset Desk</title>", "utf8");
    await writeFile(join(rootPath, "assets", "index.js"), "globalThis.hub = true;", "utf8");
    const app = createApp(undefined, { root: rootPath });

    const index = await app.request("http://localhost/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await index.text(), /Asset Desk/u);

    const asset = await app.request("http://localhost/assets/index.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/u);
    assert.match(await asset.text(), /hub = true/u);

    for (const path of ["/assets/missing.js", "/api/not-found", "/mcp", "/client-route"]) {
      const response = await app.request(`http://localhost${path}`);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /Asset Desk/u, path);
    }
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
});
