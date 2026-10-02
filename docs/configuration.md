# Configuration

Most people configure everything in the desktop app. This page is for editing configuration files by hand and for running the server without the app.

## Data folder

SQLite is the sole source of truth for knowledge, candidates, previous content, display numbers, full-text search and operation records. The current database baseline is **2**.

```text
<data folder>/
  .precedentloop.json
  config/workspaces.json
  runtime/precedent-loop.sqlite
  logs/
```

The desktop app requires a valid `.precedentloop.json` marker and a database with `user_version=2` to recognize an existing data folder. The backend also checks the required tables and workspace configuration. A marker with a missing database or version 0 is an incomplete initialization; a nonempty folder without a marker is not recognized as product data. Other database versions are refused.

Setup creates the marker and layout in a new or empty folder, then explicitly runs `init-database --offline` on an empty database. It can resume an incomplete initialization without overwriting existing data. Normal startup and app updates do not initialize or upgrade storage. The marker's `formatVersion`, app configuration versions and workspace `schemaVersion` remain separate from the database baseline.

Standalone server operation uses the database and workspace paths below; it does not require the desktop marker. See [Development](development.md#dev-mode) for initialization. Knowledge is stored as rows with Markdown bodies, so a knowledge repository directory is not required.

## app-config.json

Location: `~/Library/Application Support/PrecedentLoop/app-config.json`. The app creates it during setup, saves it atomically and keeps it readable only by you (`0600`).

```json
{
  "configVersion": 1,
  "setupVersion": 1,
  "setupCompleted": true,
  "dataDirectory": "/absolute/path/to/PrecedentLoop",
  "port": 18888,
  "startupTimeoutMs": 30000,
  "shutdownTimeoutMs": 15000
}
```

| Field | Meaning |
|---|---|
| `dataDirectory` | Absolute path of the data folder. Change it through **Settings → Data & storage** rather than by hand. |
| `port` | Local server port. Default `18888`. |
| `startupTimeoutMs`, `shutdownTimeoutMs` | How long the app waits for the server to start and stop. |

`port` and the timeouts may be omitted. The file also stores settings made in the app, such as AI overrides and CLI paths. If it is damaged, the app opens its recovery screen and offers to back it up and start setup again.

## workspaces.json

Location: `<data folder>/config/workspaces.json`. It lists the projects that have their own knowledge scope.

```json
{
  "schemaVersion": 1,
  "workspaces": [
    {
      "name": "example-project",
      "paths": ["/absolute/path/to/example-project"],
      "aliases": ["example", "demo app"],
      "description": "Short description that helps agents recognise the project"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `name` | Unique; one safe path segment (no `/`); `global` is reserved |
| `paths` | One or more absolute paths. A working directory inside one of them counts as this project. |
| `aliases` | Optional, up to 4, each 1–40 characters. Other names you use for the project. |
| `description` | Optional, up to 160 characters |

Aliases and descriptions only help agents pick the right project; they do not change access. The app's **Projects (项目与授权)** page only adds new entries with a name and path; edit aliases and descriptions in this file. Changes are picked up without a restart.

Removing a project or changing its paths invalidates the capability IDs agents were given for it.

## AI providers

Import and AI rewrite call a local CLI. When you use the desktop app:

- CLI paths come from **Settings → Agents**: a path you chose by hand wins, otherwise the path the app detected.
- Provider, model, reasoning effort and timeout come from **Settings → AI**; anything not overridden uses the defaults below.

Defaults live in [`apps/server/resources/ai-providers.json`](../apps/server/resources/ai-providers.json):

```json
{
  "providers": [
    { "id": "codex", "executable": "/opt/homebrew/bin/codex", "timeoutMs": 600000 },
    { "id": "claude", "executable": "/opt/homebrew/bin/claude", "timeoutMs": 600000 }
  ]
}
```

Each provider accepts an absolute `executable`, optional `model`, optional `effort`, an optional `profile` (Codex only) and `timeoutMs` (1 second to 1 hour). The `executable` here is only used when the server runs without the desktop app.

Configuration is re-read for every call. An invalid configuration fails with `AI_CONFIGURATION_INVALID`; the app never silently switches to another provider.

## Environment variables

These are only needed when you run the server or the maintenance CLIs yourself (see [Development](development.md)). The desktop app sets them for its own server.

| Variable | Used by | Meaning |
|---|---|---|
| `PRECEDENT_LOOP_DATABASE_PATH` | Server, hooks, CLIs | Absolute path of the SQLite database |
| `PRECEDENT_LOOP_WORKSPACES_PATH` | Server, hooks, CLIs | Absolute path of `workspaces.json` |
| `PRECEDENT_LOOP_LOG_PATH` | Server, hooks | Log file; use an absolute path |
| `PRECEDENT_LOOP_APP_CONFIG_PATH` | Server | Path of `app-config.json`, so the server reads AI settings and CLI paths from the app |
| `PORT` | Server | Listening port. Default `3000` when run standalone. |
| `PRECEDENT_LOOP_SERVER_PORT` | Hub dev server (Vite) | Port the `/api` proxy forwards to. Default `3000`. |

The database and workspaces paths must be absolute. The database must already contain the complete version 2 schema, and the workspaces file must exist.
