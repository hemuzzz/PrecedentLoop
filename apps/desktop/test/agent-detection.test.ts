import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentSearchDirectories, detectAgent, parseAgentLogin, parseAgentVersion } from "../src/agent-detection.js";

async function cli(directory: string, name: string, login: string, versionExit = 0): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/commands"
printf '%s\\n' "$PATH" > "$HOME/child-path"
case "$*" in
  --version) printf '%s\\n' '${name} 1.2.3'; exit ${versionExit} ;;
  'login status'|'auth status --json') printf '%s\\n' '${login}'; exit 0 ;;
  *) printf '%s\\n' 'FORBIDDEN COMMAND' >> "$HOME/forbidden"; exit 42 ;;
esac
`, { mode: 0o755 });
  return file;
}
test("agent search order preserves PATH before fallback directories and ignores relative PATH entries", () => {
  assert.deepEqual(agentSearchDirectories("/first:/second:/first:relative::/opt/homebrew/bin", "/isolated/home"), [
    "/first", "/second", "/opt/homebrew/bin", "/usr/local/bin", "/isolated/home/.local/bin", "/isolated/home/.npm-global/bin", "/isolated/home/.volta/bin", "/isolated/home/.bun/bin",
  ]);
});
test("version and login parsers only extract permitted fields", () => {
  assert.equal(parseAgentVersion("codex-cli 0.160.0\nprivate@example.com"), "0.160.0");
  assert.equal(parseAgentVersion("no version"), undefined);
  assert.equal(parseAgentLogin("codex", "Logged in using ChatGPT\nEmail: secret@example.com", 0), "logged-in");
  assert.equal(parseAgentLogin("codex", "prefix Logged in", 0), "unverified");
  assert.equal(parseAgentLogin("codex", "Not logged in", 0), "logged-out");
  assert.equal(parseAgentLogin("codex", "Logged in", 1), "logged-out");
  assert.equal(parseAgentLogin("claude", '{"loggedIn":true,"email":"secret@example.com","organization":"hidden"}', 0), "logged-in");
  assert.equal(parseAgentLogin("claude", '{"loggedIn":false}', 0), "logged-out");
  for (const output of ["broken", '{"loggedIn":"true"}', "null"]) assert.equal(parseAgentLogin("claude", output, 0), "unverified");
});
test("temporary CLIs establish manual precedence, allowed commands, bounded environment and sanitized results", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-agent-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), manual = join(root, "manual");
    await cli(first, "codex", "Logged in using ChatGPT: secret@example.com");
    await cli(second, "codex", "Not logged in");
    const manualPath = await cli(manual, "codex", "Not logged in");
    const options = { home: root, directories: [first, second] };
    const auto = await detectAgent("codex", null, options);
    assert.equal(auto.path, join(first, "codex")); assert.equal(auto.version, "1.2.3"); assert.equal(auto.login, "logged-in");
    assert.doesNotMatch(JSON.stringify(auto), /secret|example|ChatGPT/);
    const selected = await detectAgent("codex", manualPath, options);
    assert.equal(selected.source, "manual"); assert.equal(selected.path, manualPath); assert.equal(selected.login, "logged-out");
    assert.equal(await readFile(join(root, "child-path"), "utf8"), `${manual}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\n`);
    await cli(first, "claude", '{"loggedIn":true,"email":"secret@example.com","organization":"hidden"}');
    const claude = await detectAgent("claude", null, options);
    assert.equal(claude.login, "logged-in"); assert.doesNotMatch(JSON.stringify(claude), /secret|organization|hidden|email/);
    assert.deepEqual((await readFile(join(root, "commands"), "utf8")).trim().split("\n"), ["--version", "login status", "--version", "login status", "--version", "auth status --json"]);
    await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
    await chmod(manualPath, 0o600);
    const nonExecutable = await detectAgent("codex", manualPath, options);
    assert.equal(nonExecutable.runnable, false); assert.equal(nonExecutable.path, manualPath); assert.equal(nonExecutable.found, true);
    const missing = await detectAgent("claude", null, { home: root, directories: [second] });
    assert.equal(missing.found, false); assert.equal(missing.runnable, false);
    const fallback = await detectAgent("codex", null, { home: root, directories: [manual, second] });
    assert.equal(fallback.path, join(second, "codex"));
    const failing = await cli(join(root, "failing"), "codex", "secret@example.com", 3);
    const failed = await detectAgent("codex", failing, options);
    assert.equal(failed.runnable, false); assert.doesNotMatch(JSON.stringify(failed), /secret@example/);
    assert.equal((await readFile(join(root, "commands"), "utf8")).trim().split("\n").at(-1), "--version");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("version command has a five-second timeout and never proceeds to authentication after timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-agent-timeout-"));
  try {
    const file = join(root, "codex");
    await writeFile(file, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/commands"\nexec /bin/sleep 8\n', { mode: 0o755 });
    const started = Date.now();
    const result = await detectAgent("codex", file, { home: root, directories: [] });
    assert.equal(result.runnable, false); assert.match(result.reason!, /超时/);
    assert.ok(Date.now() - started < 7500);
    assert.equal(await readFile(join(root, "commands"), "utf8"), "--version\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
