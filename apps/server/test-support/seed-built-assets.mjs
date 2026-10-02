import { randomUUID } from "node:crypto";
import { openDatabase } from "../dist/storage/schema.js";
import { AssetRepository } from "../dist/asset/asset-repository.js";
import { CandidateRepository } from "../dist/asset/candidate-repository.js";

export function seedAssets(databasePath, assets) {
  const db = openDatabase(databasePath);
  try {
    const repository = new AssetRepository(db), writes = new CandidateRepository(db);
    writes.write(randomUUID(), "accept", "fixture", () => assets.map(asset => repository.insert(asset)));
  } finally { db.close(); }
}
