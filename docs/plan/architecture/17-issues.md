# 17 Issues

Issues are a durable work record that the owner and agents share. They live in the `issues` plugin (`plugins/issues/`). The op contract the web client uses is in the plugin's ops (`issue.*`).

## Tables

Issues are host tables, not pi documents. They do not need to change atomically with a transcript, a list has to be one query, and search needs FTS (§2).

| Table | Holds |
|---|---|
| `issue_states` | Organization-level states: `id`, `name`, `closed`, `position`, `is_default`. One default is open and one is closed. |
| `issues` | One row per issue. `labels`, `assignees`, `threads` and `prs` are JSON columns, so a list is a single `SELECT`. `project` is the scope (null means home-wide). `closed_at` is set while the state is closed. |
| `issue_assignees` | `(assignee, issue_id)`, the index behind the assignee filter. It is kept in step with `issues.assignees` in the same transaction. |
| `issue_links` | Each `blocks` link is stored once, from blocker to blocked. Each `related` link is stored once, lower id first. |
| `issue_events` | The timeline: created, changed (`field`, `from`, `to`), linked, unlinked and comment events. A reply sets `reply_to` to a top-level comment. |
| `issues_fts` | FTS5 over title and description with `prefix='3'`. Triggers keep it in sync and fire only when those two columns change. |
| `issue_wakes` | The outbox of wakes not yet handed to intake. |

## Rules

- State edits (create, rename, reorder, make default, delete) append a `states` event on issue 0, so `rev` moves and clients refetch the state list. No issue timeline shows these events.

- Sub-issues go one level deep. Every mutation reads and checks its rows inside its own write transaction, so concurrent edits cannot form a cycle or leave `closed_at` or the assignee index out of step with the row.
- `issue.get` returns the newest 100 timeline events. Its `earlier` cursor pages back through the older ones.
- Search tokens of 3 or more characters match as prefixes, and shorter tokens match exactly. The project is an FTS column, so a scoped search matches only its own project inside the FTS query. Other filters (state, closed, parent, assignee) join the issue row inside the ranked query, before its LIMIT, so each page holds only rows that already match. Results come in rank order, and a `cursor` pages past the first page.
- Strings are capped on every write path: title 300 characters, description and comment 20,000, label 40, PR URL 500, person id 120. Each list holds at most 20 entries.

## Scope

Owner ops are unscoped. An agent acts as `thread:<conversation>`, and its scope is its conversation's project (`projectInScope`). A conversation with no project, such as root, is unscoped.

A scoped agent:
- sees only the issues in its project, and is told `no issue #N` for any other;
- creates issues in its project;
- may name only conversations in its project as threads, assignees or mentions;
- may link or parent only issues in its project.

An owner-created issue takes its project from the `project` argument, or else from the project of `threads[0]`.

## Wakes

A change plans its wakes inside its own transaction and writes them to `issue_wakes`. After the commit, the plugin enqueues each one into intake as a `job` item and deletes it from the outbox. At boot, any wake still in the outbox is enqueued. The command id `issue:<event>:<target>` makes a replay safe.

| Change | Woken |
|---|---|
| Comment | The owner thread (`threads[0]`) and each mentioned conversation |
| State change, including a move caused by a state deletion | The owner thread |
| Assignee change | The owner thread and each newly added thread or Captain |
| Create | Each initial thread or Captain assignee |

A conversation is never woken by its own change. Several lines for one target in one change are folded into a single wake.

Each issue carries an `agent_hops` counter. Every agent change that wakes someone, whether a comment or an update, uses one hop, and a person's change resets the counter to 0. Once 3 hops are used, agent changes wake nobody until a person acts. This bounds two agents relaying an issue back and forth.

## Cost

These figures are held as bounds in `plugins/issues/cost.test.ts`.

| Action | Rows written | Rows read |
|---|---|---|
| Create an issue | 9 | 13 |
| Comment | 7 | 6 |
| List 20 issues | receipt only | 21 |
| Get one issue | receipt only | 7 |

A search that matches 300 issues reads 154 rows, bounded at 180. Each wake adds one outbox insert and one delete, plus the intake journal write.

## Tool

The `tool-issues` row adds one `issue` tool (`action: create | read | update | comment`). Its list results carry a `cursor`. A read shows the latest 20 comments, each clipped to 500 characters. The row ships disabled, because its declaration is sent with every request.
