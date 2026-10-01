# Desktop app

How the macOS app runs, where it keeps your data, and how to update it.

The interface is currently in Chinese. Menu and page names below are given in English, followed by the label you will see in the app.

## First launch and setup wizard

The first launch opens a four-step setup wizard. Progress is saved as you go; if you quit halfway, the next launch resumes where you left off.

1. **Local data (本地数据)** — choose where your knowledge lives. You can create a new folder, use an empty one, or link a folder that already contains Precedent Loop data. Cloud-synced and network drives are flagged: they can corrupt the SQLite database, so you must confirm explicitly if you still want to use one.
2. **Coding agents (Coding Agent)** — the app looks for the Codex CLI and Claude Code and checks that you are signed in. It only runs `--version` and the CLIs' own status commands; no model requests are made. If a CLI is not found automatically, you can point to it by hand.
3. **Integration and projects (接入与工作区)** — connect each agent (see [Agent integration](agent-integration.md)) and register the projects you want knowledge for. Every change is shown as a preview before it is written.
4. **Check (检查)** — the app verifies the data folder, storage version, bundled runtime, local server, index and MCP address. Setup is only marked complete when all checks pass.

If the app cannot start normally later — for example because the configuration is damaged or the data folder is missing — it opens a **recovery screen** instead. From there you can re-run the checks, link another existing data folder, open the log folder, or (for a damaged configuration only) back it up and run setup again. Your knowledge data is never deleted by recovery.

## Data folder

Everything Precedent Loop knows is stored in the data folder you chose:

```text
<data folder>/
├── repository/                    # your knowledge, as Markdown
│   ├── assets/                    # approved precedents
│   └── inbox/                     # candidates waiting for review
├── runtime/precedent-loop.sqlite  # index, usage records, version history
├── config/workspaces.json         # registered projects
└── logs/                          # server.log, desktop.log
```

See [Knowledge format](knowledge-format.md) for what goes inside `repository/`.

App settings are stored separately in `~/Library/Application Support/PrecedentLoop/app-config.json` (see [Configuration](configuration.md)). That file only points to the data folder; it holds no knowledge.

To move your data, use **Settings → Data & storage (数据与存储)**:

- **Move** copies everything to a new, empty location, verifies every file by SHA-256, then switches over and restarts. The old folder is kept; delete it yourself when you are satisfied.
- **Link** switches to another folder that already contains Precedent Loop data. Nothing is copied or merged.

Avoid using your agents' knowledge features while a move is in progress.

## Settings

| Page | What it does |
|---|---|
| General (通用) | Appearance and app updates |
| Agents (Agent 接入) | Connect, repair or remove Codex and Claude Code integrations (each agent as a whole); choose CLI paths |
| Projects (项目与授权) | Add projects from your recent Codex and Claude Code workspaces |
| AI (AI 整理) | Default CLI, model, reasoning effort and timeout for import and AI rewrite |
| Data & storage (数据与存储) | Move or link the data folder |
| Advanced (高级) | Change the local port, reset preferences, export diagnostics |

Changing the port restarts the local server and then repairs the MCP registration of connected agents. Resetting preferences does not touch your knowledge, integrations, CLI paths or projects.

## Running in the background

Closing the window keeps the local server running, so your agents can still reach the knowledge base. Click the Dock icon to bring the window back. Quit from the menu or with **Cmd+Q** to shut the server down; the app waits for it to stop cleanly.

## Updates

Choose **PrecedentLoop → Check for Updates (检查更新)**. The app asks GitHub for the latest stable [release](https://github.com/hemuzzz/PrecedentLoop/releases); nothing is checked in the background.

If you choose to download, the app verifies the package's size, SHA-256, version, architecture and app identity before offering **Install and Restart**. During the update:

- your settings and knowledge data stay where they are and are not migrated;
- if replacing the app fails, the previous version is restored;
- if the new version fails to start, a backup of the previous version is kept and its location is shown.

Some releases need manual steps (for example a storage upgrade). Those releases are marked in their release notes and are not installed automatically.

The app is not signed or notarized by Apple. Updates rely on HTTPS from GitHub and the package checks above.

## Opening source links

Precedents often point at source files. Clicking a local path (such as `/Users/you/project/src/service.ts:42`) or a `file:` link in the app opens the file in your default editor. Line and column suffixes are recognised but the editor is not yet moved to that line. Paths under `/Users/`, `/Volumes/`, `/private/`, `/tmp/`, `/var/` and `/opt/` are supported. Web links open in your browser.
