import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { resolveWorkspaceFromConfig } from "../src/workspace/resolver.js";
import { knowledgeFixture } from "../test-support/knowledge-fixture.js";

test("trusted workspace resolution uses the longest segment-boundary match, including Windows paths", () => {
  const config = { schemaVersion: 1 as const, workspaces: [
    { name: "parent", paths: ["/foo/bar", "C:\\foo\\bar"], knowledgeAccess: "HOST_ONLY" as const },
    { name: "nested", paths: ["/foo/bar/project", "C:\\foo\\bar\\project"], knowledgeAccess: "HOST_ONLY" as const },
  ] };
  for (const [cwd, expected] of [
    ["/foo/bar/project/src", "nested"], ["/foo/bar/other", "parent"], ["/foo/barista", null], ["/unmatched", null],
    ["C:\\foo\\bar\\project\\src", "nested"], ["C:\\foo\\barista", null],
  ] as const) assert.equal(resolveWorkspaceFromConfig(cwd, config), expected);
  assert.throws(() => resolveWorkspaceFromConfig("relative/path", config), { code: "WORKSPACE_CWD_INVALID" });
});

test("equally specific mappings fail closed in both resolver and capability issuance without persisting a grant", async () => {
  const f = await knowledgeFixture();
  try {
    const config = { schemaVersion: 1 as const, workspaces: [
      { name: "alpha", paths: ["/same/root"], knowledgeAccess: "HOST_ONLY" as const },
      { name: "beta", paths: ["/same/root"], knowledgeAccess: "HOST_ONLY" as const },
    ] };
    assert.throws(() => resolveWorkspaceFromConfig("/same/root/src", config), { code: "WORKSPACE_MATCH_AMBIGUOUS" });
    const before = f.rows();
    for (const source of [JSON.stringify(config), "{invalid"]) {
      await writeFile(f.options.workspaceConfigPath, source);
      await assert.rejects(f.capabilities.issueFromTrustedHost("/same/root/src"), { code: "WORKSPACE_CONFIG_UNAVAILABLE" });
      assert.deepEqual(f.rows(), before);
    }
  } finally { await f.close(); }
});
