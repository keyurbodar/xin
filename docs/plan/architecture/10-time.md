# 16 · Time

This section decides that schedules, reminders, the watchdog, the Dreamer and the orphan sweep are all pi tasks, and that the debounce is the only timer Xin owns.

Read with: [01 Host](./01-host.md) for how every task deadline folds into `arm()`, [04 Intake and dispatch](./04-intake-and-dispatch.md) for the debounce, [06 Orchestration](./06-orchestration.md) for the watchdog and Dreamer tasks.

```text
Schedule = pi background task "xin.schedule", input {id, rrule, tz, prompt, projectId}
  wait: runtime.sleepUntil(next(rrule, tz), {phase:"fire"})
  wait → fire: checkpoint the due window {count, latest, index} → send: inbound kind=job (threadId = schedule id, status "scheduled") command_id "sched:id:slotIso" → coordinator of projectId, else conv, else root
        → back to wait. Missed slots after downtime collapse into one fire with "(missed ×N)"   (hermes catch_up)
```

Reminders are a one-slot schedule. The watchdog, the Dreamer and the orphan sweep are pi tasks too. The only timer Xin owns is the debounce. All of them fold into `arm()` (§1).
