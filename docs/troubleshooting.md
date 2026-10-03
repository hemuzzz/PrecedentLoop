# Troubleshooting

Start with **System status (系统状态)** in the Hub: it shows the local service, knowledge and candidate counts, agent connections and any diagnostic codes. Logs are in `<data folder>/logs/` (`server.log`, `desktop.log`).

## The app won't open

**macOS says the app can't be opened or can't be verified.** The app is not signed or notarized by Apple. Click **Done**, then open **System Settings → Privacy & Security**, click **Open Anyway** next to the message about PrecedentLoop, and confirm with your password. If macOS says the app is *damaged*, remove the download quarantine flag and try again:

```bash
xattr -dr com.apple.quarantine /Applications/PrecedentLoop.app
```

An app you built yourself is not quarantined and opens without these steps.

**The recovery screen appears.** The app could not start normally — for example the configuration is damaged, the data folder is unavailable, or the folder is not recognized as Precedent Loop data. The screen tells you which; re-run the checks after fixing the cause, link another existing data folder, or open the log folder.

**The local server fails to start.** Usually another process is using the port. The app never takes over or kills other processes. Free the port, or choose another one in **Settings → Advanced**.

## The agent can't reach the knowledge base

1. Make sure the app is running (closing the window is fine; quitting is not).
2. Open `http://127.0.0.1:18888/health` in a browser (use your port if you changed it).
3. Check that the agent's MCP entry points to `http://127.0.0.1:<port>/mcp`. Re-apply the integration in **Settings → Agents** if it shows **Needs repair (需要修复)**.
4. Use `127.0.0.1` exactly. The server rejects other host names and browser origins on purpose.

If the agent reports `CAPABILITY_UNAVAILABLE`, the project-recognition hook could not deliver the project list. Check that the hook is installed in **Settings → Agents** and that `~/.precedent/bin/precedent-hook` exists. If you moved the app after connecting the agents, repair the integration so the hooks point to the new location.

## Knowledge is missing from recall

- **It is still a candidate.** Only accepted knowledge is searchable.
- **It was deleted.** Deleted knowledge is excluded from recall, reads, Hub lists and the overview. Its history is kept; there is no restore action.
- **Its workspace is no longer registered.** Check `config/workspaces.json` and the projects selected for the request.
- **The agent searched the wrong project.** Recall only covers the projects the agent chose. Adding aliases and a description in `workspaces.json` helps it pick correctly.
- **The query did not match.** Queries are literal substrings of the title, summary, retrieval terms or body. Exact names — file names, symbols, domain terms — work best. If the agent only found a precedent with different words, it can propose a revision that adds those words as retrieval terms.

## Storage cannot be opened

`DATABASE_SCHEMA_INVALID` means the database file or a required table is missing. A new, empty database must be initialized explicitly with `init-database --offline`, which Setup runs for a new folder; startup and app updates never initialize one. Do not run the initialization over an existing database — it refuses with `DATABASE_NOT_EMPTY`.

The desktop app recognizes initialized data by its `.precedentloop.json` marker and a valid SQLite header with a positive schema cookie. A marker with a missing database or a schema cookie of 0 means initialization is incomplete; Setup can resume it. An invalid SQLite header is unsupported. See [Configuration](configuration.md#data-folder) for the recognition rules.

## Full-text index needs rebuilding

Accepting a candidate updates `asset_fts` in the same transaction as the knowledge itself. If the index ever becomes inconsistent, quit the app, stop anything else using the database and back up the data folder. Then, with an SQLite build that supports FTS5 trigram, run:

```bash
sqlite3 'file:/absolute/path/to/data/runtime/precedent-loop.sqlite?mode=rw' <<'SQL'
.bail on
BEGIN IMMEDIATE;
DELETE FROM asset_fts;
INSERT INTO asset_fts (asset_id, title, summary, retrieval_terms, body_markdown)
SELECT asset_id, title, summary, retrieval_terms, body_markdown
FROM asset WHERE is_deleted = 0;
INSERT INTO asset_fts(asset_fts) VALUES('integrity-check');
COMMIT;
SQL
```

This recreates the index from the knowledge in the `asset` table and leaves knowledge, previous versions, candidates, numbers and operation records untouched. If any statement fails, nothing is committed. Restart the app afterwards.

The database is the only original copy. Deleting it loses knowledge, candidates and history; initialization cannot recover them.

## A write is blocked

- **`VERSION_CONFLICT`** — the candidate or the precedent changed after it was read. Read the latest version and review again.
- **`REVISION_BLOCKED`** — the precedent already has a pending or deferred candidate. The response includes that candidate's version and content; merge the change into it with `candidate_update`. Nothing is written by the blocked call.
- **`ASSET_HAS_OPEN_CANDIDATE`** — deleting a precedent is blocked by its pending or deferred candidate. Accept or reject that candidate first.

## Building from source fails

- **Wrong Node or pnpm version** — the versions are enforced. Use exactly Node.js `24.21.0` and pnpm `11.1.3`. Without switching your global versions:

  ```bash
  npx -y -p node@24.21.0 -p pnpm@11.1.3 pnpm install --frozen-lockfile
  ```

- **`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`** — after switching Node versions, pnpm wants to recreate `node_modules` and needs confirmation. Run `pnpm install --frozen-lockfile --config.confirmModulesPurge=false`.
- **`--frozen-lockfile` fails** — make sure you are in the repository root and `pnpm-lock.yaml` has not been modified. Do not fall back to a non-frozen install.
- **`better-sqlite3` fails to load** — confirm the Node version, then reinstall. Only macOS on Apple Silicon has been verified.

## Reporting a problem

Use **Settings → Advanced → Export diagnostics (导出诊断包)** to save a JSON file with configuration, runtime and integration status, and a filtered excerpt of the logs. It does not include knowledge content, prompts or AI input and output.

Attach it to a [GitHub issue](https://github.com/hemuzzz/PrecedentLoop/issues) with the steps that led to the problem.
