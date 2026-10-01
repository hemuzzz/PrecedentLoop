import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { CandidateService, prepareItemSchema, requestIdSchema, candidateSelectionSchema, contentFieldsSchema } from "./candidate-service.js";
import { RepositoryOperationError } from "./coordination.js";
import { AssetConfirmationError } from "./confirmation.js";

export async function runCandidateCli(args: readonly string[] = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin, stdout: NodeJS.WritableStream = process.stdout, stderr: NodeJS.WritableStream = process.stderr): Promise<number> {
  try {
    if (args.length !== 1 || !["show", "prepare", "register", "accept", "defer", "reject", "rewrite", "operation"].includes(args[0]!)) throw new Error("Use candidate show|prepare|register|accept|defer|reject|rewrite|operation with JSON stdin");
    const configuration = (key: string): string => { const value = environment[key]; if (!value || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`); return value; };
    const service = new CandidateService({ repositoryPath: configuration("PRECEDENT_LOOP_ASSET_REPOSITORY_PATH"), databasePath: configuration("PRECEDENT_LOOP_DATABASE_PATH"), workspaceConfigPath: configuration("PRECEDENT_LOOP_WORKSPACES_PATH") });
    await service.initialize();
    let source = "";
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stdin) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); size += bytes.length; if (size > 10 * 1024 * 1024) throw new Error("Input exceeds 10 MiB"); chunks.push(bytes); }
    source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const input: unknown = JSON.parse(source || "{}");
    let result: unknown;
    switch (args[0]) {
      case "show": {
        const query = z.object({ bucket: z.enum(["PENDING", "DEFERRED"]).optional() }).strict().parse(input);
        result = await service.list(query.bucket); break;
      }
      case "prepare": {
        const query = z.object({ requestId: requestIdSchema, candidates: z.array(prepareItemSchema).max(32) }).strict().parse(input);
        result = await service.prepare(query.requestId, query.candidates); break;
      }
      case "register": result = await service.register(input); break;
      case "accept": result = await service.accept(input); break;
      case "defer": result = await service.defer(input); break;
      case "reject": result = await service.reject(input); break;
      case "rewrite": {
        const { content, ...selection } = candidateSelectionSchema.extend({ content: contentFieldsSchema }).strict().parse(input);
        result = await service.rewrite(selection, content); break;
      }
      case "operation": {
        const query = z.object({ requestId: requestIdSchema }).strict().parse(input);
        result = await service.operation(query.requestId) ?? null; break;
      }
    }
    stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof RepositoryOperationError || error instanceof AssetConfirmationError;
    stderr.write(`${JSON.stringify({ ok: false, error: { code: known ? error.code : "CANDIDATE_INPUT_INVALID", message: known ? error.message : "候选命令输入或配置无效" } })}\n`);
    return 1;
  }
}
const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) process.exitCode = await runCandidateCli();
