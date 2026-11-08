import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { compile } from "@earendil-works/pi-schema"
import { SealedSchema, Sealer, type Sealed } from "../seal.ts"

const PREFIX = "secret."
const label = (ref: string): string => `credential:${ref}`
const keyOf = (ref: string): string => `${PREFIX}${ref}`
const refOf = (key: string): string => key.slice(PREFIX.length)

const sealedCheck = compile(SealedSchema)

const parse = (ref: string, raw: string): Sealed => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`credential ${ref} is corrupt: not JSON`)
  }
  if (!sealedCheck.check(value)) throw new Error(`credential ${ref} is corrupt: not a sealed value`)
  return value
}

export class CredentialStore {
  readonly #plaintext = new Map<string, string>()

  constructor(
    private readonly db: SqliteDatabase,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<void> {
    this.#plaintext.clear()
    const rows = await this.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE key LIKE 'secret.%'",
    )
    for (const row of rows) {
      const ref = refOf(row.key)
      this.#plaintext.set(ref, await this.sealer.unseal(parse(ref, row.value), label(ref)))
    }
  }

  get(ref: string): string | undefined {
    return this.#plaintext.get(ref)
  }

  values(): readonly string[] {
    const found = new Set(this.#plaintext.values())
    found.delete("")
    return Array.from(found).toSorted((left, right) => right.length - left.length)
  }

  async set(ref: string, value: string): Promise<void> {
    if (value === "") {
      await this.db.run("DELETE FROM kv WHERE key = ?", keyOf(ref))
      this.#plaintext.delete(ref)
      return
    }
    const sealed = JSON.stringify(await this.sealer.seal(value, label(ref)))
    await this.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      keyOf(ref),
      sealed,
    )
    this.#plaintext.set(ref, value)
  }
}
