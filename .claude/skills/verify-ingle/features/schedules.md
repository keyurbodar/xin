# Schedules

A schedule is a record in one `xin.schedules` session document, plus a pi timer per active task that sleeps until the next slot and enqueues its prompt through intake with a slot-derived command id, so a replayed send is a no-op. This is dsh `schedule` + `tool-schedule` (spec §19). Recurrence is one `DTSTART` line plus one `RRULE` line (HOURLY, DAILY, WEEKLY, MONTHLY, INTERVAL, BYDAY, BYHOUR, BYMINUTE, COUNT, UNTIL) evaluated in an IANA time zone, or a one-shot `at`.

## Sub-features

- Ops: `schedule.create` (`id?`, exactly one of `rrule` or `at`, `tz`, `title`, `prompt`, `target?`), `schedule.list` (`active?`, `limit`, `offset`, `outcomes?`), `schedule.view`, `schedule.edit` (`action` `update` or `delete`, with `expectedUpdatedAt`), `schedule.cancel`.
- `schedule.parse` (`text`, `tz?`) reads plain words ("every friday at 4pm", "weekdays at 9", "every 2 hours", "daily", a weekday list, an ISO date), falls back to RRULE text, and answers `{rrule|at, tz, next: [3 ISO slots]}`.
- Each delivery appends a run to the record: slot, delivery time, target conversation, and the entry id the conversation had just before the run (last six kept). `schedule.list` with `outcomes: true` resolves each run to `done` (an assistant entry after the marker), `failed` (a `xin.error` entry after it), or `running`; the default list skips those reads.
- Targets: `this_session` (the conversation that created it), `new_once` (one ownerless conversation created at the first delivery and reused), `new` (a new conversation per delivery). There is no existing-conversation or project target; dsh has none.
- Agent tools: `schedule_create`, `schedule_list`, `schedule_view`, `schedule_edit`. `schedule_edit` pauses with `active:false` and resumes with `active:true`; resume needs a future occurrence. Results are canonical JSON; an unknown id answers `schedule_not_found` and a stale `expectedUpdatedAt` answers `schedule_conflict`, both as results rather than errors.
- A delegated child (its conversation carries a `xin.thread` doc) is refused with `subagent_session`.
- One prompt section carries dsh's sentence: only create or modify scheduled tasks at the owner's explicit request.
- Two-phase fire: `fire` checkpoints the due window before `send` enqueues it, so a crash replay sends the same slot.
- Inbound lands as kind `job` with `threadId` = schedule id, `title` = the task title, `status` = `scheduled`, so it renders as `<thread …>` rather than an owner `<msg>`.
- The slot stream starts at the period containing the checkpointed `last`, and the checkpoint carries the slot `index`, so an old schedule costs the same as a new one and COUNT needs no walk.
- DST: a wall time removed by spring-forward moves to the pre-gap offset (`02:30` → `03:30` in America/New_York); folded times fire once.
- A model-created task with target `this_session` and `RRULE:FREQ=HOURLY;INTERVAL=4` is the self-managed heartbeat; no separate mechanism exists.

## How to get to it (user POV)

The owner says "every Monday at 9 remind me to review the week", and the agent calls `schedule_create`. The settings view lists schedules from `schedule.list` and pauses one with `schedule.edit active:false`.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
at=$(( $(date +%s%3N) + 3000 ))
$S call POST /v1/cmd "{\"id\":\"c1\",\"op\":\"schedule.create\",\"args\":{\"id\":\"once\",\"at\":$at,\"tz\":\"UTC\",\"title\":\"Hello\",\"prompt\":\"scheduled hello\"}}"
$S call POST /v1/cmd '{"id":"c2","op":"schedule.create","args":{"id":"weekly","title":"Week review","prompt":"weekly review","rrule":"RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0","target":"this_session"}}'
$S call POST /v1/cmd '{"id":"l1","op":"schedule.list","args":{"active":true}}'          # nextAt is ISO in the task
$S call POST /v1/cmd '{"id":"l2","op":"schedule.list","args":{"outcomes":true}}'        # runs:[{slot,deliveredAt,conversationId,outcome}]
$S call POST /v1/cmd '{"id":"pp","op":"schedule.parse","args":{"text":"every friday at 4pm","tz":"Europe/London"}}'
$S call POST /v1/cmd '{"id":"v1","op":"schedule.view","args":{"id":"weekly"}}'          # updatedAt feeds expectedUpdatedAt
$S call POST /v1/cmd '{"id":"e1","op":"schedule.edit","args":{"id":"weekly","action":"update","active":false,"expectedUpdatedAt":"<updatedAt>"}}'
$S call POST /v1/cmd '{"id":"e2","op":"schedule.edit","args":{"id":"weekly","action":"update","active":true,"expectedUpdatedAt":"2020-01-01T00:00:00.000Z"}}'  # schedule_conflict
$S call POST /v1/cmd '{"id":"x1","op":"schedule.cancel","args":{"id":"weekly"}}'
```

Proof: after the slot passes, the one-shot is gone from `schedule.list` and its target conversation holds an `xin.batch` entry whose body names the schedule id as `threadId` and `scheduled` as `status`. A pause followed by `schedule.list active:false` shows the task still stored with `active:false`.

## Gotchas

- With no model chosen, the fired batch is followed by an `xin.error` entry. That is expected.
- A `new` or `new_once` conversation is a valid delivery target but does not appear in the client overview yet.
- Crash replay, catch-up, DST, COUNT, the two-create idempotency and the draft-escape regression are proven in `plugins/schedules/schedules.test.ts` and `plugins/schedules/rrule.test.ts`. pi can't rewind a checkpoint under wrangler dev, so replay is driven through `sendDue` directly.

Evidence from the last wrangler dev drive: `.verify/evidence/P11-P13-always-on.txt`.
