# 16 · Time

This section decides that schedules, reminders, the watchdog, the Dreamer and the orphan sweep are all pi tasks, and that the debounce is the only timer Xin owns.

Read with: [01 Host](./01-host.md) for how every task deadline folds into `arm()`, [04 Intake and dispatch](./04-intake-and-dispatch.md) for the debounce, [06 Orchestration](./06-orchestration.md) for the watchdog and Dreamer tasks.

```text
Schedule = pi background task "xin.schedule", input {id, rrule, tz, prompt, projectId}
  wait: runtime.sleepUntil(next(rrule, tz), {phase:"fire"})
  wait → fire: checkpoint the due window {count, latest, index} → send: intake item kind=job (threadId = schedule id, status "scheduled") command_id "sched:id:slotIso" → the conversation its target resolves to (`this_session`, `new_once`, `new`)
        → back to wait. Missed slots after downtime collapse into one fire with "(missed ×N)"   (hermes catch_up)
```

Every frequency keeps local clock time in its zone, `HOURLY` included: a slot is a wall-clock hour (and `BYMINUTE`), not a fixed number of milliseconds from the anchor, so a DST change neither drifts the series nor drops it. The 02:00 slot of a spring-forward day lands at 03:00 and the series continues on its even hours.

A schedule with no future occurrence (a delivered one-shot, an exhausted `COUNT`) stays listed, and the newest 20 of them stay in the document: creating a schedule drops older finished ones, so one-shot reminders do not accumulate and rewrite the whole document on every fire. A paused schedule still has a next occurrence and is never dropped.

Reminders are a one-slot schedule. The watchdog, the Dreamer and the orphan sweep are pi tasks too. The only timer Xin owns is the debounce. All of them fold into `arm()` (§1).
