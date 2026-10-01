import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const serverPort = process.env.PRECEDENT_LOOP_SERVER_PORT ?? "3000";
if (!/^[1-9][0-9]*$/u.test(serverPort) || Number(serverPort) > 65_535) {
  throw new Error("PRECEDENT_LOOP_SERVER_PORT must be an integer from 1 to 65535");
}
const apiTarget = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  base: "./",
  plugins: [vue(), {
    name: "desktop-development-csp",
    apply: "serve",
    transformIndexHtml(html, context) {
      if (!["/", "/index.html", "/setup.html"].includes(context.path)) return html;
      // Vite injects styles and uses a local HMR websocket only in browser development.
      // Packaged pages keep the strict CSP written in the source files.
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    },
  }],
  build: {
    rollupOptions: { input: {
      hub: fileURLToPath(new URL("./index.html", import.meta.url)),
      setup: fileURLToPath(new URL("./setup.html", import.meta.url)),
    } },
  },
  server: {
    proxy: {
      "/api": {
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            proxyRequest.setHeader("host", `127.0.0.1:${serverPort}`);
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader("origin", apiTarget);
            }
          });
        },
        target: apiTarget,
      },
    },
  },
});
