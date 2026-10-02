import { RepositoryOperationError } from "./errors.js";
import type { CandidateTarget } from "./candidate-service.js";
import type { AssetRecord } from "./asset-repository.js";
import type { StructuredContent } from "./structured-candidate.js";

export class StructuredCandidateError extends RepositoryOperationError {
  constructor(code: string, readonly field: string) { super(code, `${code}: ${field}`); }
}
export function checkRelatedAssets(related: Array<{ assetId: string; relation: string }>, target: CandidateTarget, assets: AssetRecord[]) {
  return related.map((item, index) => {
    const asset = assets.find(asset => asset.assetId === item.assetId);
    if (!asset || (asset.scope !== "GLOBAL" && (target.scope !== "WORKSPACE" || asset.workspace !== target.workspace))) {
      throw new StructuredCandidateError("RELATED_ASSET_INVALID", `related.${index}.assetId`);
    }
    return { ...item, title: asset.title };
  });
}
export function checkStructuredContent(input: (StructuredContent & { related?: Array<{ assetId: string; relation: string }> | undefined }) | { title: string; summary: string; bodyMarkdown: string }): void {
  const secrets = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\b(?:ghp_|github_pat_)[A-Za-z0-9_]+|\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}|\bxox[abpr]-[A-Za-z0-9-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/iu;
  const credentialAssignments = /\b(?:password|secret|token)["']?\s*[:=]\s*(["'])([^\r\n]*?)\1|\b(?:password|secret|token)\s*=\s*([^\s"',;}{]+)/giu;
  const scan = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      const literalSecret = [...value.matchAll(credentialAssignments)].some(match => {
        const literal = match[2] ?? match[3]!;
        if (literal.length < 8 || /[<>]|^(?:\*+|x+|string|number|boolean|undefined|null)$/iu.test(literal)
          || /[()[\]{}]|\bprocess\.env\.|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(literal)) return false;
        // Quoted values are literals; bare identifiers are code references.
        return match[2] !== undefined || !/^[A-Za-z_$][\w$]*$/u.test(literal);
      });
      if (secrets.test(value) || literalSecret) throw new StructuredCandidateError("CONTENT_CONTAINS_SECRET", field);
    }
    if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${field}.${index}`));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) scan(item, field ? `${field}.${key}` : key);
  };
  scan(input, "");
  const core = !("type" in input) ? { bodyMarkdown: input.bodyMarkdown }
    : input.type === "MEMORY" ? { conclusion: input.conclusion, reasons: input.reasons }
    : input.type === "SKILL" ? { steps: input.steps } : { purpose: input.purpose };
  for (const [field, value] of Object.entries(core)) {
    if (value === undefined) continue;
    const remaining = (Array.isArray(value) ? value.join(" ") : value)
      .replace(/(?:https?:\/\/|file:\/\/)[^\s<>）)]+/giu, "")
      // 普通相对路径仅匹配 ASCII，避免将“表/接口”等中文自然语言误判为路径。
      .replace(/(?<=^|[\s([{<"'`，。；：！？、（）【】《》“”‘’,.;:!?])(?:(?:[A-Za-z]:[\\/]|(?:~|\.\.?)[\\/]|[\\/])[\p{L}\p{N}_.$@%+~=/\\-]*|[A-Za-z0-9_.$@%+=-]+[\\/][A-Za-z0-9_.$@%+~=/\\-]*)(?=$|[\s)\]}>"'`，。；：！？、（）【】《》“”‘’,.;:!?#])/gu, "")
      .replace(/\b[\w.-]+\.(?:md|ts|js|json|yaml|yml|java|py|txt)(?::\d+)?/gu, "")
      .replace(/(?:[:#]L?\d+(?:[-:]L?\d+)?|第?\d+[-–]?\d*行)/gu, "").replace(/\s/gu, "");
    if ([...remaining].length < 20) throw new StructuredCandidateError("CONTENT_DEPENDS_ON_LINKS", field);
  }
}
