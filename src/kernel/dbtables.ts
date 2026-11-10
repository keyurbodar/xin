export const KERNEL_OWNER = "kernel"
export const MIGRATIONS_TABLE_PREFIX = "migrations_"

export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  kv: KERNEL_OWNER,
  receipts: KERNEL_OWNER,
  credentials: "models",
  usage_daily: "models",
  files: "files",
  file_revisions: "files",
  notes: "memory",
  notes_fts: "memory",
  push_subs: "push",
  presets: "presets",
  conversation_presets: "presets",
  market_indexes: "market",
  market_history: "market",
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
