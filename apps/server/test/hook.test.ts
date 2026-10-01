import { initializeDatabase } from "../src/storage/schema.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import Database from "better-sqlite3";

import {
  HOOK_ASSET_REPOSITORY_PATH_ENV,
  HOOK_DATABASE_PATH_ENV,
  HOOK_WORKSPACE_CONFIG_PATH_ENV,
  createUserPromptSubmitHookConfiguration,
} from "../src/hook/user-prompt-submit.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { WorkspaceCapabilityService } from "../src/workspace/capability.js";
import { LOG_PATH_ENV } from "../src/logging.js";

const hookSourcePath = fileURLToPath(new URL("../src/hook/user-prompt-submit.ts", import.meta.url));

test("N06 Hook configuration targets only UserPromptSubmit and matches the current command-hook shape", async () => {
  const fixture = await createFixture();
  try {
    const configuration = createUserPromptSubmitHookConfiguration(
      "node /opt/precedent-loop/apps/server/dist/hook/user-prompt-submit.js",
    );
    const configurationPath = join(fixture.rootPath, "hooks.json");
    await writeFile(configurationPath, JSON.stringify(configuration), "utf8");
    const parsed = JSON.parse(await readText(configurationPath)) as typeof configuration;

    assert.deepEqual(Object.keys(parsed.hooks), ["UserPromptSubmit"]);
    assert.deepEqual(parsed.hooks.UserPromptSubmit[0]?.hooks[0], {
      type: "command",
      command: "node /opt/precedent-loop/apps/server/dist/hook/user-prompt-submit.js",
      timeout: 10,
      additionalContextLimit: 8000,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("N06 UserPromptSubmit Hook emits only trusted capability context and persists no conversation history", async () => {
  const fixture = await createFixture();
  try {
    const prompt = "implement the private N06 hook field";
    const result = await runHook(
      {
        session_id: "hook-session",
        turn_id: "hook-turn",
        cwd: fixture.workspacePath,
        hook_event_name: "UserPromptSubmit",
        prompt,
        transcript_path: "/tmp/private-transcript.jsonl",
        messages: [{ role: "user", content: "must-not-persist" }],
        conversation_history: "must-not-persist",
      },
      fixture,
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const capabilities = parseCapabilities(result.stdout);
    assert.deepEqual(capabilities.map(({ workspace }) => workspace), ["alpha", "beta"]);
    assert.match(capabilities[0]!.capabilityId, /^cap_[A-Za-z0-9_-]{43}$/u);
    assert.equal(result.stdout.includes(prompt), false);
    assert.equal(result.stdout.includes("must-not-persist"), false);
    assert.equal(result.stdout.includes("private-transcript"), false);

    const database = new Database(fixture.databasePath, { readonly: true });
    try {
      const rows = database.prepare("SELECT * FROM workspace_capability").all() as Array<{ capability_key_hash: string; workspace: string }>;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.workspace).sort(), ["alpha", "beta"]);
      // Only a digest of the opaque capability is stored, never the bearer value.
      assert.match(rows[0]!.capability_key_hash, /^[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(rows).includes(capabilities[0]!.capabilityId), false);
      const serializedRows = JSON.stringify(Object.fromEntries(tables(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}"`).all()])));
      for (const privateText of [prompt, "must-not-persist", "private-transcript", "hook-session", "hook-turn"]) {
        assert.equal(serializedRows.includes(privateText), false, privateText);
      }
      for (const table of ["recall_operation", "read_operation", "used_event"]) assert.equal(count(database, table), 0);
    } finally {
      database.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("N06 concurrent Hook processes each atomically issue distinct usable capabilities", async () => {
  const fixture = await createFixture();
  try {
    const input = {
      session_id: "retry-session",
      turn_id: "retry-turn",
      cwd: fixture.workspacePath,
      hook_event_name: "UserPromptSubmit",
      prompt: "same Hook event",
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => runHook(input, fixture)));
    assert.deepEqual(results.map(({ code }) => code), [0, 0, 0, 0, 0, 0]);
    assert.ok(results.every(({ stderr }) => stderr === ""));
    const issued = results.map(({ stdout }) => parseCapabilities(stdout));
    assert.ok(issued.every((list) => list.map((item) => item.workspace).join() === "alpha,beta"));
    const ids = issued.map((list) => list[0]!.capabilityId);
    assert.equal(new Set(ids).size, 6);

    const database = new Database(fixture.databasePath, { readonly: true });
    try {
      assert.equal(count(database, "workspace_capability"), 12);
    } finally {
      database.close();
    }
    const repository = new KnowledgeRepository(fixture.databasePath);
    try {
      const service = new WorkspaceCapabilityService(repository, fixture.workspaceConfigPath);
      for (const id of ids) assert.deepEqual((await service.select([id])).authorizedWorkspaces, ["alpha"]);
    } finally {
      repository.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("N06 Hook offers every registered project with the cwd project first; each capability still names exactly one project", async () => {
  const fixture = await createFixture();
  try {
    const issue = async (cwd: string, turn: string) => {
      const result = await runHook({ session_id: "scope-session", turn_id: turn, cwd, hook_event_name: "UserPromptSubmit", prompt: "scope" }, fixture);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      return parseCapabilities(result.stdout);
    };
    const alpha = await issue(join(fixture.workspacePath, "nested"), "alpha-turn");
    const beta = await issue(fixture.otherWorkspacePath, "beta-turn");
    const outside = await issue(fixture.unmatchedPath, "outside-turn");
    assert.deepEqual(alpha.map(({ workspace }) => workspace), ["alpha", "beta"]);
    assert.deepEqual(beta.map(({ workspace }) => workspace), ["beta", "alpha"]);
    assert.deepEqual(outside.map(({ workspace }) => workspace), ["alpha", "beta"]);

    const repository = new KnowledgeRepository(fixture.databasePath);
    try {
      const service = new WorkspaceCapabilityService(repository, fixture.workspaceConfigPath);
      assert.deepEqual((await service.select([beta[0]!.capabilityId])).authorizedWorkspaces, ["beta"]);
      assert.deepEqual((await service.select([])).authorizedWorkspaces, []);
      // A capability names its project; cwd or model input never widens it.
      await assert.rejects(service.select([`${alpha[0]!.capabilityId.slice(0, -1)}${alpha[0]!.capabilityId.endsWith("A") ? "B" : "A"}`]), { code: "CAPABILITY_INVALID" });
    } finally {
      repository.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("F05 Hook returns nonblocking exit 0 for malformed input and invalid Workspace config without creating a database", async () => {
  const fixture = await createFixture({ initializeDatabase: false });
  try {
    const malformed = await runHookSource("{not-json", fixture);
    assert.equal(malformed.code, 0);
    assert.match(malformed.stderr, /CAPABILITY_UNAVAILABLE/u);
    assert.doesNotMatch(malformed.stderr, /SyntaxError|stack/u);
    assert.equal(malformed.stdout, "");

    await writeFile(fixture.workspaceConfigPath, JSON.stringify({ schemaVersion: 2, workspaces: [] }), "utf8");
    const invalidConfig = await runHook(
      {
        session_id: "invalid-config-session",
        turn_id: "invalid-config-turn",
        cwd: fixture.workspacePath,
        hook_event_name: "UserPromptSubmit",
        prompt: "must fail closed",
      },
      fixture,
    );
    assert.equal(invalidConfig.code, 0);
    const context = parseContext(invalidConfig.stdout);
    assert.match(context, /CAPABILITY_UNAVAILABLE/u);
    assert.doesNotMatch(context, /Precedent Loop WorkspaceCapability\n/u);
    // The optional Hook never creates or migrates the knowledge database.
    await assert.rejects(() => readText(fixture.databasePath));
  } finally {
    await fixture.cleanup();
  }
});

test("N06 Stop, Interrupt, and SessionEnd inputs neither emit context nor issue capabilities", async () => {
  const fixture = await createFixture();
  try {
    for (const hookEventName of ["Stop", "Interrupt", "SessionEnd"]) {
      const result = await runHook(
        {
          session_id: "lifecycle-session",
          turn_id: "lifecycle-turn",
          cwd: fixture.workspacePath,
          hook_event_name: hookEventName,
        },
        fixture,
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }

    const database = new Database(fixture.databasePath, { readonly: true });
    try {
      assert.equal(count(database, "workspace_capability"), 0);
    } finally {
      database.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

interface Fixture {
  cleanup: () => Promise<void>;
  databasePath: string;
  otherWorkspacePath: string;
  rootPath: string;
  repositoryPath: string;
  unmatchedPath: string;
  workspaceConfigPath: string;
  workspacePath: string;
}

interface HookProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

interface IssuedCapability {
  capabilityId: string;
  workspace: string;
}

async function createFixture(options: { initializeDatabase?: boolean } = {}): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "precedent-loop-n06-hook-"));
  const workspacePath = join(rootPath, "alpha");
  const otherWorkspacePath = join(rootPath, "beta");
  const unmatchedPath = join(rootPath, "outside");
  const workspaceConfigPath = join(rootPath, "workspaces.json");
  await writeFile(
    workspaceConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { name: "alpha", paths: [workspacePath] },
        { name: "beta", paths: [otherWorkspacePath] },
      ],
    }),
    "utf8",
  );
  const databasePath = join(rootPath, "data", "precedent-loop.sqlite");
  if (options.initializeDatabase !== false) {
    await mkdir(join(rootPath, "data"), { recursive: true });
    initializeDatabase(databasePath);
  }
  return {
    rootPath,
    repositoryPath: join(rootPath, "repository"),
    workspacePath,
    otherWorkspacePath,
    unmatchedPath,
    workspaceConfigPath,
    databasePath,
    cleanup: () => rm(rootPath, { force: true, recursive: true }),
  };
}

async function runHook(input: unknown, fixture: Fixture): Promise<HookProcessResult> {
  return runHookSource(JSON.stringify(input), fixture);
}

async function runHookSource(source: string, fixture: Fixture): Promise<HookProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", hookSourcePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [HOOK_ASSET_REPOSITORY_PATH_ENV]: fixture.repositoryPath,
        [HOOK_DATABASE_PATH_ENV]: fixture.databasePath,
        [HOOK_WORKSPACE_CONFIG_PATH_ENV]: fixture.workspaceConfigPath,
        [LOG_PATH_ENV]: join(fixture.rootPath, "logs", "precedent-loop.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(source);
  });
}

function parseContext(stdout: string): string {
  const output = JSON.parse(stdout) as {
    hookSpecificOutput: { additionalContext: string; hookEventName: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return output.hookSpecificOutput.additionalContext;
}

function parseCapabilities(stdout: string): IssuedCapability[] {
  const marker = "Precedent Loop WorkspaceCapability\n";
  const context = parseContext(stdout);
  assert.ok(context.includes(marker), "Hook must deliver a successful capability list");
  return JSON.parse(context.split(marker)[1]!.split("\n")[0]!) as IssuedCapability[];
}

function tables(database: Database.Database): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(({ name }) => name);
}

function count(database: Database.Database, table: string): number {
  return Number((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
