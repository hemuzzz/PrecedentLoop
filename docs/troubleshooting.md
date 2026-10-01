# Troubleshooting

Start with **System status (系统状态)** in the Hub: it shows whether the index is ready and lists any files or settings that could not be used. Logs are in `<data folder>/logs/` (`server.log`, `desktop.log`).

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

- **It is still a candidate.** Only accepted knowledge in `assets/` is searchable.
- **The file was skipped.** Invalid front matter, a scope or project that does not match the folder, a duplicate `id`, a symlink, or a project that is not registered. System status lists each skipped file with the reason. See [Knowledge format](knowledge-format.md#file-format).
- **The agent searched the wrong project.** Recall only covers the projects the agent chose. Adding aliases and a description in `workspaces.json` helps it pick correctly.
- **The query did not match.** Queries are literal substrings. Exact names — file names, symbols, domain terms — work best.

## Index needs rebuilding

**`DEGRADED`** — the last consistent index may still be in place, but search and reads refuse anything that cannot be re-validated against the current files. Fix the cause shown in System status; the index catches up automatically, or after a restart.

**`REBUILD_REQUIRED`** — the search index must be rebuilt. Quit the app and make sure nothing else uses the database, then run from a source checkout:

```bash
PRECEDENT_LOOP_ASSET_REPOSITORY_PATH='/absolute/path/to/data/repository' \
PRECEDENT_LOOP_DATABASE_PATH='/absolute/path/to/data/runtime/precedent-loop.sqlite' \
PRECEDENT_LOOP_WORKSPACES_PATH='/absolute/path/to/data/config/workspaces.json' \
pnpm --filter @precedent-loop/server rebuild-index --offline
```

`--offline` is your confirmation that nothing else is writing. The command rebuilds only the search index in a single transaction and keeps version history, usage records and capabilities. On failure it rolls back. Start the app again afterwards.

Do not move or delete the database to "reset" the index. Losing the database loses version history and usage records, which cannot be rebuilt from the Markdown files.

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
