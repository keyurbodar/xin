# Memory

Notes live in the `notes` table with FTS5 search, and a curated `profile_md` is injected as a system section. The agent writes with `remember`, reads with `recall`, and the Dreamer task (`xin.dreamer`) curates notes into the profile once a day at 03:00 UTC or soon after a `remember`/`forget`.

## Sub-features

- Agent tools: `remember`, `recall`.
- Owner ops: `memory.list` (optional `scope`, pinned first, each with `source`), `memory.add` (`text`, optional `scope`), `memory.pin` (`id`, `pinned`), `memory.edit` (`id`, `text`), `memory.suggested` (`conversationId`, optional `scope`: rule-like sentences from that conversation's last owner message, filtered against live notes and dismissals), `memory.dismiss` (`text`), `memory.profile`, `memory.forget` (exactly one of `id` or `query`).
- Dreamer pass: uses the owner `defaults.utility` model, else the root conversation's model. With no model it backs off and keeps its cursor.

## How to get to it (user POV)

The project panel's Memory tab lists the coordinator's facts with where each came from. Hovering a row shows pin, edit and forget; Add appends a note by hand. A Suggested card offers Remember, Edit and Dismiss for a rule the owner just stated in chat. The settings view shows the profile and lets the owner forget by query. The agent remembers during chat.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"l1","op":"memory.list","args":{}}'          # {notes:[...]}
$S call POST /v1/cmd '{"id":"a1","op":"memory.add","args":{"text":"Use British spelling"}}'
$S call POST /v1/cmd '{"id":"pn1","op":"memory.pin","args":{"id":3,"pinned":true}}'
$S call POST /v1/cmd '{"id":"e1","op":"memory.edit","args":{"id":1,"text":"Rippling, signed by Priya"}}'
$S call POST /v1/cmd '{"id":"sg1","op":"memory.suggested","args":{"conversationId":3,"scope":"project:prj_p1"}}'
$S call POST /v1/cmd '{"id":"ds1","op":"memory.dismiss","args":{"text":"Never contact candidates directly."}}'
$S call POST /v1/cmd '{"id":"p1","op":"memory.profile","args":{}}'       # {profile_md}
$S call POST /v1/cmd '{"id":"f1","op":"memory.forget","args":{"query":"coffee"}}'   # {retired:n}
$S call POST /v1/cmd '{"id":"f2","op":"memory.forget","args":{"id":3}}'          # one note
```

Tool use and Dreamer passes need a model, so they are proven in `plugins/memory/memory.test.ts` and `plugins/memory/dreamer.test.ts` with faux providers.

## Gotchas

- A fresh home has no notes, so `memory.list` returns `[]` and `memory.profile` returns `""`.
- Dreamer time is driven in tests without touching `dreamer_due`: backdate a note's `at` past the 10-minute idle window, evict the DO, and `start()` schedules the pass itself at the elapsed deadline.
- `recall` and `remember` take their project from the caller's conversation; a coordinator or thread only ever sees `me` plus its own project.

Evidence from the last wrangler dev drive: `.verify/evidence/M7-memory.txt`.
