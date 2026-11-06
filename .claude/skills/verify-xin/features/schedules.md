# Schedules

A schedule is a pi background task `xin.schedule` that sleeps until its next slot, then enqueues its prompt through intake with command id `sched:<id>:<slotIso>`, so a replayed send is a no-op. Recurrence is an RRULE subset (HOURLY, DAILY, WEEKLY, MONTHLY, INTERVAL, BYDAY, BYHOUR, BYMINUTE, COUNT, UNTIL) evaluated in an IANA time zone, or a one-shot `at`.

## Sub-features

- Ops: `schedule.create` (`id?`, exactly one of `rrule` or `at`, `tz`, `prompt`, `conv?`, `projectId?`), `schedule.list`, `schedule.cancel`.
- `projectId` targets that project's coordinator conversation; an unknown project is rejected with `bad_args`. `conv` and `projectId` are mutually exclusive.
- Agent tools: `schedule`, `unschedule` (tz defaults to UTC).
- Two-phase fire: `fire` checkpoints the due window (`{count, latest, index}`) before `send` enqueues it, so a crash replay sends the same slot.
- Inbound lands as kind `job` with `threadId` = schedule id, `title` = prompt head, `status` = `scheduled`, so it renders as `<thread …>` rather than an owner `<msg>`.
- The slot stream starts at the period containing the checkpointed `last`, and the checkpoint carries the slot `index`, so an old schedule costs the same as a new one and COUNT needs no walk.
- DST: a wall time removed by spring-forward moves to the pre-gap offset (`02:30` → `03:30` in America/New_York); folded times fire once.

## How to get to it (user POV)

The owner says "every Monday at 9 remind me to review the week", and the agent calls `schedule`. The settings view lists schedules from `schedule.list`.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
at=$(( $(date +%s%3N) + 3000 ))
$S call POST /v1/cmd "{\"id\":\"c1\",\"op\":\"schedule.create\",\"args\":{\"id\":\"once\",\"at\":$at,\"tz\":\"UTC\",\"prompt\":\"scheduled hello\"}}"
$S call POST /v1/cmd '{"id":"c2","op":"schedule.create","args":{"id":"weekly","rrule":"FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0","tz":"Asia/Kolkata","prompt":"weekly review"}}'
$S call POST /v1/cmd '{"id":"c3","op":"schedule.create","args":{"id":"proj","rrule":"FREQ=DAILY;BYHOUR=9;BYMINUTE=0","tz":"UTC","prompt":"project nudge","projectId":"<prj id from project.create>"}}'
$S call POST /v1/cmd '{"id":"c4","op":"schedule.create","args":{"id":"nope","at":1,"tz":"UTC","prompt":"x","projectId":"prj_missing"}}'  # rejected bad_args
$S call POST /v1/cmd '{"id":"l1","op":"schedule.list","args":{}}'     # nextAt in epoch ms
sleep 9; $S ws '{"t":"sub","stream":"conv:1"}'                          # xin.batch entry carrying "scheduled hello"
$S call POST /v1/cmd '{"id":"x1","op":"schedule.cancel","args":{"id":"weekly"}}'
```

Proof: after the slot passes, the one-shot is gone from `schedule.list`, and the target conversation holds an `xin.batch` whose entry body is `{"kind":"job","threadId":"once","title":"scheduled hello","status":"scheduled","text":"scheduled hello"}`. Check `nextAt` with `TZ=<tz> date -d @<nextAt/1000>`.

## Gotchas

- With no model chosen, the fired batch is followed by an `xin.error` entry. That is expected.
- Crash replay, catch-up, DST, COUNT and the create race are proven in `src/schedules.test.ts` and `src/rrule.test.ts`. pi can't rewind a checkpoint under wrangler dev, so replay is driven through `sendDue` directly.

Evidence from the last wrangler dev drive: `.verify/evidence/M8-schedules.txt`.
