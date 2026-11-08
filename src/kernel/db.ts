import type { Context } from "@deepseek-ai/cordis"
import {
  applySqliteMigrations as runSqliteMigrations,
  type SqliteDatabase,
  type SqliteMigration,
  type SqliteValue,
} from "@earendil-works/chord/sqlite"
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare"
import { migrate } from "../db.ts"
import { migrationsTable } from "./dbtables.ts"

export const name = "db"
export const inject = ["host"]

export interface DbService extends SqliteDatabase {
  applySqliteMigrations(owner: string, steps: readonly SqliteMigration[]): Promise<void>
}

export async function apply(ctx: Context): Promise<void> {
  const raw = new DurableObjectSqliteDatabase(ctx.host.state.storage)
  await migrate(raw)
  ctx.provide("db", service(raw))
}

function service(raw: SqliteDatabase): DbService {
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => raw.run(sql, ...params),
    runCounted: (sql, ...params) => raw.runCounted(sql, ...params),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => raw.get<T>(sql, ...params),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => raw.all<T>(sql, ...params),
    transaction: (callback) => raw.transaction(callback),
    close: () => raw.close(),
    applySqliteMigrations: (owner, steps) => applyOwnerMigrations(raw, owner, steps),
  }
}

async function applyOwnerMigrations(
  db: SqliteDatabase,
  owner: string,
  steps: readonly SqliteMigration[],
): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(owner)) throw new Error(`migration owner ${owner} must be snake_case`)
  await runSqliteMigrations(db, steps, { table: migrationsTable(owner) })
}
