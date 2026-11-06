import type { Context } from "@deepseek-ai/cordis"
import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "@earendil-works/chord/sqlite"
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare"
import { migrate } from "../db.ts"

export const name = "db"
export const inject = ["host"]

export async function apply(ctx: Context): Promise<void> {
  const db = new DurableObjectSqliteDatabase(ctx.host.state.storage)
  await migrate(db)
  ctx.provide("db", db)
}

export function migratePlugin(db: SqliteDatabase, owner: string, steps: readonly SqliteMigration[]): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(owner)) throw new Error(`migration owner ${owner} must be snake_case`)
  return applySqliteMigrations(db, steps, { table: `migrations_${owner}` })
}
