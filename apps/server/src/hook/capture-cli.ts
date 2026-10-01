import { pathToFileURL } from "node:url";
import { ASSESSMENT_MAX_BYTES, CAPTURE_CACHE_ENV, CHECK_UNAVAILABLE, handleCaptureHook, recordAssessment } from "./capture-assessment.js";

export async function runCaptureCli(): Promise<void> {
  const recording = process.argv[2] === "--record";
  // Leave margin inside the host's one-second timeout, including an unfinished stdin.
  const timeout = setTimeout(() => {
    if (recording) process.stderr.write("Precedent Loop: assessment recording timed out.\n");
    else process.stdout.write(JSON.stringify({ systemMessage: "Precedent Loop：知识评估检查超时；本轮允许结束。" }) + "\n");
    process.exit(recording ? 1 : 0);
  }, 750);
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      length += bytes.length;
      if (length > (recording ? ASSESSMENT_MAX_BYTES : 1_000_000)) throw new Error("Input too large");
      chunks.push(bytes);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const cachePath = process.env[CAPTURE_CACHE_ENV] ?? "";
    if (recording) {
      await recordAssessment(cachePath, input);
      process.stdout.write('{"recorded":true}\n');
    } else process.stdout.write(JSON.stringify(await handleCaptureHook(input, cachePath)) + "\n");
  } catch {
    if (recording) {
      process.stderr.write("Precedent Loop: assessment not recorded; check identity, outcome, reason, references and cache path.\nFormat: sessionId, turnId, outcome (NO_INCREMENT|CANDIDATE|FAILED|SKIPPED), reason, references (required for CANDIDATE).\n");
      process.exitCode = 1;
    } else process.stdout.write(JSON.stringify({ systemMessage: CHECK_UNAVAILABLE }) + "\n");
  } finally { clearTimeout(timeout); }
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) await runCaptureCli();
