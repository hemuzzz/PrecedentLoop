import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { createRestApiApp, type RestApiDependencies } from "./http/index.js";

export interface HubStaticOptions {
  root: string;
}

export function createApp(restApi?: RestApiDependencies, hubStatic?: HubStaticOptions): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));
  if (restApi !== undefined) {
    app.route("/", createRestApiApp(restApi));
  }
  if (hubStatic !== undefined) {
    app.get("/", serveStatic({
      root: hubStatic.root,
      path: "index.html",
    }));
    app.get("/assets/*", serveStatic({
      root: hubStatic.root,
    }));
  }
  app.notFound((context) => context.json({
    ok: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Route does not exist",
      retryable: false,
    },
  }, 404));
  return app;
}

export const app = createApp();
