import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "@earendil-works/chord/sqlite"

export const HOST_MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: ["CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"] },
  {
    version: 2,
    statements: [
      "CREATE TABLE receipts (command_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, at INTEGER NOT NULL)",
      "CREATE INDEX receipts_at ON receipts (at)",
      "CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', sealed TEXT, state TEXT NOT NULL DEFAULT 'pending', error TEXT)",
    ],
  },
]

export function migrate(db: SqliteDatabase): Promise<void> {
  return applySqliteMigrations(db, HOST_MIGRATIONS, { table: "host_migrations" })
}
