import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { type Sealed, Sealer } from "../seal.ts"

const NO_SECRETS: ReadonlyMap<string, string> = new Map()

export const secretLabel = (id: string, key: string): string => `plugin:${id}:${key}`

const isSealed = (value: unknown): value is Sealed =>
  typeof value === "object" &&
  value !== null &&
  "iv" in value &&
  typeof value.iv === "string" &&
  "data" in value &&
  typeof value.data === "string"

const parseSealed = (raw: string | null): Readonly<Record<string, Sealed>> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("plugin secrets are corrupt: not JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("plugin secrets are corrupt: not an object")
  const sealed: Record<string, Sealed> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!isSealed(value)) throw new Error(`plugin secrets are corrupt: ${key}`)
    sealed[key] = value
  }
  return sealed
}

const jsonPath = (key: string): string => `$.${JSON.stringify(key)}`

export class PluginSecrets {
  readonly #plaintext = new Map<string, ReadonlyMap<string, string>>()

  constructor(
    private readonly db: SqliteDatabase,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<void> {
    this.#plaintext.clear()
    const rows = await this.db.all<{ id: string; sealed: string | null }>("SELECT id, sealed FROM plugins")
    for (const row of rows) {
      const values = new Map<string, string>()
      for (const [key, entry] of Object.entries(parseSealed(row.sealed)))
        values.set(key, await this.sealer.unseal(entry, secretLabel(row.id, key)))
      if (values.size > 0) this.#plaintext.set(row.id, values)
    }
  }

  forPlugin(id: string): ReadonlyMap<string, string> {
    return this.#plaintext.get(id) ?? NO_SECRETS
  }

  values(): readonly string[] {
    const found = new Set<string>()
    for (const values of this.#plaintext.values()) {
      for (const value of values.values()) if (value.length > 0) found.add(value)
    }
    return Array.from(found).toSorted((a, b) => b.length - a.length)
  }

  async set(id: string, key: string, value: string): Promise<void> {
    const sealed = JSON.stringify(await this.sealer.seal(value, secretLabel(id, key)))
    await this.db.run(
      "INSERT INTO plugins (id, sealed) VALUES (?, json_object(?, json(?))) ON CONFLICT (id) DO UPDATE SET sealed = json_set(COALESCE(plugins.sealed, '{}'), ?, json(?))",
      id,
      key,
      sealed,
      jsonPath(key),
      sealed,
    )
    this.#plaintext.set(id, new Map(this.forPlugin(id)).set(key, value))
  }
}
