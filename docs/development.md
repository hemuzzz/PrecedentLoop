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
| `apps/server` | Knowledge runtime: SQLite repositories and FTS, recall, candidates, HTTP/REST, MCP server, hooks, maintenance CLIs |
| `apps/hub` | Vue UI: knowledge browser, candidate review, setup wizard and settings |
| `apps/desktop` | Electron shell: setup and recovery, agent integration, data folder management, packaging and updates |
| `packages/id-generator` | Shared ID generation and validation |

## Dev mode

The server needs absolute paths for an initialized database and an existing workspaces file. Initialize a new database in a scratch folder:

```bash
mkdir -p /absolute/scratch/{runtime,config,logs}
echo '{"schemaVersion":1,"workspaces":[]}' > /absolute/scratch/config/workspaces.json

export PRECEDENT_LOOP_DATABASE_PATH='/absolute/scratch/runtime/precedent-loop.sqlite'
export PRECEDENT_LOOP_WORKSPACES_PATH='/absolute/scratch/config/workspaces.json'
export PRECEDENT_LOOP_LOG_PATH='/absolute/scratch/logs/server.log'
export PORT='3000'

# Explicitly initialize an empty database; existing schemas or data are refused.
# The maintenance CLI runs from the build output.
pnpm --filter @precedent-loop/id-generator build
pnpm --filter @precedent-loop/server build
pnpm --filter @precedent-loop/server init-database --offline

pnpm --filter @precedent-loop/server dev
```

All DDL lives in `apps/server/src/storage/schema.sql`. `schema.ts` reads that file, and the server build copies it to `dist/storage/schema.sql` alongside the compiled module. The database does not use `user_version`. When opening an existing database containing the `asset` table for writing, the server automatically adds missing tables, columns, indexes and full-text index structure, rebuilding the derived full-text index when needed. This preserves existing data and does not change existing columns or constraints. Read-only connections check required tables without adding structure. Empty databases still require explicit `init-database --offline`; startup and app updates do not initialize them. The initialization command creates the database only; desktop recognition also requires the marker created by Setup and a valid SQLite header with a positive schema cookie (the schema change counter), as described in [Configuration](configuration.md#data-folder).

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
pnpm --filter @precedent-loop/id-generator build
pnpm --filter @precedent-loop/id-generator test
pnpm --filter @precedent-loop/server typecheck
pnpm --filter @precedent-loop/server test
pnpm --filter @precedent-loop/server build
pnpm --filter @precedent-loop/desktop typecheck
pnpm --filter @precedent-loop/desktop test
```

Server, desktop and shared-package checks use isolated fixtures. Hub UI changes are accepted manually by the user; agents do not run Hub tests, type checks, builds or browser checks as UI validation.

Smoke tests that exercise built artifacts live in each package's `package.json` (`smoke:*` scripts). Build the affected package first. Server smokes that serve Hub assets also require an existing Hub `dist`; they check HTTP delivery, not UI acceptance. Tests use temporary folders and never touch your real data or `~/Library/Application Support`.

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
- Generate and validate IDs only through `@precedent-loop/id-generator` (`ast`, `tsk`, `usg`, `cnd` prefixes followed by digits).
- Put DDL in `storage/schema.sql`, query SQL in `storage/` or `*-repository.ts`, and use-case logic in services. HTTP, MCP and hook entry points validate input, call the shared service and map errors. See [Persistence rules](../工程约定/数据持久化约定.md).
- SQLite holds the original knowledge and candidates. Content writes use short transactions, version checks and receipts; acceptance updates FTS in the same transaction. Knowledge deletion is logical, and all current-content reads filter deleted rows. There is no restore entry point.
- Errors use the module's error type and `code`; each entry point maps them. Never return internal stack traces to clients.
- The Hub talks to the server only through `apps/hub/src/api/client.ts` with the types in `api/types.ts`.

## Pull requests

- Keep changes focused: no unrelated refactors, formatting sweeps or dependency upgrades.
- Add or update tests for server, desktop and shared-package behaviour changes, and run the corresponding package checks above. For Hub changes, list the behaviour the user needs to accept manually.
- Changes that affect storage, MCP tool contracts or installed integrations need a note on compatibility and migration.
- For larger changes, open an issue first to agree on the approach.
