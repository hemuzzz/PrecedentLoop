import { OverviewApplicationService } from "../src/http/overview.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getRequestListener } from "@hono/node-server";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";
import matter from "gray-matter";

import { createApp } from "../src/app.js";
import {
  AssetConfirmationError, AssetIndexManager, InboxApplicationService,
  confirmInboxAsset, scanAssetFiles, scanAssetRepository, scanInboxRepository,
} from "../src/asset/index.js";
import { HubAssetApplicationService, SystemStatusApplicationService } from "../src/http/index.js";
import { knowledgeRuntime, initializeDatabase } from "../test-support/knowledge-fixture.js";

const ids = new SnowflakeIdGenerator();
const headers = [
  "---javascript", "---js", "---JavaScript", "--- javascript", "---\tjs",
  "---yaml", "---yml", "---json", "---toml",
] as const;
const cache = (matter as typeof matter & { cache: Record<string, unknown> }).cache;

for (const entry of ["formal", "inbox-http", "status-http", "confirm-preflight"] as const) {
  test(`F01 ${entry} rejects language headers before execution and preserves valid siblings`, async (t) => {
    for (const header of headers) {
      await t.test(JSON.stringify(header), async () => {
        const fixture = await createFixture();
        const marker = join(fixture.rootPath, "execution-marker");
        const relativePath = `${entry === "formal" ? "assets" : "inbox"}/global/memories/unsafe.md`;
        const source = unsafeSource(header, marker);
        try {
          await writeFile(join(fixture.repositoryPath, relativePath), source);
          let accepted = false;
          let diagnosticCodes: string[] = [];
          if (entry === "formal") {
            const scan = await scanAssetRepository(fixture);
            assert.equal(scan.isComplete, true);
            accepted = scan.assets.some((asset) => asset.relativePath === relativePath);
            diagnosticCodes = scan.diagnostics.filter((item) => item.path === relativePath).map((item) => item.code);
            assert.ok(scan.assets.some((asset) => asset.frontmatter.id === fixture.formalId));
          } else if (entry === "inbox-http") {
            const response = await fetch(`${fixture.origin}/api/inbox`);
            assert.equal(response.status, 200);
            const body = await response.json() as {
              ok: boolean;
              data: { items: Array<{ assetId: string; relativePath: string }>; diagnostics: Array<{ code: string; relativePath: string }> };
            };
            assert.equal(body.ok, true);
            accepted = body.data.items.some((item) => item.relativePath === relativePath);
            diagnosticCodes = body.data.diagnostics.filter((item) => item.relativePath === relativePath).map((item) => item.code);
            assert.ok(body.data.items.some((item) => item.assetId === fixture.inboxId));
          } else if (entry === "status-http") {
            // No watcher in this fixture: this GET itself scans both roots.
            const formalPath = "assets/global/memories/unsafe.md";
            await writeFile(join(fixture.repositoryPath, formalPath), unsafeSource(header, marker));
            const response = await fetch(`${fixture.origin}/api/system/status`);
            assert.equal(response.status, 200);
            const body = await response.json() as {
              ok: boolean;
              data: { repository: { formalAssetCount: number; inboxAssetCount: number }; diagnostics: Array<{ code: string; relativePath?: string }> };
            };
            assert.equal(body.ok, true);
            accepted = body.data.repository.inboxAssetCount !== 1 || body.data.repository.formalAssetCount !== 1;
            diagnosticCodes = body.data.diagnostics
              .filter((item) => item.relativePath === relativePath || item.relativePath === formalPath)
              .map((item) => item.code);
          } else {
            let error: unknown;
            try {
              await confirmInboxAsset({ relativePath, expectedContentHash: hash(source) }, fixture);
              accepted = true;
            } catch (caught) {
              error = caught;
            }
            diagnosticCodes = error instanceof AssetConfirmationError ? [error.code] : [];
          }
          const evidence = { entry, header, markerExists: existsSync(marker), accepted, diagnosticCodes };
          t.diagnostic(`F01_EVIDENCE ${JSON.stringify(evidence)}`);
          assert.equal(evidence.markerExists, false, "Frontmatter must never execute a marker write");
          assert.equal(accepted, false, "Language-selected Frontmatter must not receive Asset/candidate eligibility");
          assert.deepEqual(diagnosticCodes, entry === "confirm-preflight"
            ? ["INBOX_ASSET_INVALID"]
            : entry === "status-http" ? ["INVALID_FRONTMATTER", "INVALID_FRONTMATTER"] : ["INVALID_FRONTMATTER"]);
          if (entry === "confirm-preflight") {
            assert.equal(existsSync(join(fixture.repositoryPath, "assets/global/memories/unsafe.md")), false);
            assert.equal(await readFile(join(fixture.repositoryPath, relativePath), "utf8"), source);
            // A rejected sibling must not prevent a valid, explicitly selected test candidate.
            await confirmInboxAsset({ relativePath: fixture.inboxPath, expectedContentHash: hash(fixture.inboxSource) }, fixture);
            assert.equal(await readFile(join(fixture.repositoryPath, "assets/global/memories/valid-inbox.md"), "utf8"), fixture.inboxSource);
            assert.equal(existsSync(marker), false);
          }
          assert.equal(await readFile(join(fixture.repositoryPath, fixture.formalPath), "utf8"), fixture.formalSource);
        } finally {
          await fixture.close();
        }
      });
    }
  });
}

test("F01/S01 scans and reads current YAML bytes without populating or consuming gray-matter cache", async () => {
  const fixture = await createFixture();
  const sources: string[] = [];
  try {
    for (const lineEnding of ["\n", "\r\n"]) {
      const source = yamlSource(fixture.formalId, `中文摘要 ${JSON.stringify(lineEnding)}`, lineEnding);
      sources.push(source);
      await writeFile(join(fixture.repositoryPath, fixture.formalPath), source);
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const scan = await scanAssetFiles({ ...fixture, relativePaths: [fixture.formalPath] });
        const asset = scan.assets[0];
        assert.ok(asset);
        assert.equal(asset.markdown, source);
        assert.equal(asset.contentHash, hash(source));
        assert.match(asset.frontmatter.summary, /中文摘要/u);
        assert.equal(asset.content, `中文正文 café e\u0301 😀${lineEnding}`);
        assert.equal(Object.hasOwn(cache, source), false, "Scanner must not retain raw source in gray-matter cache");
      }
      // Seed a conflicting dependency cache entry: production reads must ignore it.
      const poisoned = matter(source);
      poisoned.data.summary = "STALE_CACHE_MARKER";
      poisoned.content = "STALE_CACHE_MARKER";
      const scan = await scanAssetFiles({ ...fixture, relativePaths: [fixture.formalPath] });
      assert.ok(scan.assets[0]);
      assert.doesNotMatch(JSON.stringify(scan.assets[0]), /STALE_CACHE_MARKER/u);
      const current = await fixture.search.read({ assetId: fixture.formalId, context: { authorizedWorkspaces: [] } });
      assert.equal(current.markdown, source);
      assert.equal(current.contentHash, hash(source));
      assert.notEqual(current.frontmatter.summary, "STALE_CACHE_MARKER");
      assert.equal(await readFile(join(fixture.repositoryPath, fixture.formalPath), "utf8"), source);
      delete cache[source];
    }
  } finally {
    for (const source of sources) delete cache[source];
    await fixture.close();
  }
});

test("F01 rejects executable YAML tags as data errors while allowing literal header text in Markdown bodies", async () => {
  const fixture = await createFixture();
  const marker = join(fixture.rootPath, "yaml-tag-marker");
  try {
    const source = yamlSource(ids.next("ast"), "tag sample").replace(
      "summary: tag sample",
      `summary: !!js/function 'function () { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); }'`,
    );
    await writeFile(join(fixture.repositoryPath, "inbox/global/memories/tag.md"), source);
    const scan = await scanInboxRepository(fixture);
    assert.deepEqual(scan.assets.map((asset) => asset.frontmatter.id), [fixture.inboxId]);
    assert.ok(scan.diagnostics.some((item) => item.code === "INVALID_FRONTMATTER"));
    assert.equal(existsSync(marker), false);
    const literalSource = `${fixture.formalSource}\n---javascript\nThis is literal body text.\n`;
    await writeFile(join(fixture.repositoryPath, fixture.formalPath), literalSource);
    const formal = await scanAssetRepository(fixture);
    assert.equal(formal.assets[0]?.markdown, literalSource);
    assert.equal(formal.assets[0]?.contentHash, hash(literalSource));
  } finally {
    await fixture.close();
  }
});

function unsafeSource(header: string, marker: string): string {
  const data = { id: ids.next("ast"), type: "MEMORY", scope: "GLOBAL", title: "unsafe candidate", summary: "unsafe summary" };
  const language = header.slice(3).trim().toLowerCase();
  const payload = language === "js" || language === "javascript"
    ? `(require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'F01 executed'), ${JSON.stringify(data)})`
    : language === "json" ? JSON.stringify(data) : Object.entries(data).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `${header}\n${payload}\n---\nUntrusted test body\n`;
}

function yamlSource(id: string, summary: string, lineEnding = "\n"): string {
  return ["---", `id: ${id}`, "type: MEMORY", "scope: GLOBAL", "title: 中文规则", `summary: ${summary}`, "---", "中文正文 café e\u0301 😀", ""].join(lineEnding);
}

function hash(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-f01-"));
  const repositoryPath = join(rootPath, "repository");
  const databasePath = join(rootPath, "memory.sqlite");
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  await mkdir(join(repositoryPath, "assets/global/memories"), { recursive: true });
  await mkdir(join(repositoryPath, "inbox/global/memories"), { recursive: true });
  await writeFile(workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  const formalId = ids.next("ast");
  const inboxId = ids.next("ast");
  const formalPath = "assets/global/memories/valid-formal.md";
  const inboxPath = "inbox/global/memories/valid-inbox.md";
  const formalSource = yamlSource(formalId, "合法正式摘要");
  const inboxSource = yamlSource(inboxId, "合法候选摘要");
  await writeFile(join(repositoryPath, formalPath), formalSource);
  await writeFile(join(repositoryPath, inboxPath), inboxSource);
  const options = { repositoryPath, databasePath, workspaceConfigPath };
  initializeDatabase(databasePath);

  const index = await AssetIndexManager.create(options);
  await index.synchronize();
  const runtime = knowledgeRuntime(options, () => index.status(), () => index.synchronize());
  const { search, projection, repository } = runtime;
  const inboxService = new InboxApplicationService(options, search);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const authority = `127.0.0.1:${address.port}`;
  const app = createApp({
    allowedAuthority: authority,
    assetService: new HubAssetApplicationService(search, projection, repository),
    inboxService, projection,
    indexStatus: () => index.status(),
    overviewService: new OverviewApplicationService({ ...options, inboxService, projection }),
    systemStatusService: new SystemStatusApplicationService({
      ...options, inboxService, indexStatus: () => index.status(), mcpEndpointReady: () => false,
    }),
  });
  server.on("request", getRequestListener(app.fetch));
  return {
    ...options, rootPath, formalId, inboxId, formalPath, inboxPath, formalSource, inboxSource,
    origin: `http://${authority}`, search,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      runtime.close();
      await index.close();
      await rm(rootPath, { recursive: true, force: true });
    },
  };
}
