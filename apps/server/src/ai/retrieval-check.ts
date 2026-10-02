import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CandidateOptions } from "../asset/candidate-service.js";
import { AssetSearchService } from "../asset/search.js";
import { ReferenceChecker } from "../asset/reference-check.js";
import { RetrievalCheckRepository, type CheckTarget, type RetrievalCheckResult } from "../asset/retrieval-check-repository.js";
import { RepositoryOperationError } from "../asset/errors.js";
import { recallInputSchema } from "../knowledge/model.js";
import { recallRanking } from "../knowledge/ranking.js";
import { KNOWLEDGE_RECALL_DESCRIPTION } from "../knowledge/recall-rules.js";
import { openDatabase } from "../storage/schema.js";
import { loadWorkspaceConfig } from "../workspace/config.js";
import type { AiProvider, CliRunner } from "./cli.js";

export const questionsOutputSchema = z.object({ items: z.array(z.object({ targetRef: z.string(),
  questions: z.array(z.string().trim().min(1).max(2000)).length(3) }).strict()).min(1).max(10) }).strict();
export const queriesOutputSchema = z.object({ items: z.array(z.object({ questionRef: z.string(),
  queries: recallInputSchema.shape.queries }).strict()).min(1).max(30) }).strict();

export async function executeRetrievalCheck(options: CandidateOptions, target: CheckTarget | undefined,
  provider: AiProvider, runner: CliRunner, resources: string, signal: AbortSignal, result: RetrievalCheckResult): Promise<void> {
  const config = await loadWorkspaceConfig(options.workspaceConfigPath);
  const database = openDatabase(options.databasePath), search = new AssetSearchService(options);
  try {
    const repository = new RetrievalCheckRepository(database);
    const targets = database.transaction(() => repository.targets(config.workspaces.map(row => row.name), target))();
    result.total = targets.length;
    const referenceChecker = new ReferenceChecker(config);
    const rules = await readFile(join(resources, "retrieval-check.md"), "utf8");
    const call = async (payload: object, schema: z.ZodType): Promise<unknown> => {
      checkInterrupted(signal);
      const directory = await mkdtemp(join(tmpdir(), "precedent-loop-check-"));
      try {
        await writeFile(join(directory, "input.json"), JSON.stringify(payload), { mode: 0o600, flag: "wx" });
        return await runner({ provider, directory, signal, schema: z.toJSONSchema(schema),
          prompt: `${rules}\n\n${JSON.stringify(payload)}` });
      } finally { await rm(directory, { recursive: true, force: true }); }
    };
    for (let offset = 0; offset < targets.length; offset += 10) {
      checkInterrupted(signal);
      const batch = targets.slice(offset, offset + 10);
      const questions = questionsOutputSchema.parse(await call({ step: "questions", items: batch.map(({ content }, index) => ({
        targetRef: String(index), title: content.title, summary: content.summary,
        bodyMarkdown: [...content.bodyMarkdown].slice(0, 4000).join(""), retrievalTerms: content.retrievalTerms,
      })) }, questionsOutputSchema));
      validateRefs(questions.items.map(item => item.targetRef), batch.map((_, index) => String(index)));
      // Only requests and workspace metadata cross this boundary. No knowledge content or IDs.
      const requests = batch.flatMap(({ content }, index) => questions.items.find(item => item.targetRef === String(index))!.questions.map((question, questionIndex) => ({
        questionRef: `${index}:${questionIndex}`, question, workspace: content.workspace,
        description: config.workspaces.find(row => row.name === content.workspace)?.description ?? "",
      })));
      const queries = queriesOutputSchema.parse(await call({ step: "queries", rules: KNOWLEDGE_RECALL_DESCRIPTION, items: requests }, queriesOutputSchema));
      validateRefs(queries.items.map(item => item.questionRef), requests.map(item => item.questionRef));
      checkInterrupted(signal);
      const broken = await Promise.all(batch.map(row => row.kind === "ASSET" ? referenceChecker.broken(row.content) : Promise.resolve([])));
      checkInterrupted(signal);
      const outcomes = search.readTransaction(() => batch.map((row, index) => ({ target: row, brokenPaths: broken[index]!,
        result: requests.filter(request => request.questionRef.startsWith(`${index}:`)).map(request => {
          const expressions = queries.items.find(item => item.questionRef === request.questionRef)!.queries;
          const context = { authorizedWorkspaces: row.content.scope === "WORKSPACE" ? [row.content.workspace!] : [] };
          const ranks = recallRanking(search, context, expressions, row.kind === "CANDIDATE" ? row.content : undefined);
          const position = ranks.findIndex(rank => rank.assetId === row.content.assetId);
          return { question: request.question, queries: expressions, hit: position >= 0 && position < 8, rank: position < 0 ? null : position + 1 };
        }),
      })));
      const currentConfig = await loadWorkspaceConfig(options.workspaceConfigPath);
      if (JSON.stringify(currentConfig) !== JSON.stringify(config)) throw new RepositoryOperationError("VERSION_CONFLICT", "工作区配置已变化，本批未提交，请重新执行");
      checkInterrupted(signal);
      result.items.push(...repository.commit(outcomes));
      result.done += batch.length;
    }
  } finally { search.close(); database.close(); }
}
function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new RepositoryOperationError("AI_INTERRUPTED", "召回自测已中断");
}
function validateRefs(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || new Set(actual).size !== expected.length || actual.some(ref => !expected.includes(ref)))
    throw new RepositoryOperationError("AI_OUTPUT_INVALID", "AI 返回了缺少、未提供或重复的引用，本批未提交");
}
