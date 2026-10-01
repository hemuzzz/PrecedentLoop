import { initializeDatabase } from "../src/storage/schema.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateService, type CandidateSummary, type PrepareItem } from "../src/asset/candidate-service.js";

export const content = (bodyMarkdown = "原文"): PrepareItem => ({ title: "候选知识", summary: "可核实的摘要", bodyMarkdown, type: "MEMORY", target: { scope: "GLOBAL" } });
export const selection = (item: CandidateSummary, requestId: string) => ({ requestId, candidateId: item.candidateId, assetId: item.assetId, candidateHash: item.contentHash });
export async function candidateFixture() {
  const root = await mkdtemp(join(tmpdir(), "candidate-test-"));
  const options = { repositoryPath: join(root, "repository"), databasePath: join(root, "data.sqlite"), workspaceConfigPath: join(root, "workspaces.json") };
  await mkdir(join(options.repositoryPath, "assets"), { recursive: true });
  await writeFile(options.workspaceConfigPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ name: "alpha", paths: [root] }] }));
  initializeDatabase(options.databasePath);

  const service = new CandidateService(options);
  await service.initialize();
  const configPath = join(root, "ai-providers.json");
  await writeFile(configPath, JSON.stringify({ providers: [{ id: "codex", executable: process.execPath, timeoutMs: 1000 }] }));
  return { root, options, service, configPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}
