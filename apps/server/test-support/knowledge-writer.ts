import { spawn } from "node:child_process";
import { moduleRoot } from "./knowledge-fixture.js";

// Independent processes, not Promise-only calls on a serialized service instance.
export function runKnowledgeWriter(options: { databasePath: string; repositoryPath: string; workspaceConfigPath: string }, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      Date.now = () => 1900000000000;
      const { KnowledgeRepository } = await import(${JSON.stringify(new URL("knowledge/repository.js", moduleRoot).href)});
      const { KnowledgeService } = await import(${JSON.stringify(new URL("knowledge/service.js", moduleRoot).href)});
      const { WorkspaceCapabilityService } = await import(${JSON.stringify(new URL("workspace/capability.js", moduleRoot).href)});
      const { AssetSearchService } = await import(${JSON.stringify(new URL("asset/index.js", moduleRoot).href)});
      const options = ${JSON.stringify(options)};
      const repository = new KnowledgeRepository(options.databasePath);
      const search = new AssetSearchService({ ...options, refreshIndex: async () => undefined });
      const service = new KnowledgeService(repository, new WorkspaceCapabilityService(repository, options.workspaceConfigPath), search, () => {});
      try { ${body} } finally { search.close(); repository.close(); }
    `], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Knowledge writer exited ${code}: ${stderr}`)));
  });
}
