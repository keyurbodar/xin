import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import type { ModuleDeps } from "../../src/module.ts"
import { PluginSecrets } from "../../src/kernel/sealed.ts"
import { Sealer } from "../../src/seal.ts"

const MIN_SECRET_LENGTH = 4

export async function liveSecrets(deps: ModuleDeps<"models">): Promise<readonly string[]> {
  const found = new Set<string>(await deps.services.models.credentialSecrets())
  await pluginSecrets(deps.db, new Sealer(deps.env.KEK), found)
  return [...found]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .toSorted((left, right) => right.length - left.length)
}

async function pluginSecrets(db: SqliteDatabase, sealer: Sealer, found: Set<string>): Promise<void> {
  const plugins = new PluginSecrets(db, sealer)
  try {
    await plugins.load()
  } catch {
    return
  }
  for (const value of plugins.values()) found.add(value)
}
