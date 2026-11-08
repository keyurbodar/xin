import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import type { ModelsService } from "../../src/contracts/models.ts"
import { CredentialStore } from "../../src/kernel/sealed.ts"
import { Sealer } from "../../src/seal.ts"

const MIN_SECRET_LENGTH = 4

export type SecretPort = {
  readonly db: SqliteDatabase
  readonly kek: string
  readonly models: Pick<ModelsService, "credentialSecrets">
}

export async function liveSecrets(port: SecretPort): Promise<readonly string[]> {
  const found = new Set<string>(await port.models.credentialSecrets())
  await addCredentialValues(port.db, new Sealer(port.kek), found)
  return [...found]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .toSorted((left, right) => right.length - left.length)
}

async function addCredentialValues(db: SqliteDatabase, sealer: Sealer, found: Set<string>): Promise<void> {
  const credentials = new CredentialStore(db, sealer)
  try {
    await credentials.load()
  } catch {
    return
  }
  for (const value of credentials.values()) found.add(value)
}
