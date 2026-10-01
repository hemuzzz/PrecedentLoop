import { createServer, type Server } from "node:http";
import { isAbsolute, win32, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener } from "@hono/node-server";
import { SnowflakeIdGenerator } from "@precedent-loop/id-generator";

import { AssetContentVersionRepository } from "./asset/content-version.js";
import { CandidateService } from "./asset/candidate-service.js";
import { AiService } from "./ai/service.js";
import { AssetDiffService } from "./asset/content-diff.js";
import { createApp } from "./app.js";
import {
  AssetIndexManager,
  AssetSearchService,
} from "./asset/index.js";
import {
  HOOK_DATABASE_PATH_ENV,
  HOOK_WORKSPACE_CONFIG_PATH_ENV,
} from "./hook/user-prompt-submit.js";
import { KnowledgeRepository } from "./knowledge/repository.js";
import { KnowledgeService } from "./knowledge/service.js";
import { KnowledgeProjection } from "./knowledge/projection.js";
import { KnowledgeError } from "./knowledge/model.js";
import { WorkspaceCapabilityService } from "./workspace/capability.js";
import { JsonFileLogger, logPathFromEnvironment } from "./logging.js";
import {
  OverviewApplicationService,
  HubAssetApplicationService,
  SystemStatusApplicationService,
} from "./http/index.js";
import { createMcpHttpRequestHandler } from "./mcp/index.js";
import { integrationActivityDirectory } from "./integration-activity.js";

export const SERVER_ASSET_REPOSITORY_PATH_ENV = "PRECEDENT_LOOP_ASSET_REPOSITORY_PATH";
export const SERVER_PORT_ENV = "PORT";
const HOST = "127.0.0.1";
const HUB_DIST_PATH = fileURLToPath(new URL("../../hub/dist/", import.meta.url));

export interface ServerRuntimeConfiguration {
  buildId?: string;
  assetRepositoryPath: string;
  databasePath: string;
  logPath: string;
  port: number;
  workspaceConfigPath: string;
}

export interface RunningPrecedentLoopServer {
  close: () => Promise<void>;
  endpoint: string;
  server: Server;
}

export class ServerConfigurationError extends Error {
  readonly code = "SERVER_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

export function serverConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerRuntimeConfiguration {
  const assetRepositoryPath = environment[SERVER_ASSET_REPOSITORY_PATH_ENV];
  const databasePath = environment[HOOK_DATABASE_PATH_ENV];
  const workspaceConfigPath = environment[HOOK_WORKSPACE_CONFIG_PATH_ENV];
  if (
    assetRepositoryPath === undefined ||
    databasePath === undefined ||
    workspaceConfigPath === undefined
  ) {
    throw new ServerConfigurationError(
      `${SERVER_ASSET_REPOSITORY_PATH_ENV}, ${HOOK_DATABASE_PATH_ENV}, and ${HOOK_WORKSPACE_CONFIG_PATH_ENV} must be configured`,
    );
  }
  assertAbsolutePath(assetRepositoryPath, "Asset Repository path");
  assertAbsolutePath(databasePath, "database path");
  assertAbsolutePath(workspaceConfigPath, "Workspace configuration path");

  const rawPort = environment[SERVER_PORT_ENV] ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ServerConfigurationError(`${SERVER_PORT_ENV} must be an integer from 1 to 65535`);
  }
  let logPath: string;
  try {
    logPath = logPathFromEnvironment(environment);
  } catch (error) {
    throw new ServerConfigurationError(error instanceof Error ? error.message : "Log path is invalid");
  }
  return {
    assetRepositoryPath,
    databasePath,
    logPath,
    port,
    workspaceConfigPath,
  };
}

export async function startPrecedentLoopServer(
  configuration: ServerRuntimeConfiguration,
  options: { onCandidateWritten?: () => void } = {},
): Promise<RunningPrecedentLoopServer> {
  const indexManager = await AssetIndexManager.create({
    databasePath: configuration.databasePath,
    repositoryPath: configuration.assetRepositoryPath,
    workspaceConfigPath: configuration.workspaceConfigPath,
  });
  let contentVersions: AssetContentVersionRepository | undefined;
  let knowledgeRepository: KnowledgeRepository | undefined;
  const candidateService = new CandidateService({ repositoryPath: configuration.assetRepositoryPath, databasePath: configuration.databasePath, workspaceConfigPath: configuration.workspaceConfigPath });
  const aiService = new AiService(candidateService, { ...(process.env.PRECEDENT_LOOP_APP_CONFIG_PATH ? { appConfigPath: process.env.PRECEDENT_LOOP_APP_CONFIG_PATH } : {}) });
  let assetSearchService: AssetSearchService | undefined;
  let server: Server | undefined;
  let closing = false;
  const requests = new Set<Promise<void>>();

  try {
    await candidateService.initialize();
    await indexManager.start();
    contentVersions = new AssetContentVersionRepository(configuration.databasePath);
    knowledgeRepository = new KnowledgeRepository(configuration.databasePath);
    const capabilities = new WorkspaceCapabilityService(knowledgeRepository, configuration.workspaceConfigPath);
    const projection = new KnowledgeProjection(knowledgeRepository, capabilities, {
      repositoryPath: configuration.assetRepositoryPath, workspaceConfigPath: configuration.workspaceConfigPath,
    });
    assetSearchService = new AssetSearchService({
      databasePath: configuration.databasePath,
      repositoryPath: configuration.assetRepositoryPath,
      workspaceConfigPath: configuration.workspaceConfigPath,
      refreshIndex: async () => await indexManager.synchronize(),
    });
    const knowledgeService = new KnowledgeService(knowledgeRepository, capabilities, assetSearchService, () => {
      if (indexManager.status().indexState !== "READY") throw new KnowledgeError("ASSET_INDEX_UNAVAILABLE");
    }, new JsonFileLogger(configuration.logPath));
    const mcpRequest = createMcpHttpRequestHandler({ knowledgeService, candidateService, capabilities, onInternalError: logInternalError,
      ...options,
      integrationActivityPath: integrationActivityDirectory(configuration.databasePath) });
    const inboxService = { scan: () => candidateService.list() };
    const assetService = new HubAssetApplicationService(
      assetSearchService,
      projection,
      knowledgeRepository,
      new AssetDiffService(assetSearchService, contentVersions),
    );
    const systemStatusService = new SystemStatusApplicationService({
      ...(configuration.buildId === undefined ? {} : { buildId: configuration.buildId }),
      repositoryPath: configuration.assetRepositoryPath,
      workspaceConfigPath: configuration.workspaceConfigPath,
      indexStatus: () => indexManager.status(),
      inboxService,
      mcpEndpointReady: () => server?.listening === true,
    });
    const httpApp = createApp(
      {
        allowedAuthority: `${HOST}:${configuration.port}`,
        assetService,
        inboxService,
        candidateService,
        aiService,
        refreshIndex: async () => { await indexManager.synchronize(); },
        indexStatus: () => indexManager.status(),
        projection,
        onInternalError: logInternalError,
        systemStatusService,
        overviewService: new OverviewApplicationService({ ...systemStatusService.dependencies, projection }),
      },
      { root: HUB_DIST_PATH },
    );
    const honoRequest = getRequestListener(httpApp.fetch, { hostname: HOST });
    server = createServer((request, response) => {
      if (closing) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "server_stopping" })); return; }
      const operation = request.url === "/mcp"
        ? mcpRequest(request, response)
        : honoRequest(request, response);
      const tracked = operation.catch((error: unknown) => {
        logInternalError(error);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "request_failed" }));
        } else if (!response.writableEnded) {
          response.end();
        }
      }).finally(() => { requests.delete(tracked); });
      requests.add(tracked);
    });
    await listen(server, configuration.port);
    const runningServer = server;

    let closed = false;
    return {
      server: runningServer,
      endpoint: `http://${HOST}:${configuration.port}/mcp`,
      close: async () => {
        if (closed) {
          return;
        }
        closing = true;
        await aiService.close();
        await closeServer(runningServer);
        await Promise.all(requests);
        contentVersions?.close();
        assetSearchService?.close();
        knowledgeRepository?.close();
        await indexManager.close();
        closed = true;
      },
    };
  } catch (error) {
    closing = true;
    await aiService.close().catch(logInternalError);
    if (server !== undefined) {
      await closeServer(server);
    }
    await Promise.all(requests);
    contentVersions?.close();
    assetSearchService?.close();
    knowledgeRepository?.close();
    await indexManager.close();
    throw error;
  }
}

function assertAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new ServerConfigurationError(`${label} must be absolute`);
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    server.closeAllConnections();
  });
}

function logInternalError(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`${JSON.stringify({ event: "internal_error", name })}\n`);
}
