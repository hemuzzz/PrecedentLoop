import { randomBytes } from "node:crypto";
import { generateId as generateSnowflakeId, type SnowflakeOptions } from "snowflake.io";

export const ID_PREFIXES = ["ast", "tsk", "usg"] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export interface IdGenerator {
  next(prefix: IdPrefix): string;
  validate(id: string, expectedPrefix?: IdPrefix): boolean;
}

const ID_PATTERN = /^(ast|tsk|usg)[0-9]+$/;

const SNOWFLAKE_OPTIONS = {
  clockSkewHandler: "throw",
  id: 0,
} satisfies SnowflakeOptions;

export class SnowflakeIdGenerator implements IdGenerator {
  next(prefix: IdPrefix): string {
    // Snowflake's fixed node and sequence are process-local. Independent Hooks
    // can share the same timestamp/sequence; keep 128 random bits per ID so they
    // do not depend on coordinating node IDs. Preserve decimal string storage.
    const snowflake = generateSnowflakeId(SNOWFLAKE_OPTIONS);
    const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`);
    return `${prefix}${(BigInt(snowflake) << 128n) | nonce}`;
  }

  validate(id: string, expectedPrefix?: IdPrefix): boolean {
    if (!ID_PATTERN.test(id)) {
      return false;
    }

    return expectedPrefix === undefined || id.startsWith(expectedPrefix);
  }
}

/** Opaque bearer value; persist only its digest. */
export function generateWorkspaceCapability(): string {
  return `cap_${randomBytes(32).toString("base64url")}`;
}
