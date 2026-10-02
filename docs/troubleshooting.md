# Troubleshooting

Start with **System status (系统状态)** in the Hub: it shows service readiness, the database baseline and workspace configuration. Logs are in `<data folder>/logs/` (`server.log`, `desktop.log`).

## The app won't open

**macOS says the app can't be opened or can't be verified.** The app is not signed by Apple. Open **System Settings → Privacy & Security** and click **Open Anyway** next to the message about PrecedentLoop. If macOS says the app is *damaged*, remove the download quarantine flag and try again:

```bash
xattr -dr com.apple.quarantine /Applications/PrecedentLoop.app
```

**The recovery screen appears.** The app could not start normally — for example the configuration is damaged, the data folder is unavailable, or the storage version is not supported. The screen tells you which; re-run the checks after fixing the cause, link another existing data folder, or open the log folder.

**The local server fails to start.** Usually another process is using the port. The app never takes over or kills other processes. Free the port, or choose another one in **Settings → Advanced**.

## The agent can't reach the knowledge base

1. Make sure the app is running (closing the window is fine; quitting is not).
2. Open `http://127.0.0.1:18888/health` in a browser (use your port if you changed it).
3. Check that the agent's MCP entry points to `http://127.0.0.1:<port>/mcp`. Re-apply the integration in **Settings → Agents** if it shows **Needs repair (需要修复)**.
4. Use `127.0.0.1` exactly. The server rejects other host names and browser origins on purpose.

If the agent reports `CAPABILITY_UNAVAILABLE`, the project-recognition hook could not deliver the project list. Check that the hook is installed in **Settings → Agents** and that `~/.precedent/bin/precedent-hook` exists.

## Knowledge is missing from recall

- **It is still a candidate.** Only accepted knowledge in the `asset` table is searchable.
- **It was deleted.** Deleted knowledge is filtered from recall, reads, Hub lists, overview, Used and related-knowledge validation. Deletion preserves historical operation records; there is no restore action.
- **Its workspace is no longer registered.** Check `config/workspaces.json` and the projects selected for the request.
- **The agent searched the wrong project.** Recall only covers the projects the agent chose. Adding aliases and a description in `workspaces.json` helps it pick correctly.
- **The query did not match.** Queries are literal substrings. Exact names — file names, symbols, domain terms — work best.

## Storage cannot be opened

The database no longer uses `user_version`. `DATABASE_SCHEMA_INVALID` means the database or a required table is missing. When opening an existing database containing the `asset` table for writing, the server automatically adds missing tables, columns, indexes and full-text index structure, rebuilding the derived full-text index when needed. This preserves existing data; changes to existing columns or constraints require separate handling. Read-only connections only check required tables. Empty databases require explicit `init-database --offline`; startup and app updates do not initialize them. Do not initialize over an existing schema or change `user_version` to try to repair it.

The desktop app recognizes initialized data by its valid `.precedentloop.json` marker and a valid SQLite header with a positive schema cookie (the schema change counter). A marker with a missing database or a schema cookie of 0 is incomplete; use Setup's explicit initialization for a new, empty database. An invalid SQLite header is unsupported. See [Configuration](configuration.md#data-folder) for recognition rules.

## Full-text index needs rebuilding

Acceptance maintains `asset_fts` in the same transaction as the original content. If the FTS rows are inconsistent, quit the app, stop other database users and back up the data folder before maintenance. Use SQLite with FTS5 trigram support and open the existing database in read/write mode:

```bash
sqlite3 'file:/absolute/path/to/data/runtime/precedent-loop.sqlite?mode=rw' <<'SQL'
.bail on
BEGIN IMMEDIATE;
DELETE FROM asset_fts;
INSERT INTO asset_fts (asset_id, title, summary, body_markdown)
SELECT asset_id, title, summary, body_markdown
FROM asset WHERE is_deleted = 0;
INSERT INTO asset_fts(asset_fts) VALUES('integrity-check');
COMMIT;
SQL
```

This recreates the searchable rows from the original `asset` content. It preserves knowledge, previous content, candidates, numbering and operation records. A failure exits before commit and rolls the transaction back. Restart the app after the check succeeds.

The database is the sole original. Deleting it loses knowledge as well as candidates and history; initialization cannot recover them. Index maintenance does not restore logically deleted knowledge.

## A write is blocked

- **`VERSION_CONFLICT`** — the candidate or formal knowledge changed after it was read. Read the latest version and review again.
- **`REVISION_BLOCKED`** — the knowledge already has a pending or deferred candidate. Merge same-topic changes into that candidate, or accept/reject it before preparing another revision. The blocked attempt writes no content or receipt.
- **`ASSET_HAS_OPEN_CANDIDATE`** — knowledge deletion is blocked by a pending or deferred candidate. Accept or reject that candidate first.

## Building from source fails

- **Wrong Node or pnpm version** — use exactly Node.js `24.21.0` and pnpm `11.1.3`. Without switching your global versions:

  ```bash
  npx -y -p node@24.21.0 -p pnpm@11.1.3 pnpm install --frozen-lockfile
  ```

- **`--frozen-lockfile` fails** — make sure you are in the repository root and `pnpm-lock.yaml` has not been modified. Do not fall back to a non-frozen install.
- **`better-sqlite3` fails to load** — confirm the Node version, then reinstall. Only macOS on Apple Silicon has been verified.

## Reporting a problem

Use **Settings → Advanced → Export diagnostics** to save a JSON file with configuration, runtime and integration status, and a filtered excerpt of the logs. It does not include knowledge content, prompts or AI input and output.

Attach it to a [GitHub issue](https://github.com/hemuzzz/PrecedentLoop/issues) with the steps that led to the problem.
