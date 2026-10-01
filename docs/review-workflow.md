# Review workflow

Nothing becomes a precedent without your approval. This page describes how candidates are created, reviewed and accepted.

## Where candidates come from

- **Agents** — when a decision is settled or a finding is verified, the agent calls `candidate_prepare` (or `candidate_update` to revise a pending candidate on the same topic). When the app is running, its candidate page opens automatically.
- **Import** — in the Hub, import existing Markdown notes and let your local Codex or Claude Code CLI turn them into candidates.

Candidates are written to `inbox/` and are never returned by recall.

## Reviewing in the Hub

Open **Candidates (知识候选)** in the Hub. For each candidate you can:

| Action | Effect |
|---|---|
| **Accept (接受入库)** | Publishes the candidate to `assets/` and makes it searchable |
| **Edit (修改)** | Change the title, summary or body, by hand or with AI rewrite; the candidate stays pending |
| **Defer (暂存)** | Set it aside; restore it later |
| **Reject (拒绝)** | Delete the candidate. There is no recycle bin. Rejecting a revision does not touch the approved version. |

Acceptance is bound to the exact content you reviewed. If the file changes after you opened it, the app asks you to review again. For a revision, the app also checks that the approved version has not changed since the revision was prepared, and shows a diff between the two.

The app keeps the current and the previous approved version of each precedent.

## Duplicate checks

Before writing a new candidate, `candidate_prepare` compares it with every pending candidate. If any exist, the agent receives the list and must either:

- do nothing, if the topic is already covered;
- merge its content into the matching candidate with `candidate_update`; or
- confirm it has compared against all of them, and write a new, independent candidate.

Import also compares against pending candidates. Items that fail the content checks, or that revise a precedent which already has a pending revision, are dropped with a warning; the rest are written.

## Importing existing notes

1. In the Hub, open the import dialog from **Candidates** and choose files. Supported: UTF-8 `.md`, `.markdown` and `.mdx` (MDX is read as text).
2. Optionally pick the scopes the results may go to. If you pick none, the CLI sorts each item into global knowledge or one of your registered projects.
3. The whole batch is processed in one run. It can produce any number of candidates — they do not map one-to-one to files — plus a note for each source file.

For comparison, the CLI also sees up to 32 existing precedents (256,000 bytes in total) from the allowed scopes, so it can avoid obvious duplicates. Your original files are never modified, and links, paths or instructions inside them are treated as content, not followed.

If you have no registered projects yet when you first import, the app offers to register the local projects Codex knows about. You can also continue with global knowledge only.

## AI rewrite

From a candidate, describe what you want changed and let the AI rewrite it. The result replaces the candidate's content and goes back to pending; it is never accepted automatically.

Import and AI rewrite both run your local CLI, configured in **Settings → AI (AI 整理)**: default provider, model, reasoning effort and timeout. The CLI runs in a restricted mode:

- **Codex** — read-only sandbox, MCP servers, hooks and plugins disabled, nothing saved.
- **Claude Code** — no tools, no MCP servers, hooks, skills and auto-memory disabled, session not saved.

Your normal sign-in, model and proxy settings are used; the app never copies credentials. Only one AI operation runs at a time.

Claude Code is only supported for this when signed in with a personal Pro or Max account without managed policies, because organisation-managed hooks cannot be switched off per call.

**Data note:** the documents you import, the candidate you rewrite, and the comparison precedents are sent to whichever model your CLI uses.

## Backups

To back up, quit the app (so the server and hooks stop writing), then copy the whole data folder. The SQLite database may have `-wal` and `-shm` files next to it; copy them too, or use SQLite's own backup tools.

Keep the Markdown and the database together. The database holds version history and usage records that cannot be rebuilt from the Markdown files alone; the search index can.
