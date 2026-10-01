# Agent integration

How Codex and Claude Code connect to Precedent Loop, and what the agent sees.

## Overview

For each agent, the app can install three integration items. You manage them in the setup wizard or in **Settings → Agents (Agent 接入)**.

| Item | What it installs | What it does |
|---|---|---|
| Knowledge connection | MCP server registration | Gives the agent the knowledge tools listed below |
| Project recognition | `UserPromptSubmit` hook | Tells the agent, on every prompt, which projects have knowledge and how to use the tools |
| Delivery reminders | `PostToolUse` and `Stop` hooks | Reminds the agent to consider recording what it learned before it finishes |

Every install, repair or removal is shown as a preview of the exact changes before anything is written. The app does not add rules to your personal `AGENTS.md` or `CLAUDE.md`.

## MCP server

The app runs a local MCP server over HTTP:

```text
http://127.0.0.1:18888/mcp
```

`18888` is the default port; it changes if you pick another one in **Settings → Advanced**. The server only accepts requests addressed to `127.0.0.1` on that port, and rejects other hosts and browser origins.

The app registers the server with the agents' own commands. To register by hand:

```bash
codex mcp add precedent --url http://127.0.0.1:18888/mcp
```

```bash
claude mcp add --transport http --scope user precedent http://127.0.0.1:18888/mcp
```

The MCP server is only available while the app is running (closing the window keeps it running).

## Tools

| Tool | Purpose | Key inputs and limits |
|---|---|---|
| `knowledge_recall` | Search knowledge in the chosen projects | `capabilityIds` (0–8 projects; `[]` = global only), `queries` (1–8 literal expressions). Returns at most 8 items and 5,000 characters in total. |
| `asset_read` | Read the full text of a recalled item | `capabilityIds` plus a `recallItemId` from the recall. Content up to 256,000 bytes. |
| `asset_mark_used` | Record that an item actually influenced the work | `capabilityIds` plus a `recallItemId` or `readRef`. Reading alone does not count as use. |
| `candidate_prepare` | Propose a new precedent or a revision | One project, or `[]` for global, plus structured fields for the knowledge type. Writes to the inbox only. |
| `candidate_update` | Revise a pending candidate on the same topic | The candidate's ID and hash plus the full revised title, summary and body. |

How recall works:

- Each query is matched as a literal, case-insensitive substring. Spaces and punctuation are kept; `a|b` or `AND`/`OR` are not treated as query syntax. Results from all queries are de-duplicated and ranked together.
- Short memories that match well are returned inline; documents, skills and other matches are returned as references for `asset_read`.
- Only approved knowledge in `assets/` is searchable. Candidates in the inbox are never recalled.

Candidates are never approved by the agent. They appear in the app's candidate page, which opens automatically when the app is running. See [Review workflow](review-workflow.md).

## Projects and capabilities

Knowledge is scoped to **projects** you register (see [Configuration](configuration.md#workspacesjson)) plus a **global** scope shared by all of them.

On every prompt, the project-recognition hook gives the agent the list of registered projects — names, aliases, short descriptions, and an opaque capability ID for each. The project that contains the current directory is listed first. Up to 24 projects are listed; the rest are left out by name and the agent is told so.

The agent chooses the relevant projects for each request and passes their capability IDs to the tools. Any registered project can be used from any working directory, so knowledge from one project is available while you work in another.

Only you can register projects, from the app or by editing `workspaces.json`. Agents cannot add or widen access themselves. Capability IDs stay valid until the project is removed or its paths change.

## Hooks

All hooks run through a small launcher that the app installs at `~/.precedent/bin/precedent-hook`, which then runs the CLI bundled inside the app.

- **`UserPromptSubmit`** (timeout 10 s) — injects the project list and usage guidance. It does not read or rewrite your prompt and does not run a recall by itself.
- **`PostToolUse`** (matches `Bash` and `apply_patch`) — marks that the turn did real work. It only touches a small local cache.
- **`Stop`** — if the turn did work but the agent did not record whether there was anything worth keeping, it shows a reminder. It never blocks the agent from finishing.

`PostToolUse` and `Stop` never access the knowledge database. Their timeouts are 1 s for Codex and 5 s for Claude Code, and the CLI gives up gracefully after 750 ms.

The agent records its assessment with a one-line command included in the injected guidance. The outcome is one of: nothing new, candidate prepared, assessment failed, or skipped (clarification only).

## Removing the integration

In **Settings → Agents**, remove the integration for one agent or for all of them. As with installing, you see a preview first.

If you edited an installed item yourself (for example, changed the hook configuration), the app keeps your version unless you explicitly choose to remove it. Files that are replaced or removed are backed up first.

Removing the integration does not uninstall Codex or Claude Code and does not delete your knowledge.
