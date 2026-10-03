# Review workflow

Nothing becomes a precedent without your approval. This page describes how candidates are created, reviewed and accepted.

## Where candidates come from

- **Agents** — when a decision is settled or a finding is verified, the agent calls `candidate_prepare` (or `candidate_update` to merge into a pending candidate on the same topic). When an agent finds that a precedent it used is outdated, wrong, incomplete or misleading, it reads the precedent and prepares a revision candidate. When the app is running, its candidate page opens automatically.
- **Import** — on the candidate page, import existing Markdown notes and let your local Codex or Claude Code CLI turn them into candidates.

Candidates are stored separately from approved knowledge and are never returned by recall.

## Reviewing in the Hub

Open **Candidates (知识候选)** in the Hub. Click a title, or **View full text (查看全文)**, to see the summary, retrieval terms, body and version details. For a revision, the Hub also shows the difference from the approved version. For each candidate you can:

| Action | Effect |
|---|---|
| **Accept (接受)** | Publishes the candidate, or applies the revision, and makes it searchable |
| **AI rewrite (AI 改稿)** | Describe what to change and let your local CLI rewrite the candidate; it stays pending |
| **Defer (暂存)** | Set it aside; restore it later |
| **Reject (拒绝)** | Marks the candidate rejected and removes it from the list. Rejecting a revision does not touch the approved version. |

Acceptance is bound to the exact candidate version you reviewed. If the candidate changes after you opened it, the app asks you to review again. For a revision, the app also checks that the approved precedent has not changed since the revision was prepared.

The app keeps the current and the previous version of each precedent.

## Duplicate checks

Before writing a new candidate, `candidate_prepare` compares it with every pending and deferred candidate. If any exist, the agent receives the list and must either:

- do nothing, if the topic is already covered;
- merge its content into the matching candidate with `candidate_update`; or
- confirm it has compared against all of them, and write a new, independent candidate.

A precedent can have only one open candidate. If an agent prepares a revision while one exists, it receives `REVISION_BLOCKED` with that candidate's full content and merges its change into it with `candidate_update`.

Import also compares against pending candidates. Items that fail the content checks, or that revise a precedent which already has an open candidate, are skipped with a warning; the rest are written.

## Importing existing notes

1. On the candidate page, choose **Import (导入外部知识)** and select files. Supported: UTF-8 `.md`, `.markdown` and `.mdx` (MDX is read as text).
2. Optionally pick the scopes the results may go to. If you pick none, the CLI sorts each item into global knowledge or one of your registered projects.
3. The whole batch is processed in one run. It can produce up to 32 candidates — they do not map one-to-one to files — plus a note for each source file.

For comparison, the CLI also sees up to 32 existing precedents (256,000 bytes in total) from the allowed scopes, so it can avoid obvious duplicates. Your original files are never modified, and links, paths or instructions inside them are treated as content, not followed.

If you have no registered projects yet when you first import, the app registers the local projects that Codex knows about. You can add more later in **Settings → Projects (项目与授权)**.

## AI rewrite

From a candidate, describe what you want changed and let the AI rewrite it. The result replaces the candidate's content, including its retrieval terms, and goes back to pending; it is never accepted automatically.

Import and AI rewrite both run your local CLI, configured in **Settings → AI (AI 整理)**: default provider, model, reasoning effort and timeout. The CLI runs in a restricted mode:

- **Codex** — read-only sandbox, ephemeral session; MCP servers, hooks, plugins and web search disabled.
- **Claude Code** — no tools, no MCP servers; hooks, slash commands and auto-memory disabled; session not saved.

Your normal sign-in, model and proxy settings are used; the app never copies credentials. Only one AI operation runs at a time.

Claude Code can only be used for this when signed in with a personal Pro or Max account (claude.ai) without managed policies, because organisation-managed hooks cannot be switched off per call.

**Data note:** the documents you import, the candidate you rewrite, and the comparison precedents are sent to whichever model your CLI uses.

## Backups

To back up, quit the app (so the server and hooks stop writing), then copy the whole data folder. The SQLite database may have `-wal` and `-shm` files next to it; copy them too, or use SQLite's own backup tools. The database holds all knowledge, candidates, previous versions and usage records, so a copy of the data folder is a complete backup.
