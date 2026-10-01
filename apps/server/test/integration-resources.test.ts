import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("bundled resources contain only import rules, content model and launcher, without retired host files", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-resources-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const retired of ["KNOWLEDGE.md", "README.md", "data-and-behavior.md", "skills/old/SKILL.md", "integrations/codex/KNOWLEDGE.md", "integrations/claude/references/old.md"]) {
    const path = join(root, "resources", retired); await mkdir(dirname(path), { recursive: true }); await writeFile(path, "old generated resource");
  }
  const copied = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/copy-resources.mjs", import.meta.url)), root], { encoding: "utf8" });
  assert.equal(copied.status, 0, copied.stderr);
  const resources = join(root, "resources");
  for (const file of ["knowledge-import/SKILL.md", "knowledge-content-model.md", "integrations/precedent-hook.sh.template", "ai-providers.json"]) assert.ok((await stat(join(resources, file))).isFile());
  const files = await readdir(resources, { recursive: true });
  assert.equal(files.some(file => /KNOWLEDGE|^skills|integrations\/(codex|claude)|data-and-behavior|README/u.test(file)), false);
  const rules = await readFile(join(resources, "knowledge-import/SKILL.md"), "utf8");
  for (const marker of ["有增量", "无增量", "文档已写", "测试通过", "没搜到"]) assert.ok(rules.includes(marker));
});
