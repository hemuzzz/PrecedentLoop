import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const CAPTURE_CACHE_ENV = "PRECEDENT_LOOP_CAPTURE_CACHE_PATH";
export const CAPTURE_COMMAND_ENV = "PRECEDENT_LOOP_CAPTURE_COMMAND";
export const ASSESSMENT_MAX_BYTES = 8192;
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const turnIdentitySchema = z.object({ sessionId: identity, turnId: identity });
export type TurnIdentity = z.infer<typeof turnIdentitySchema>;
const assessmentSchema = turnIdentitySchema.extend({
  outcome: z.enum(["SKIPPED", "NO_INCREMENT", "CANDIDATE", "FAILED"]),
  reason: z.string().trim().min(1).max(2000),
  references: z.array(z.string().trim().min(1).max(1024)).max(16).optional(),
}).strict().refine(value => value.outcome !== "CANDIDATE" || !!value.references?.length, {
  message: "CANDIDATE requires a candidate or read-only suggestion reference",
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type CaptureHookOutput = { systemMessage?: string };
export type HookHost = "codex" | "claude";

export function hostTurnIdentity(input: unknown, host: HookHost = "codex"): TurnIdentity {
  if (host === "claude") {
    const event = z.object({ session_id: identity, prompt_id: identity }).parse(input);
    return { sessionId: event.session_id, turnId: event.prompt_id };
  }
  const event = z.object({ session_id: identity, turn_id: identity }).parse(input);
  return { sessionId: event.session_id, turnId: event.turn_id };
}

export function assessmentDirectory(cachePath: string, turn: TurnIdentity, host: HookHost = "codex"): string {
  if (!isAbsolute(cachePath)) throw new Error("Absolute cache path required");
  const checked = turnIdentitySchema.parse(turn);
  const key = createHash("sha256").update(JSON.stringify([checked.sessionId, checked.turnId])).digest("hex");
  // Preserve Codex's existing cache keys; the other host cannot share its declarations.
  return host === "codex" ? join(cachePath, key) : join(cachePath, host, key);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function markOnce(directory: string, name: string): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const file = await open(join(directory, name), "wx", 0o600);
    await file.close();
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

// Bounded regular-file reads keep malformed local records out of the model context.
async function readSmallFile(path: string, limit: number): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw new Error("Regular file required");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Record too large");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}

export async function recordAssessment(cachePath: string, input: unknown, host: HookHost = "codex"): Promise<void> {
  const assessment = assessmentSchema.parse(input);
  const bytes = JSON.stringify(assessment) + "\n";
  if (Buffer.byteLength(bytes) > ASSESSMENT_MAX_BYTES) throw new Error("Assessment too large");
  const directory = assessmentDirectory(cachePath, assessment, host);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.assessment-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await rename(temporary, join(directory, "assessment.json"));
  } finally {
    await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}

export const CHECK_UNAVAILABLE = "Precedent Loop：知识评估检查不可用（标识、缓存或输入异常）；本轮允许结束，未判定无增量。";

export async function handleCaptureHook(input: unknown, cachePath: string, host: HookHost = "codex", onError?: (error: unknown) => void): Promise<CaptureHookOutput> {
  let directory: string | undefined;
  try {
    const event = z.object({ hook_event_name: z.enum(["PostToolUse", "Stop"]) }).parse(input);
    const turn = hostTurnIdentity(input, host);
    directory = assessmentDirectory(cachePath, turn, host);
    if (event.hook_event_name === "PostToolUse") {
      const { tool_name } = z.object({ tool_name: z.string() }).parse(input);
      const tools = host === "codex" ? ["Bash", "apply_patch"] : ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];
      if (tools.includes(tool_name)) await markOnce(directory, "activity.flag");
      return {};
    }
    let warning: string | undefined;
    const bytes = await readSmallFile(join(directory, "assessment.json"), ASSESSMENT_MAX_BYTES);
    if (bytes === null) {
      if (await readSmallFile(join(directory, "activity.flag"), 0) === null) return {};
      warning = "本轮观察到工程相关工具活动，但未找到知识评估记录。";
    } else {
      let assessment: Assessment | undefined;
      try { assessment = assessmentSchema.parse(JSON.parse(bytes)); } catch { /* Invalid declarations are warnings, never NO_INCREMENT. */ }
      if (!assessment || assessment.sessionId !== turn.sessionId || assessment.turnId !== turn.turnId) {
        warning = "本轮知识评估记录无效或身份不符。";
      } else if (assessment.outcome === "FAILED") {
        warning = `本轮知识评估未完成：${assessment.reason.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240)}`;
      } else return {};
    }
    return await markOnce(directory, "warned.flag")
      ? { systemMessage: `Precedent Loop：${warning} 本轮允许结束，不自动补跑。` } : {};
  } catch (error) {
    // Missing host identity retains the existing nonblocking "check unavailable" path.
    if (directory) onError?.(error);
    if (directory) {
      try { if (!await markOnce(directory, "warned.flag")) return {}; } catch { /* Storage failure cannot guarantee deduplication. */ }
    }
    return { systemMessage: CHECK_UNAVAILABLE };
  }
}
