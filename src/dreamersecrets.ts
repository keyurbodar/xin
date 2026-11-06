import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { compile, map, obj, opt, str } from "@earendil-works/pi-schema"
import type { ModuleDeps } from "./module.ts"
import { PluginSecrets } from "./kernel/sealed.ts"
import { SealedSchema, Sealer } from "./seal.ts"

const MIN_SECRET_LENGTH = 4

const CredentialFields = obj(
  { key: opt(str()), refresh: opt(str()), access: opt(str()), env: opt(map(str())) },
  { open: true },
)
const CredentialEntrySchema = obj({ credential: CredentialFields }, { open: true })

const credentialCheck = compile(CredentialEntrySchema)
const sealedCheck = compile(SealedSchema)

export async function liveSecrets(deps: ModuleDeps): Promise<readonly string[]> {
  const sealer = new Sealer(deps.env.KEK)
  const found = new Set<string>()
  await credentialSecrets(deps.db, sealer, found)
  await pluginSecrets(deps.db, sealer, found)
  return [...found].toSorted((left, right) => right.length - left.length)
}

async function credentialSecrets(db: SqliteDatabase, sealer: Sealer, found: Set<string>): Promise<void> {
  const rows = await db.all<{ provider: string; sealed: string }>("SELECT provider, sealed FROM credentials")
  for (const row of rows) {
    const plain = await unseal(sealer, row.sealed, `credentials:${row.provider}`)
    if (plain === undefined) continue
    const entry: unknown = parse(plain)
    if (!credentialCheck.check(entry)) continue
    const credential = entry.credential
    for (const value of [credential.key, credential.refresh, credential.access]) add(value, found)
    for (const value of Object.values(credential.env ?? {})) add(value, found)
  }
}

async function pluginSecrets(db: SqliteDatabase, sealer: Sealer, found: Set<string>): Promise<void> {
  const plugins = new PluginSecrets(db, sealer)
  try {
    await plugins.load()
  } catch {
    return
  }
  for (const value of plugins.values()) add(value, found)
}

async function unseal(sealer: Sealer, raw: string, label: string): Promise<string | undefined> {
  const sealed: unknown = parse(raw)
  if (!sealedCheck.check(sealed)) return undefined
  try {
    return await sealer.unseal(sealed, label)
  } catch {
    return undefined
  }
}

function add(value: string | undefined, found: Set<string>): void {
  if (value !== undefined && value.length >= MIN_SECRET_LENGTH) found.add(value)
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
