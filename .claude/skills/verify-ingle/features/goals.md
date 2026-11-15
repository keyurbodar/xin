# Goals, compaction and the loop guard

One durable objective per conversation that continues itself while the coordinator is idle, an owner-triggered compaction, and a nudge when the model repeats one tool call. This is dsh `goal` + `tool-goal` + `goal-round-driver`, `command-compact` and `guard/repeat-tool-reminder` (spec §19).

## Sub-features

- Ops: `goal.get` (`conversation`), `goal.set` (`conversation`, `action` = `create|edit|pause|resume|complete|block|clear`, plus `id` and `revision` for everything after create).
- One goal per conversation. Every change is compare-and-set on `{id, revision}`; a stale pair answers `stale_revision` with the current goal and changes nothing. An unfinished goal must be paused, blocked, completed or cleared before another can take its place; a completed goal can be replaced directly.
- State lives in the DO kv under `goal.<conversation>`. `activation` (`armed`/`disarmed`) is in memory only: a restart leaves an active goal disarmed until `resume`.
- Agent tools: `get_goal`, `create_goal`, `update_goal`, all answering `{ objective, phase, roundsStarted, maxGoalRounds, blockedReason?, revision, activation }`.
- Rounds: `goal-rounds` reserves one round when a run ends, enqueues an intake item of `kind: job` with command id `goal:<goalId>:<round>:<run>`, and the intake batch re-checks the goal before spending the round. A stale reservation spends nothing. The cap blocks with code `round-limit`. An owner message withdraws a pending round. Disabling `goal-rounds` leaves goals usable by hand.
- Op `conv.compact` (`conversationId`, `instructions?`) compacts on demand and answers `{compaction: <id>}`; a live run answers `busy`. There is no model tool for compaction.
- Row `guard` appends a reminder to the tool result at the 3rd, 5th and 8th identical `{name, arguments}` call, advisory only, cleared by a new owner message.
- Row `time` injects a user-role reading before a request when the last one is older than `refreshIntervalMs` (default 10 minutes). It is request-scoped: it never enters the transcript.

## How to get to it (user POV)

The owner says "keep going on this until it is done" and the agent creates a goal; the coordinator then keeps taking rounds on its own until it completes or runs out. The owner can pause it from the settings view with `goal.set pause`. When a long conversation gets slow, the owner compacts it from the same view.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"g1","op":"goal.get","args":{"conversation":1}}'                       # {goal:null}
$S call POST /v1/cmd '{"id":"g2","op":"goal.set","args":{"conversation":1,"action":"create","objective":"Ship it","maxRounds":4}}'
$S call POST /v1/cmd '{"id":"g3","op":"goal.set","args":{"conversation":1,"action":"pause","id":"<id>","revision":1}}'
$S call POST /v1/cmd '{"id":"g4","op":"goal.set","args":{"conversation":1,"action":"resume","id":"<id>","revision":2}}'
$S call POST /v1/cmd '{"id":"g5","op":"goal.set","args":{"conversation":1,"action":"complete","id":"<id>","revision":3}}'
$S call POST /v1/cmd '{"id":"c1","op":"conv.compact","args":{"conversationId":11}}'               # {compaction:<id>}
```

Proof: each mutation returns the whole goal with a bumped `revision` and the right `phase` and `activation`; a create over an unfinished goal answers `goal_exists`; a stale `revision` answers `stale_revision` and leaves state unchanged; `conv.compact` answers a compaction id that appears in `pi.live`.

## Gotchas

- Rounds only run when a model is configured and the conversation is idle; the round is one ordinary coordinator turn carrying a `<goal_round>` block.
- `goal.get` and `goal.set` do not verify that the conversation exists; a goal on a missing conversation simply never takes a round.
- Round counting, stale reservations, the cap, the withdraw path and the loop guard are proven in `plugins/goals/*.test.ts` and `plugins/guard/guard.test.ts`.

Evidence from the last wrangler dev drive: `.verify/evidence/P11-P13-always-on.txt`.
