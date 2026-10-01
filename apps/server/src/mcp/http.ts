import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { AssetMcpDependencies } from "./tools.js";
import { createAssetMcpServer } from "./tools.js";
import { recordMcpActivity } from "../integration-activity.js";

const HOST = "127.0.0.1";

export type McpHttpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

export function createMcpHttpRequestHandler(
  dependencies: AssetMcpDependencies & { integrationActivityPath?: string },
): McpHttpRequestHandler {
  return async (request, response) => {
    if (request.url !== "/mcp") {
      respondJson(response, 404, { error: "not_found" });
      return;
    }
    if (!requestIsAllowed(request)) {
      respondJson(response, 403, { error: "forbidden_host_or_origin" });
      return;
    }

    const mcpServer = createAssetMcpServer(dependencies);
    const transport = new StreamableHTTPServerTransport();
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await transport.close();
      await mcpServer.close();
    };

    response.once("close", () => {
      void close();
    });

    try {
      // SDK 1.30.0's accessor declarations conflict with exactOptionalPropertyTypes,
      // although StreamableHTTPServerTransport implements the runtime Transport contract.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response);
      // The per-request SDK server only has clientInfo after a validated initialize.
      const client = mcpServer.server.getClientVersion();
      if (client && dependencies.integrationActivityPath) {
        await recordMcpActivity(dependencies.integrationActivityPath, client.name);
      }
    } catch (error) {
      dependencies.onInternalError?.(error);
      if (!response.headersSent) {
        respondJson(response, 500, { error: "mcp_request_failed" });
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      if (response.writableEnded) {
        await close();
      }
    }
  };
}

function requestIsAllowed(request: IncomingMessage): boolean {
  const localPort = request.socket.localPort;
  if (localPort === undefined || requestAuthority(request) !== `${HOST}:${localPort}`) {
    return false;
  }

  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${HOST}:${localPort}`;
}

function requestAuthority(request: IncomingMessage): string | undefined {
  const authority = request.headers[":authority"];
  return typeof authority === "string" ? authority : request.headers.host;
}

function respondJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
