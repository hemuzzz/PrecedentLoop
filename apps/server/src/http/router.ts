import { Hono, type Context } from "hono";
import { z, type ZodType } from "zod";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CandidateService, requestIdSchema } from "../asset/candidate-service.js";
import { RepositoryOperationError, withRepositoryAccess } from "../asset/coordination.js";
import { AssetConfirmationError } from "../asset/confirmation.js";
import { AiService } from "../ai/service.js";

import {
  AssetLibraryInputError,
  AssetNotFoundError,
  AssetSearchInputError,
  AssetSearchUnavailableError,
  AssetStaleError,
  InboxApplicationService,
  InboxUnavailableError,
  type AssetIndexStatus,
} from "../asset/index.js";
import type { KnowledgeProjection } from "../knowledge/projection.js";
import { KnowledgeError } from "../knowledge/model.js";
import {
  assetListQuerySchema,
  assetPathSchema,
  factListQuerySchema,
  type RestErrorDetail,
  type RestErrorResponse,
  type RestSuccessResponse,
} from "./contracts/index.js";
import type { OverviewApplicationService } from "./overview.js";
import { DatabaseSchemaError } from "../storage/schema.js";
import { RestError, invalidRequest } from "./errors.js";
import {
  HubAssetApplicationService,
  SystemStatusApplicationService,
} from "./service.js";

export interface RestApiDependencies {
  allowedAuthority: string;
  overviewService: Pick<OverviewApplicationService, "get">;
  assetService: HubAssetApplicationService;
  inboxService: Pick<InboxApplicationService, "scan">;
  indexStatus: () => AssetIndexStatus;
  projection: KnowledgeProjection;
  onInternalError?: (error: unknown) => void;
  systemStatusService: Pick<SystemStatusApplicationService, "get">;
  candidateService?: CandidateService;
  aiService?: AiService;
  refreshIndex?: () => Promise<void>;
}

export function createRestApiApp(dependencies: RestApiDependencies): Hono {
  const app = new Hono();
  const writeToken = randomBytes(32).toString("hex");
  const writeRoutes = new Set(["/api/inbox/accept", "/api/inbox/defer", "/api/inbox/reject", "/api/inbox/register", "/api/inbox/import", "/api/inbox/rewrite", "/api/inbox/workspaces", "/api/inbox/test"]);

  app.use("/api/*", async (context, next) => {
    if (!requestIsAllowed(context, dependencies.allowedAuthority)) {
      return failure(context, 403, {
        code: "FORBIDDEN_HOST_ORIGIN",
        message: "Host or Origin is not allowed",
        retryable: false,
      });
    }
    if (context.req.method !== "GET" && !(context.req.method === "POST" && dependencies.candidateService && writeRoutes.has(context.req.path))) {
      context.header("Allow", "GET");
      return failure(context, 405, {
        code: "METHOD_NOT_ALLOWED",
        message: "This Hub API route only allows GET",
        retryable: false,
      });
    }
    if (context.req.method === "POST") {
      const supplied = context.req.header("x-hub-write-token") ?? "";
      if (context.req.header("origin") !== `http://${dependencies.allowedAuthority}` || !/^[a-f0-9]{64}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(writeToken))) {
        return failure(context, 403, { code: "WRITE_SESSION_INVALID", message: "写入会话无效，请刷新页面后重试", retryable: false });
      }
      if (context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw invalidRequest("CONTENT_TYPE_INVALID", "写请求只接受 application/json");
    }
    context.header("Cache-Control", "no-store");
    if (context.req.method === "GET" && dependencies.candidateService) await withRepositoryAccess(dependencies.candidateService.options.repositoryPath, next);
    else await next();
  });

  app.get("/api/inbox/session", context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.candidateService) throw unavailable();
    if (context.req.header("sec-fetch-site") === "cross-site") return failure(context, 403, { code: "WRITE_SESSION_INVALID", message: "仅限同源 Hub 会话", retryable: false });
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header("X-Content-Type-Options", "nosniff");
    return success(context, { token: writeToken });
  });
  app.get("/api/inbox/providers", async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.aiService) throw unavailable();
    return success(context, { providers: await dependencies.aiService.providers() });
  });
  app.get("/api/inbox/ai-settings", async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.aiService) throw unavailable();
    return success(context, await dependencies.aiService.settings());
  });
  app.post("/api/inbox/test", async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.aiService) throw unavailable();
    return success(context, await dependencies.aiService.test(await readJson(context)));
  });
  app.get("/api/inbox/operation", async context => {
    const query = parseStrictQuery(context, ["requestId"], z.object({ requestId: requestIdSchema.optional() }).strict());
    if (!dependencies.aiService) throw unavailable();
    return success(context, { operation: await dependencies.aiService.status(query.requestId) });
  });
  app.post("/api/inbox/workspaces", async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    z.object({}).strict().parse(await readJson(context));
    if (!dependencies.aiService) throw unavailable();
    return success(context, { workspaces: await dependencies.aiService.importWorkspaces() });
  });
  for (const action of ["accept", "defer", "reject", "register"] as const) app.post(`/api/inbox/${action}`, async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.candidateService) throw unavailable();
    const result = await dependencies.candidateService[action](await readJson(context));
    if (action === "accept") {
      // The commit is already durable. Publish its derived index immediately
      // for the next Hub/MCP read; index repair cannot undo that commit.
      try { await dependencies.refreshIndex?.(); } catch (error) { dependencies.onInternalError?.(error); }
    }
    return success(context, result);
  });
  for (const action of ["import", "rewrite"] as const) app.post(`/api/inbox/${action}`, async context => {
    parseStrictQuery(context, [], z.object({}).strict());
    if (!dependencies.aiService) throw unavailable();
    return success(context, { operation: await dependencies.aiService[action](await readJson(context, action === "import" ? null : undefined)) });
  });

  app.get("/api/overview", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    return success(context, await dependencies.overviewService.get());
  });

  app.get("/api/assets", async (context) => {
    assertIndexReady(dependencies.indexStatus());
    const query = parseStrictQuery(
      context,
      ["query", "workspace", "type", "scope", "limit", "offset"],
      assetListQuerySchema,
    );
    const result = await dependencies.assetService.list({
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
      ...(Object.prototype.hasOwnProperty.call(query, "workspace")
        ? { workspace: query.workspace ?? null }
        : {}),
    });
    return success(context, result);
  });

  app.get("/api/assets/:assetId", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    assertIndexReady(dependencies.indexStatus());
    const path = parsePath(assetPathSchema, { assetId: context.req.param("assetId") }, "ASSET_ID_INVALID");
    return success(context, { asset: await dependencies.assetService.get(path.assetId) });
  });

  app.get("/api/assets/:assetId/diff", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    assertIndexReady(dependencies.indexStatus());
    const path = parsePath(assetPathSchema, { assetId: context.req.param("assetId") }, "ASSET_ID_INVALID");
    return success(context, { diff: await dependencies.assetService.diff(path.assetId) });
  });

  app.get("/api/inbox", async (context) => {
    if (dependencies.candidateService) {
      const query = parseStrictQuery(context, ["bucket"], z.object({ bucket: z.enum(["PENDING", "DEFERRED"]).optional() }).strict());
      return success(context, await dependencies.candidateService.list(query.bucket));
    }
    parseStrictQuery(context, [], z.object({}).strict());
    return success(context, await dependencies.inboxService.scan());
  });

  app.get("/api/workspaces", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    return success(context, await dependencies.projection.workspaces());
  });
  app.get("/api/recalls", (context) => {
    const query = parseStrictQuery(context, ["offset", "limit"], factListQuerySchema);
    return success(context, dependencies.projection.recalls(query.offset, query.limit));
  });
  app.get("/api/recalls/:recallId", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    const id = context.req.param("recallId");
    if (!/^usg[0-9]+$/u.test(id)) throw invalidRequest("INPUT_INVALID", "Invalid reference");
    const recall = await dependencies.projection.recall(id);
    if (!recall) throw new RestError(404, { code: "SOURCE_NOT_FOUND", message: "Recall not found", retryable: false });
    return success(context, recall);
  });
  app.get("/api/usage", async (context) => {
    const query = parseStrictQuery(context, ["offset", "limit", "assetId"], factListQuerySchema);
    return success(context, await dependencies.projection.usage(query.offset, query.limit, query.assetId));
  });

  app.get("/api/system/status", async (context) => {
    parseStrictQuery(context, [], z.object({}).strict());
    return success(context, await dependencies.systemStatusService.get());
  });

  app.notFound((context) => failure(context, 404, {
    code: "ROUTE_NOT_FOUND",
    message: "Route does not exist",
    retryable: false,
  }));

  app.onError((error, context) => {
    const mapped = mapRestError(error, dependencies.onInternalError);
    return failure(context, mapped.status, mapped.detail);
  });
  return app;
}

function parseStrictQuery<T>(
  context: Context,
  allowedNames: readonly string[],
  schema: ZodType<T>,
): T {
  const allowed = new Set(allowedNames);
  const values: Record<string, string> = {};
  const url = new URL(context.req.url);
  for (const [name, value] of url.searchParams) {
    if (!allowed.has(name)) {
      throw invalidRequest("QUERY_PARAMETER_UNKNOWN", `Unknown query parameter: ${name}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw invalidRequest("QUERY_PARAMETER_REPEATED", `Query parameter must not be repeated: ${name}`);
    }
    if (value.length === 0) {
      throw invalidRequest("QUERY_PARAMETER_EMPTY", `Query parameter must not be empty: ${name}`);
    }
    values[name] = value;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const invalidCombination = parsed.error.issues.some(
      (issue) => issue.code === "custom" && issue.message.includes("cannot be combined"),
    );
    throw invalidRequest(
      invalidCombination ? "INVALID_FILTER_COMBINATION" : "QUERY_PARAMETER_INVALID",
      invalidCombination ? parsed.error.issues[0]?.message ?? "Invalid filter combination" : "Query parameters are invalid",
    );
  }
  return parsed.data;
}

function parsePath<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidRequest(code, parsed.error.issues[0]?.message ?? "Path parameter is invalid");
  }
  return parsed.data;
}

function assertIndexReady(status: AssetIndexStatus): void {
  if (status.indexState === "READY") {
    return;
  }
  if (status.diagnostics.some(({ code }) => code === "INVALID_WORKSPACE_CONFIG")) {
    throw new RestError(503, {
      code: "WORKSPACE_CONFIG_UNAVAILABLE",
      message: "Workspace configuration is unavailable or invalid",
      retryable: true,
    });
  }
  throw new RestError(503, {
    code: "ASSET_INDEX_UNAVAILABLE",
    message: "Asset Catalog/FTS is not ready for queries",
    retryable: true,
  });
}

function requestIsAllowed(context: Context, allowedAuthority: string): boolean {
  if (context.req.header("host") !== allowedAuthority) {
    return false;
  }
  const origin = context.req.header("origin");
  return origin === undefined || origin === `http://${allowedAuthority}`;
}

function mapRestError(error: unknown, onInternalError: ((error: unknown) => void) | undefined): RestError {
  if (error instanceof RestError) {
    return error;
  }
  if (error instanceof z.ZodError) return invalidRequest("INPUT_INVALID", "请求字段不符合操作要求");
  if (error instanceof RepositoryOperationError || error instanceof AssetConfirmationError) {
    const status = /MIGRATION|RECOVERY|UNAVAILABLE|CONFIGURATION|UNSUPPORTED|SHUTTING_DOWN/u.test(error.code) ? 503
      : /NOT_FOUND/u.test(error.code) ? 404 : /INVALID|REQUIRED/u.test(error.code) ? 400 : 409;
    return new RestError(status, { code: error.code, message: error.message, retryable: false });
  }
  if (error instanceof AssetLibraryInputError) {
    return new RestError(400, { code: "WORKSPACE_INVALID", message: error.message, retryable: false });
  }
  if (error instanceof AssetSearchInputError) {
    return new RestError(400, { code: "SEARCH_INPUT_INVALID", message: error.message, retryable: false });
  }
  if (error instanceof AssetNotFoundError) {
    return new RestError(404, { code: "ASSET_NOT_FOUND", message: "Asset does not exist", retryable: false });
  }
  if (error instanceof AssetStaleError) {
    return new RestError(409, {
      code: "ASSET_STALE",
      message: "Asset no longer matches its Catalog projection; retry after refresh",
      retryable: true,
    });
  }
  if (error instanceof AssetSearchUnavailableError) {
    return new RestError(503, error.reason === "WORKSPACE_CONFIGURATION"
      ? {
          code: "WORKSPACE_CONFIG_UNAVAILABLE",
          message: "Workspace configuration is unavailable or invalid",
          retryable: true,
        }
      : {
          code: "ASSET_INDEX_UNAVAILABLE",
          message: "Current Asset qualification could not be confirmed",
          retryable: true,
        });
  }
  if (error instanceof InboxUnavailableError) {
    return new RestError(503, {
      code: error.reason === "WORKSPACE_CONFIGURATION" ? "WORKSPACE_CONFIG_UNAVAILABLE" : "INBOX_SCAN_UNAVAILABLE",
      message: error.reason === "WORKSPACE_CONFIGURATION"
        ? "Workspace configuration is unavailable or invalid"
        : "Inbox could not be scanned completely",
      retryable: true,
    });
  }
  if (error instanceof DatabaseSchemaError) return new RestError(503, { code: error.code, message: error.message, retryable: false });
  if (error instanceof KnowledgeError) return new RestError(503, { code: error.code, message: error.code, retryable: true });
  onInternalError?.(error);
  return new RestError(500, {
    code: "INTERNAL_ERROR",
    message: "The local service could not complete the request",
    retryable: false,
  });
}

function unavailable(): RestError { return new RestError(503, { code: "CANDIDATE_UNAVAILABLE", message: "候选管理尚未就绪", retryable: false }); }
async function readJson(context: Context, maxBytes: number | null = 7_000_000): Promise<unknown> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw invalidRequest("INPUT_INVALID", "请求正文不能为空");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (maxBytes !== null && size > maxBytes) { await reader.cancel(); throw invalidRequest("INPUT_TOO_LARGE", "请求正文超出限额"); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { if (error instanceof RestError) throw error; throw invalidRequest("INPUT_INVALID", "请求正文必须是完整 UTF-8 JSON"); }
  finally { reader.releaseLock(); }
}

function success<T>(context: Context, data: T): Response {
  const body: RestSuccessResponse<T> = { ok: true, data };
  return context.json(body, 200);
}

function failure(
  context: Context,
  status: 400 | 403 | 404 | 405 | 409 | 500 | 503,
  error: RestErrorDetail,
): Response {
  const body: RestErrorResponse = { ok: false, error };
  return context.json(body, status);
}
