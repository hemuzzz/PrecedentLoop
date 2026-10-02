# Precedent Loop

**Turn experience into precedent.**

Local, human-reviewed engineering memory for Codex and Claude Code.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

English · [简体中文](README.zh-CN.md)

<!-- TODO: screenshot or short GIF of the Hub (knowledge list + candidate review). Suggested path: docs/images/hub.png -->

## Why

Coding agents start every session from zero. The root cause you tracked down last week, the trade-off you settled on together, the trap you already fell into — you end up explaining them again.

Built-in memories help, but they are written automatically, hard to inspect, and you can't tell when they apply.

Precedent Loop keeps that experience as **precedents**: short Markdown notes that you have reviewed and approved. Your agents recall them on demand, per project, when a task actually needs them.

## How it works

```text
  work with your agent ──▶ agent proposes a candidate ──▶ you review, edit and accept in the Hub
           ▲                                                            │
           │                                                            ▼
           └──────── next task: agent recalls it and marks what it used ◀── precedent
```

1. **Capture** — when a decision is settled or a root cause is confirmed, the agent prepares a structured candidate. Nothing enters the knowledge base on its own.
2. **Review** — the desktop app opens the candidate. You edit, accept, defer or reject it. Acceptance is bound to the exact content you saw.
3. **Recall** — in later sessions the agent searches the projects relevant to the request and reads only what it needs.
4. **Settle** — the agent marks which precedents actually shaped its answer, so you can see what is useful and what is dead weight.

## Features

- **Human in the loop** — agents can only propose. Every precedent is something you approved, word for word.
- **Scoped, budgeted recall** — up to 8 items and 5,000 characters per recall, across the projects the agent picks. Context stays small.
- **One knowledge base for Codex and Claude Code** — connected through MCP and hooks; the setup wizard configures both.
- **Import what you already have** — turn existing Markdown notes into candidates using your local Codex or Claude Code CLI. No model API keys are stored in the app.
- **Usage tracking** — see which precedents are actually used, and clean up the rest.
- **Local SQLite storage** — one database holds the original knowledge, Markdown bodies, candidates, previous content, display numbers, search index and operation records. Back up the database to preserve them.

## How it compares

|  | `AGENTS.md` / `CLAUDE.md` | Built-in memories | Precedent Loop |
|---|---|---|---|
| Best for | Rules that always apply | Light personal context | Decisions, root causes, lessons learned |
| Written by | You | The agent, automatically | The agent proposes, you approve |
| Loaded | Every session, in full | Decided by the client | On demand, per project, within a budget |
| Shared across | One repository | One client | Codex and Claude Code, all your registered projects |
| Stored as | Files in the repo | Client-internal storage | Local SQLite, with Markdown bodies |

Precedent Loop does not replace the other two. Keep always-on rules in `AGENTS.md`; keep hard-won, situational knowledge here.

## Install

### Download

Download the latest `.dmg` from [Releases](https://github.com/hemuzzz/PrecedentLoop/releases) and drag **PrecedentLoop** into Applications.

The app is not signed with an Apple Developer ID. On first launch, macOS will block it: open **System Settings → Privacy & Security** and click **Open Anyway**.

Requirements:

- macOS on Apple Silicon (Intel builds are possible but untested)
- [Codex CLI](https://github.com/openai/codex) and/or [Claude Code](https://claude.com/claude-code), installed and signed in

### Build from source

Requires Node.js `24.21.0` and pnpm `11.1.3`.

```bash
pnpm install --frozen-lockfile
cp apps/desktop/build-config.example.json .desktop-local.json
pnpm build
pnpm --filter @precedent-loop/desktop package:mac
```

The app is written to `dist/desktop/`. See [Development](docs/development.md) for dev mode, tests and release builds.

## Quick start

1. **Run the setup wizard.** On first launch, choose a data folder, let the app detect Codex and Claude Code, and connect them. The app registers its MCP server and installs the hooks for you.
2. **Register your projects.** Pick projects from your recent Codex and Claude Code workspaces. Each project gets its own knowledge scope; global knowledge is shared by all.
3. **Work as usual.** When a task ends with a settled decision or a verified fix, the agent prepares a candidate and the app opens it for review.
4. **Accept it.** From the next session on, your agents can recall it — in that project, or in any project when it is global knowledge.

Already have notes? Use **Import** in the Hub to turn Markdown files into candidates.

The data folder uses database baseline version **2**. The desktop app identifies it by `.precedentloop.json` and `runtime/precedent-loop.sqlite`; setup explicitly initializes a new folder. Startup and app updates do not initialize or upgrade an existing database. See [Configuration](docs/configuration.md#data-folder) for the layout and recognition rules, and [Development](docs/development.md#dev-mode) for standalone initialization.

Deleting knowledge in the Hub marks it as deleted in the database. It leaves recall and usage history intact, and is blocked while the knowledge has a pending or deferred candidate. There is currently no restore action.

## Privacy

- All data lives in the folder you choose. The local server listens only on `127.0.0.1` and rejects requests from other hosts and origins.
- No telemetry, no accounts, no model API calls from the app itself.
- **Import and AI rewrite** run your local Codex or Claude Code CLI. The documents you import, plus a bounded set of existing precedents used for comparison, are processed by whichever model that CLI is configured to use.
- **Check for Updates** contacts GitHub only when you click it.

## Status and limitations

Precedent Loop is an early-stage personal project.

- macOS only; the app is unsigned and not notarized.
- The interface is currently in Chinese.
- AI import through Claude Code only supports personal Pro/Max sign-ins without managed policies.
- Storage and integration formats may still change between versions.

## Documentation

- [Desktop app](docs/desktop-app.md) — data folder, settings, updates
- [Agent integration](docs/agent-integration.md) — MCP tools and hooks for Codex and Claude Code
- [Knowledge content model](apps/server/resources/knowledge-content-model.md) — knowledge bodies and review guidance
- [Review workflow](docs/review-workflow.md) — candidates, review, import and AI rewrite
- [Configuration](docs/configuration.md) — environment variables and config files
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md) — repository layout, dev mode, tests, packaging

## Contributing

Issues and pull requests are welcome. Please read [Development](docs/development.md) first; for larger changes, open an issue to discuss the approach.

## License

[Apache License 2.0](LICENSE)
