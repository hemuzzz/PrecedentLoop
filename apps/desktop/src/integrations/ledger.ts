import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, json, readText } from "./files.js";

const trustSchema = z.object({ key: z.string(), before: z.string().nullable(), accepted: z.string().nullable() }).strict();
const artifactSchema = z.object({
  target: z.string(), kind: z.enum(["file", "directory", "hook", "command"]), hash: z.string(),
  owners: z.array(z.string()), installedAt: z.string(), backups: z.array(z.string()),
  trust: z.array(trustSchema).nullable(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1), artifacts: z.record(z.string(), artifactSchema),
  failures: z.record(z.string(), z.object({ at: z.string(), reason: z.string() }).strict()),
}).strict();
export type LedgerArtifact = z.infer<typeof artifactSchema>;
export type Ledger = z.infer<typeof ledgerSchema>;
export type TrustSnapshot = z.infer<typeof trustSchema>;
export async function readLedger(userData: string): Promise<Ledger> {
  const content = await readText(join(userData, "integrations.json"));
  if (content === null) return { version: 1, artifacts: {}, failures: {} };
  try {
    const ledger = ledgerSchema.parse(JSON.parse(content));
    for (const [id, artifact] of Object.entries(ledger.artifacts)) {
      if (/:(?:skill:|protocol$|reference:)/u.test(id)) { delete ledger.artifacts[id]; continue; }
      artifact.owners = artifact.owners.filter(owner => !owner.endsWith(":skills"));
    }
    for (const key of Object.keys(ledger.failures)) if (key.endsWith(":skills")) delete ledger.failures[key];
    return ledger;
  }
  catch { throw new Error("集成账本无法解析，已保留原文件。请先恢复账本。"); }
}
export async function writeLedger(userData: string, ledger: Ledger): Promise<void> {
  const next = ledgerSchema.parse(ledger);
  // Retired artifacts are ignored by the engine, but reading/writing the active
  // ledger must never become an implicit cleanup of a user's old installation.
  const previous = await readText(join(userData, "integrations.json"));
  if (previous !== null) {
    const old = ledgerSchema.parse(JSON.parse(previous));
    for (const [id, artifact] of Object.entries(old.artifacts)) {
      if (/:(?:skill:|protocol$|reference:)/u.test(id)) next.artifacts[id] = artifact;
    }
    for (const [key, failure] of Object.entries(old.failures)) if (key.endsWith(":skills")) next.failures[key] = failure;
  }
  await atomicWrite(join(userData, "integrations.json"), json(next), 0o600);
}
