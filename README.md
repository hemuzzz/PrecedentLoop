# Precedent Loop

**Turn experience into precedent.**

Local, human-reviewed engineering memory for Codex and Claude Code.

[![Release](https://img.shields.io/github/v/release/hemuzzz/PrecedentLoop)](https://github.com/hemuzzz/PrecedentLoop/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey.svg)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

English · [简体中文](README.zh-CN.md)

https://github.com/user-attachments/assets/b9700805-b317-4676-b0c6-9cdd093ea33e

<sub>83-second overview — Chinese narration with English subtitles.</sub>

## Why

Coding agents start every session from zero. The root cause you tracked down last week, the trade-off you settled on together, the trap you already fell into — you end up explaining them again.

Built-in memories help, but they are written automatically, hard to inspect, and you can't tell when they apply.

Precedent Loop keeps that experience as **precedents**: short notes that you have reviewed and approved. Your agents recall them on demand, per project, when a task actually needs them.

## How it works

```text
  work with your agent ──▶ agent proposes a candidate ──▶ you review, edit and accept in the Hub
           ▲                                                            │
           │                                                            ▼
           └──────── next task: agent recalls it and marks what it used ◀── precedent
```

1. **Capture** — when a decision is settled or a root cause is confirmed, the agent prepares a structured candidate. Nothing enters the knowledge base on its own.
2. **Review** — the desktop app opens the candidate. You can edit it, ask AI to rewrite it, accept, defer or reject it. Acceptance is bound to the exact content you saw.
3. **Recall** — in later sessions the agent searches the projects relevant to the request and reads only what it needs.
4. **Settle** — the agent marks which precedents actually shaped its answer, so you can see what is useful and what is dead weight.
5. **Revise** — when the agent finds a precedent outdated or wrong while using it, it proposes a revision candidate, which goes through the same review.

## Features

- **Human in the loop** — agents can only propose. Every precedent is something you approved, word for word.
- **Scoped, budgeted recall** — up to 8 items and 5,000 characters per recall, across the projects the agent picks. Context stays small.
- **One knowledge base for Codex and Claude Code** — connected through MCP and hooks; the setup wizard configures both.
- **Import what you already have** — turn existing Markdown notes (`.md`, `.markdown`, `.mdx`) into candidates using your local Codex or Claude Code CLI. No model API keys are stored in the app.
- **Usage tracking** — see which precedents are actually used, and clean up the rest.
- **Local SQLite storage** — one database holds the knowledge, its Markdown bodies, the previous version of each item, candidates, the search index and usage records. Back up the data folder to keep all of it.

## How it compares

|  | `AGENTS.md` / `CLAUDE.md` | Built-in memories | Precedent Loop |
|---|---|---|---|
| Best for | Rules that always apply | Light personal context | Decisions, root causes, lessons learned |
| Written by | You | The agent, automatically | The agent proposes, you approve |
| Loaded | Every session, in full | Decided by the client | On demand, per project, within a budget |
| Shared across | One repository | One client | Codex and Claude Code, all your registered projects |
| Stored as | Files in the repo | Client-internal storage | Local SQLite, with Markdown bodies |

Precedent Loop does not replace the other two. Keep always-on rules in `AGENTS.md`; keep hard-won, situational knowledge here.

## Requirements

- macOS on Apple Silicon. Intel builds are possible from source but untested.
- [Codex CLI](https://github.com/openai/codex) and/or [Claude Code](https://claude.com/claude-code), installed and signed in.

## Install

There are two ways to install: download the prebuilt app, or build it yourself.

### Option A: download the prebuilt app

1. Open the [latest release](https://github.com/hemuzzz/PrecedentLoop/releases/latest) and download **`PrecedentLoop-<version>-arm64-local-install.dmg`**. The `-update.dmg` and `.json` files are used by the in-app updater; you don't need them.
2. Open the DMG and drag **PrecedentLoop** into **Applications**. Keep it there: in-app updates replace `/Applications/PrecedentLoop.app`, and the agent hooks point to the app's location.
3. Allow the app to open. It is **not signed or notarized by Apple**, so macOS blocks the first launch:
   1. Open PrecedentLoop. macOS says it cannot verify the app. Click **Done** (not **Move to Trash**).
   2. Open **System Settings → Privacy & Security** and scroll to **Security**. You will see a message that PrecedentLoop was blocked. Click **Open Anyway**.
   3. Confirm with your password or Touch ID, then click **Open Anyway** again in the dialog that follows.

   macOS remembers this choice, so you only do it once. If you prefer the terminal, you can remove the download quarantine flag instead:

   ```bash
   xattr -dr com.apple.quarantine /Applications/PrecedentLoop.app
   ```

   Only do this for an app you downloaded from this repository's releases.

### Option B: build from source

A build you make yourself is not quarantined, so macOS opens it without the steps above.

1. Install the build tools. The versions are pinned and enforced (`engine-strict`), so other versions are refused:
   - Node.js **24.21.0**, for example with [nvm](https://github.com/nvm-sh/nvm): `nvm install 24.21.0`
   - pnpm **11.1.3**, for example with `corepack enable` (the version is read from `package.json`)
   - Git, and a network connection: the first install downloads Electron.
2. Build the app:

   ```bash
   git clone https://github.com/hemuzzz/PrecedentLoop.git
   cd PrecedentLoop
   pnpm install --frozen-lockfile
   cp apps/desktop/build-config.example.json .desktop-local.json
   pnpm build
   pnpm --filter @precedent-loop/desktop package:mac
   ```

   The last command prints the app's location, `dist/desktop/<build id>/PrecedentLoop.app`. Each build goes into a new folder.
3. Copy it to Applications, then open it as usual:

   ```bash
   ditto "dist/desktop/<build id>/PrecedentLoop.app" /Applications/PrecedentLoop.app
   ```

To update a source build after setup is complete, pull the latest code and rebuild in place. `update:mac` builds a new app, quits the running one, replaces `/Applications/PrecedentLoop.app` and starts it again:

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @precedent-loop/desktop update:mac
```

See [Development](docs/development.md) for dev mode, tests and release builds.

## Quick start

1. **Run the setup wizard.** On first launch, choose a data folder (avoid iCloud and network drives; they can corrupt the database), let the app detect Codex and Claude Code, and connect them. The app registers its MCP server and installs the hooks for you.
2. **Register your projects.** Pick projects from your recent Codex and Claude Code workspaces. Each project gets its own knowledge scope; global knowledge is shared by all.
3. **Work as usual.** When a task ends with a settled decision or a verified fix, the agent prepares a candidate and the app opens it for review.
4. **Accept it.** From then on, your agents can recall it — in that project, or in any project when it is global knowledge.

Already have notes? Use **Import** on the candidates page to turn Markdown files into candidates.

Closing the window keeps the local server running so your agents can still reach the knowledge base. Quit with **Cmd+Q** to stop it.

## Updating

Choose **PrecedentLoop → Check for Updates (检查更新…)** in the menu bar. The app checks GitHub only when you click it. If a newer release is available, it verifies the package's size and SHA-256 before installing and restarting. Your data folder and settings stay in place.

## Data and privacy

- All knowledge lives in the data folder you choose: the SQLite database in `runtime/`, registered projects in `config/`, and logs in `logs/`. App preferences are kept in `~/Library/Application Support/PrecedentLoop/`.
- The local server listens only on `127.0.0.1` and rejects requests from other hosts and origins.
- No telemetry, no accounts, no model API calls from the app itself.
- **Import and AI rewrite** run your local Codex or Claude Code CLI. The documents you import, plus a bounded set of existing precedents used for comparison, are processed by whichever model that CLI is configured to use.
- Deleting a precedent in the Hub marks it as deleted; recall and usage history are kept. There is currently no restore action.

## Uninstall

1. In **Settings → Agents (Agent 接入)**, remove the Codex and Claude Code integrations. This unregisters the MCP server and removes the hooks.
2. Quit the app and delete `/Applications/PrecedentLoop.app`.
3. Delete `~/Library/Application Support/PrecedentLoop/`, and the data folder if you no longer need your knowledge.

## Status and limitations

Precedent Loop is an early-stage personal project.

- macOS on Apple Silicon only; the app is unsigned and not notarized.
- The interface is currently in Chinese.
- AI import and rewrite through Claude Code only support personal Pro/Max sign-ins (claude.ai) without managed policies.
- Storage and integration formats may still change between versions.

## Documentation

- [Desktop app](docs/desktop-app.md) — setup wizard, settings, updates
- [Agent integration](docs/agent-integration.md) — MCP tools and hooks for Codex and Claude Code
- [Knowledge format](docs/knowledge-format.md) — types, scopes, fields, versions and how to write a precedent
- [Knowledge content model](apps/server/resources/knowledge-content-model.md) — the content rules agents follow
- [Review workflow](docs/review-workflow.md) — candidates, review, import and AI rewrite
- [Configuration](docs/configuration.md) — environment variables, config files and data folder recognition
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md) — repository layout, dev mode, tests, packaging

## Contributing

Issues and pull requests are welcome. Please read [Development](docs/development.md) first; for larger changes, open an issue to discuss the approach.

## License

[Apache License 2.0](LICENSE)
