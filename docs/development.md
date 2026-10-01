# Development

## Prerequisites

- macOS (Apple Silicon is the verified platform)
- Node.js `24.21.0` and pnpm `11.1.3` — the versions are pinned in `package.json`

If you don't want to switch your global versions, prefix commands with `npx -y -p node@24.21.0 -p pnpm@11.1.3`.

`better-sqlite3` 13 uses N-API prebuilds, so the same native module works in development and inside the Electron app; no rebuild against Electron headers is needed.

```bash
pnpm install --frozen-lockfile
```

## Repository layout

| Path | Contents |
|---|---|
| `apps/server` | Knowledge runtime: scanning and indexing, recall, candidates, HTTP/REST, MCP server, hooks, maintenance CLIs |
| `apps/hub` | Vue UI: knowledge browser, candidate review, setup wizard and settings |
| `apps/desktop` | Electron shell: setup and recovery, agent integration, data folder management, packaging and updates |
| `packages/id-generator` | Shared ID generation and validation |

## Dev mode

The server needs a knowledge repository, a database path and a workspaces file, all as absolute paths. The repository folder and the workspaces file must exist. Use a scratch folder, not your real data:

```bash
mkdir -p /absolute/scratch/{repository/assets,repository/inbox,runtime,config,logs}
echo '{"schemaVersion":1,"workspaces":[]}' > /absolute/scratch/config/workspaces.json

export PRECEDENT_LOOP_ASSET_REPOSITORY_PATH='/absolute/scratch/repository'
export PRECEDENT_LOOP_DATABASE_PATH='/absolute/scratch/runtime/precedent-loop.sqlite'
export PRECEDENT_LOOP_WORKSPACES_PATH='/absolute/scratch/config/workspaces.json'
export PRECEDENT_LOOP_LOG_PATH='/absolute/scratch/logs/server.log'
export PORT='3000'

# Initialize baseline version 1 once in an empty database; existing databases are refused.
# The maintenance CLI runs from the build output.
pnpm --filter @precedent-loop/server build
pnpm --filter @precedent-loop/server init-database --offline

pnpm --filter @precedent-loop/server dev
```

In a second terminal, start the Hub. Vite proxies `/api` to the server port:

```bash
PRECEDENT_LOOP_SERVER_PORT='3000' pnpm --filter @precedent-loop/hub dev
```

The setup wizard can be previewed without the desktop app at `/setup.html?scenario=<id>` on the Vite dev server (for example `S1-a`). Scenarios use in-memory mocks and are only enabled in Vite dev mode.

A production build serves everything from one process:

```bash
pnpm build
pnpm --filter @precedent-loop/server start
```

| URL | |
|---|---|
| `http://127.0.0.1:3000/` | Hub |
| `http://127.0.0.1:3000/health` | Health check |
| `http://127.0.0.1:3000/mcp` | MCP endpoint |
| `http://127.0.0.1:3000/api/...` | REST API used by the Hub |

Stop with `Ctrl-C`. The server finishes in-flight work, stops any AI process it started and closes the database before exiting.

## Tests and checks

```bash
pnpm build        # once after a fresh install: other packages type-check against the built id-generator
pnpm typecheck
pnpm test
```

`pnpm test` runs the automated tests of `apps/server`, `apps/desktop` and `packages/id-generator`. The Hub (`apps/hub`) has no automated tests; UI changes are checked by hand in the browser and the desktop app.

Smoke tests that exercise built artifacts live in each package's `package.json` (`smoke:*` scripts) and expect `pnpm build` first. Tests use temporary folders and never touch your real data or `~/Library/Application Support`.

## Building the app

```bash
cp apps/desktop/build-config.example.json .desktop-local.json   # an empty {} is enough
pnpm build
pnpm --filter @precedent-loop/desktop package:mac
```

The app is written to `dist/desktop/<build id>/PrecedentLoop.app`. To check a built app against a temporary database and port:

```bash
pnpm --filter @precedent-loop/desktop smoke:package '/absolute/path/to/PrecedentLoop.app'
```

The bundled runtime is Electron's own Node (`ELECTRON_RUN_AS_NODE`), so the Electron version and the pinned Node version must stay in step. Packaging checks this and stops on a mismatch.

## Code conventions

- TypeScript in `strict` mode, ES modules, `.js` extensions in relative imports, explicit `import type`. Don't loosen compiler settings or use `any` to get around errors.
- Validate input with the existing Zod schemas.
- Generate and validate IDs only through `@precedent-loop/id-generator` (`ast`, `tsk`, `usg` prefixes followed by digits).
- Keep SQL and persistence in repositories/catalogs and use-case logic in services. HTTP, MCP and hook entry points validate input, call the shared service and map errors — they don't duplicate business rules.
- Errors use the module's error type and `code`; each entry point maps them. Never return internal stack traces to clients.
- The Hub talks to the server only through `apps/hub/src/api/client.ts` with the types in `api/types.ts`.

## Pull requests

- Keep changes focused: no unrelated refactors, formatting sweeps or dependency upgrades.
- Add or update tests for server, desktop and shared-package behaviour changes, and make sure `pnpm typecheck` and `pnpm test` pass. For Hub changes, describe what you checked by hand.
- Changes that affect storage, MCP tool contracts or installed integrations need a note on compatibility and migration.
- For larger changes, open an issue first to agree on the approach.
