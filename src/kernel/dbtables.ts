export const KERNEL_OWNER = "kernel"
export const MIGRATIONS_TABLE_PREFIX = "migrations_"

export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  kv: KERNEL_OWNER,
  receipts: KERNEL_OWNER,
  plugins: KERNEL_OWNER,
  inbound: "intake",
  credentials: "models",
  files: "files",
  notes: "memory",
  notes_fts: "memory",
  push_subs: "push",
  presets: "presets",
  market_versions: "market",
  market_checks: "market",
}

export function migrationsTable(owner: string): string {
  return `${MIGRATIONS_TABLE_PREFIX}${owner}`
}

export function tableOwner(table: string): string | undefined {
  const owner = TABLE_OWNERS[table]
  if (owner !== undefined) return owner
  if (table === "host_migrations" || table.startsWith(MIGRATIONS_TABLE_PREFIX)) return KERNEL_OWNER
  return undefined
}
