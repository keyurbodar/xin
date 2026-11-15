import type { SqliteMigration } from "@earendil-works/chord/sqlite"

const DEFAULT_STATES: readonly (readonly [id: string, name: string, closed: 0 | 1, isDefault: 0 | 1])[] = [
  ["needs-you", "Needs you", 0, 0],
  ["in-review", "In review", 0, 0],
  ["in-progress", "In progress", 0, 0],
  ["waiting", "Waiting", 0, 0],
  ["todo", "Todo", 0, 1],
  ["backlog", "Backlog", 0, 0],
  ["done", "Done", 1, 1],
  ["canceled", "Canceled", 1, 0],
]

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE issue_states (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        closed INTEGER NOT NULL,
        position INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID`,
      `INSERT INTO issue_states (id, name, closed, position, is_default) VALUES ${DEFAULT_STATES.map(
        ([id, name, closed, isDefault], position) =>
          `(${quote(id)}, ${quote(name)}, ${closed}, ${position}, ${isDefault})`,
      ).join(", ")}`,
      `CREATE TABLE issues (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        due TEXT,
        parent INTEGER,
        labels TEXT NOT NULL DEFAULT '[]',
        assignees TEXT NOT NULL DEFAULT '[]',
        threads TEXT NOT NULL DEFAULT '[]',
        prs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )`,
      "CREATE INDEX issues_updated ON issues (updated_at DESC, id DESC)",
      "CREATE INDEX issues_parent ON issues (parent) WHERE parent IS NOT NULL",
      `CREATE TABLE issue_assignees (
        assignee TEXT NOT NULL,
        issue_id INTEGER NOT NULL,
        PRIMARY KEY (assignee, issue_id)
      ) WITHOUT ROWID`,
      `CREATE TABLE issue_links (
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, kind)
      ) WITHOUT ROWID`,
      "CREATE INDEX issue_links_to ON issue_links (to_id)",
      `CREATE TABLE issue_events (
        id INTEGER PRIMARY KEY,
        issue_id INTEGER NOT NULL,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        reply_to INTEGER
      )`,
      "CREATE INDEX issue_events_issue ON issue_events (issue_id, id)",
      "CREATE VIRTUAL TABLE issues_fts USING fts5(title, description, content='issues', content_rowid='id')",
      `CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues BEGIN
        INSERT INTO issues_fts (rowid, title, description) VALUES (new.id, new.title, new.description);
      END`,
      `CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, description ON issues BEGIN
        INSERT INTO issues_fts (issues_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
        INSERT INTO issues_fts (rowid, title, description) VALUES (new.id, new.title, new.description);
      END`,
    ],
  },
]
