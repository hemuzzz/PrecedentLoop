import { CandidateService } from "./candidate-service.js";
import type { AssetConfirmationInput, AssetConfirmationOptions, AssetConfirmationResult } from "./confirmation.js";

/** The path-based command and Hub acceptance share one transaction boundary. */
export async function confirmVersionedInboxAsset(
  input: AssetConfirmationInput, options: AssetConfirmationOptions,
): Promise<AssetConfirmationResult> {
  return new CandidateService(options).confirmPath(input);
}
