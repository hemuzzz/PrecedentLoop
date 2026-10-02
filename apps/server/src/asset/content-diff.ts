import { displayContent } from "./candidate-service.js";
import type { AssetSearchService } from "./search.js";

export const DIFF_LIMITS = {
  inputBytes: 1024 * 1024, inputLines: 2000,
  workUnits: 1_000_000, outputLines: 4000, outputBytes: 8 * 1024 * 1024,
} as const;
export type DiffFailureStatus = "NO_PREVIOUS_VERSION" |
  "UNSUPPORTED_ENCODING" | "INPUT_LIMIT_EXCEEDED" | "WORK_LIMIT_EXCEEDED" | "OUTPUT_LIMIT_EXCEEDED";
export interface DiffLine { kind: "context" | "add" | "delete"; text: string; eol: "LF" | "CRLF" | "CR" | "NONE" }
export interface DiffHunk { oldStart: number; newStart: number; oldCount: number; newCount: number; lines: DiffLine[] }
export interface DiffVersionMetadata { version: number; recordedAt: string; hasUtf8Bom: boolean }
interface ContentVersion { rawContent: Buffer; version: number; recordedAt: string }
export type AssetDiffResult = { assetId: string; status: DiffFailureStatus } | {
  assetId: string; status: "AVAILABLE";
  previous: DiffVersionMetadata; current: DiffVersionMetadata; hasChanges: boolean; hunks: DiffHunk[];
};
type Line = Omit<DiffLine, "kind">;

export class AssetDiffService {
  constructor(readonly assets: Pick<AssetSearchService, "readLibrary">) {}
  async get(assetId: string): Promise<AssetDiffResult> {
    const asset = await this.assets.readLibrary(assetId);
    if (!asset.previousContent) return { assetId, status: "NO_PREVIOUS_VERSION" };
    return compareContentVersions(assetId,
      { rawContent: Buffer.from(displayContent(asset.previousContent)), recordedAt: asset.previousContent.updatedAt, version: Math.max(0, asset.version - 1) },
      { rawContent: Buffer.from(displayContent(asset)), recordedAt: asset.updatedAt, version: asset.version });
  }
}

export function compareContentVersions(
  assetId: string, previous: ContentVersion, current: ContentVersion,
  limits: Readonly<{ inputBytes: number; inputLines: number; workUnits: number; outputLines: number; outputBytes: number }> = DIFF_LIMITS,
): AssetDiffResult {
  const failure = (status: DiffFailureStatus): AssetDiffResult => ({ assetId, status });
  if (previous.rawContent.length > limits.inputBytes || current.rawContent.length > limits.inputBytes) return failure("INPUT_LIMIT_EXCEEDED");
  let oldText: string, newText: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    oldText = decoder.decode(previous.rawContent);
    newText = decoder.decode(current.rawContent);
  } catch (error) {
    if (error instanceof TypeError && "code" in error && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return failure("UNSUPPORTED_ENCODING");
    throw error;
  }
  const oldLines = splitLines(oldText, limits.inputLines);
  const newLines = splitLines(newText, limits.inputLines);
  if (!oldLines || !newLines) return failure("INPUT_LIMIT_EXCEEDED");
  const response: Extract<AssetDiffResult, { status: "AVAILABLE" }> = {
    assetId, status: "AVAILABLE",
    previous: metadata(previous), current: metadata(current),
    hasChanges: !previous.rawContent.equals(current.rawContent), hunks: [],
  };
  let outputCost = Buffer.byteLength(JSON.stringify({ ok: true, data: { diff: response } }));
  if (outputCost > limits.outputBytes) return failure("OUTPUT_LIMIT_EXCEEDED");
  if (!response.hasChanges) return response;

  // Intern complete text+EOL units once. Dynamic programming compares integers,
  // so long/repeated line strings cannot multiply work inside the quadratic loop.
  const interned = new Map<string, number>();
  const intern = (line: Line): number => {
    const key = JSON.stringify([line.text, line.eol]);
    let id = interned.get(key);
    if (id === undefined) { id = interned.size; interned.set(key, id); }
    return id;
  };
  const oldIds = oldLines.map(intern), newIds = newLines.map(intern);
  const width = newIds.length + 1;
  const requiredWork = oldIds.length * newIds.length + oldIds.length + newIds.length;
  if (requiredWork > limits.workUnits) return failure("WORK_LIMIT_EXCEEDED");
  const cells = new Uint16Array((oldIds.length + 1) * width);
  let work = 0;
  for (let i = oldIds.length - 1; i >= 0; i--) {
    for (let j = newIds.length - 1; j >= 0; j--) {
      if (++work > limits.workUnits) return failure("WORK_LIMIT_EXCEEDED");
      cells[i * width + j] = oldIds[i] === newIds[j]
        ? 1 + cells[(i + 1) * width + j + 1]!
        : Math.max(cells[(i + 1) * width + j]!, cells[i * width + j + 1]!);
    }
  }
  const hunk: DiffHunk = { oldStart: 1, newStart: 1, oldCount: oldLines.length, newCount: newLines.length, lines: [] };
  // One full-context hunk keeps the contract lossless and avoids hidden truncation.
  outputCost += Buffer.byteLength(JSON.stringify(hunk)) + 2;
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (++work > limits.workUnits) return failure("WORK_LIMIT_EXCEEDED");
    let line: DiffLine;
    if (i < oldLines.length && j < newLines.length && oldIds[i] === newIds[j]) {
      line = { kind: "context", ...oldLines[i++]! }; j++;
    } else if (j < newLines.length && (i === oldLines.length || cells[i * width + j + 1]! > cells[(i + 1) * width + j]!)) {
      line = { kind: "add", ...newLines[j++]! };
    } else { line = { kind: "delete", ...oldLines[i++]! }; }
    outputCost += Buffer.byteLength(JSON.stringify(line)) + 1;
    if (hunk.lines.length >= limits.outputLines || outputCost > limits.outputBytes) return failure("OUTPUT_LIMIT_EXCEEDED");
    hunk.lines.push(line);
  }
  response.hunks.push(hunk);
  if (Buffer.byteLength(JSON.stringify({ ok: true, data: { diff: response } })) > limits.outputBytes) return failure("OUTPUT_LIMIT_EXCEEDED");
  return response;
}

function splitLines(text: string, limit: number): Line[] | undefined {
  const lines: Line[] = [];
  let start = 0;
  for (let end = 0; end < text.length; end++) {
    const char = text[end];
    if (char !== "\r" && char !== "\n") continue;
    const crlf = char === "\r" && text[end + 1] === "\n";
    lines.push({ text: text.slice(start, end), eol: crlf ? "CRLF" : char === "\r" ? "CR" : "LF" });
    if (lines.length > limit) return undefined;
    if (crlf) end++;
    start = end + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "NONE" });
  return lines.length > limit ? undefined : lines;
}
function metadata(version: ContentVersion): DiffVersionMetadata {
  return { version: version.version, recordedAt: version.recordedAt,
    hasUtf8Bom: version.rawContent.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) };
}
