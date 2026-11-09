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
  {
    version: 3,
    statements: [
      "CREATE TABLE inbound (id INTEGER PRIMARY KEY, target INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user','report','question','job')), command_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, client_ts INTEGER NOT NULL, first_at INTEGER NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done')), batch_id TEXT)",
      "CREATE INDEX inbound_due ON inbound (status, fire_at)",
      "CREATE INDEX inbound_target ON inbound (target, status)",
      "CREATE TABLE credentials (provider TEXT PRIMARY KEY, sealed TEXT NOT NULL)",
      "CREATE TABLE files (path TEXT PRIMARY KEY, r2_key TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, sha256 TEXT NOT NULL, project TEXT, updated_at INTEGER NOT NULL)",
      "CREATE INDEX files_r2_key ON files (r2_key)",
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, origin_task TEXT NOT NULL, at INTEGER NOT NULL, retired_by INTEGER, UNIQUE (origin_task, text))",
      "CREATE VIRTUAL TABLE notes_fts USING fts5 (text, content='notes', content_rowid='id')",
      "CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts (rowid, text) VALUES (new.id, new.text); END",
      "CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts (notes_fts, rowid, text) VALUES ('delete', old.id, old.text); END",
      "CREATE TABLE push_subs (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL)",
    ],
  },
  {
    version: 4,
    statements: [
      "CREATE TABLE usage_daily (day TEXT PRIMARY KEY, spend REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0)",
    ],
  },
  {
    version: 5,
    statements: [
      "CREATE TABLE market_history (package TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (package, version))",
    ],
  },
  {
    version: 6,
    statements: [
      "CREATE TABLE file_revisions (path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (path, sha256))",
      "CREATE INDEX file_revisions_sha ON file_revisions (sha256)",
    ],
  },
  {
    version: 7,
    statements: ["ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"],
  },
  {
    version: 8,
    statements: [
      `CREATE TRIGGER notes_au AFTER UPDATE OF text ON notes BEGIN
         INSERT INTO notes_fts (notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
         INSERT INTO notes_fts (rowid, text) VALUES (new.id, new.text);
       END`,
    ],
  },
  {
    version: 9,
    statements: ["ALTER TABLE notes ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0"],
  },
  {
    // Both indexes served queries whose rows are few (pending intake, a day of receipts), so each cost a row on every
    // write of its table to save a scan of a handful of rows.
    version: 10,
    statements: ["DROP INDEX IF EXISTS inbound_target", "DROP INDEX IF EXISTS receipts_at"],
  },
  {
    // The journal took the write bill down by an order of magnitude, so the scans these bound are worth a row again:
    // intake by target, by batch, and the receipt sweep by age each read the whole table without them.
    version: 11,
    statements: [
      "CREATE INDEX IF NOT EXISTS inbound_target ON inbound (target, status)",
      "CREATE INDEX IF NOT EXISTS inbound_batch ON inbound (batch_id)",
      "CREATE INDEX IF NOT EXISTS receipts_at ON receipts (at)",
    ],
  },
]

export function migrate(db: SqliteDatabase): Promise<void> {
  return applySqliteMigrations(db, HOST_MIGRATIONS, { table: "host_migrations" })
}
