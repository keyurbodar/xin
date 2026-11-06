import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "@earendil-works/chord/sqlite"

export const HOST_MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: ["CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"] },
]

export function migrate(db: SqliteDatabase): Promise<void> {
  return applySqliteMigrations(db, HOST_MIGRATIONS, { table: "host_migrations" })
}
