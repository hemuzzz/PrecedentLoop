import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeModelCatalog, codexModelCatalog, parseClaudeHelp } from "../src/ai-models.js";

const levels = (...efforts: string[]) => efforts.map(effort => ({ effort, description: effort }));

test("Codex catalog lists visible models by priority with their levels, and reads top-level defaults only", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-ai-models-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await codexModelCatalog(root), { models: [], efforts: [], current: { model: null, effort: null } });
  await writeFile(join(root, "models_cache.json"), JSON.stringify({ fetched_at: "x", models: [
    { slug: "second", display_name: "Second", visibility: "list", priority: 2, default_reasoning_level: "low", supported_reasoning_levels: levels("low", "medium") },
    { slug: "hidden", visibility: "hide", priority: 0, supported_reasoning_levels: levels("low") },
    { slug: "first", display_name: "First", visibility: "list", priority: 1, default_reasoning_level: "medium", supported_reasoning_levels: levels("low", "medium", "ultra", "Bad Level") },
  ] }));
  await writeFile(join(root, "config.toml"), 'model = "first"\nmodel_reasoning_effort = "high"\n[profiles.fast]\nmodel = "second"\nmodel_reasoning_effort = "low"\n');
  const catalog = await codexModelCatalog(root);
  assert.deepEqual(catalog.models.map(model => [model.id, model.label, model.efforts, model.defaultEffort]),
    [["first", "First", ["low", "medium", "ultra"], "medium"], ["second", "Second", ["low", "medium"], "low"]]);
  assert.deepEqual(catalog.efforts, ["low", "medium", "ultra"]);
  assert.deepEqual(catalog.current, { model: "first", effort: "high" });
  // A configured model missing from the cache stays selectable instead of disappearing.
  await writeFile(join(root, "config.toml"), 'model = "custom-model"\n');
  assert.deepEqual((await codexModelCatalog(root)).models.at(-1), { id: "custom-model", label: "custom-model", efforts: ["low", "medium", "ultra"], defaultEffort: null });
  await writeFile(join(root, "models_cache.json"), "{broken");
  assert.deepEqual((await codexModelCatalog(root)).models.map(model => model.id), ["custom-model"]);
});

test("Claude catalog parses aliases and effort levels from the installed CLI help and reads settings defaults", async t => {
  const root = await mkdtemp(join(tmpdir(), "precedent-ai-models-")); t.after(() => rm(root, { recursive: true, force: true }));
  const help = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').`;
  assert.deepEqual(parseClaudeHelp(help), { models: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"] });
  assert.deepEqual(parseClaudeHelp("usage: claude"), { models: [], efforts: [] });
  const executable = join(root, "claude");
  await writeFile(executable, `#!/bin/sh\ncat <<'EOF'\n${help}\nEOF\n`, { mode: 0o700 });
  await writeFile(join(root, "settings.json"), JSON.stringify({ model: "opus", effortLevel: "high" }));
  const catalog = await claudeModelCatalog(root, executable, root);
  assert.deepEqual(catalog.models.map(model => [model.id, model.label]), [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"]]);
  assert.deepEqual(catalog.current, { model: "opus", effort: "high" });
  const missing = await claudeModelCatalog(join(root, "none"), null, root);
  assert.deepEqual(missing, { models: [], efforts: [], current: { model: null, effort: null } });
});
