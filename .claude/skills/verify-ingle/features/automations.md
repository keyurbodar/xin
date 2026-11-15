# Automations

Stored prompts that start an agent run when a trigger fires (spec `13-always-on.md` §Automations). Plugin `plugins/automations`, rows `automations` and `tool-automations`.

## Sub-features

- Ops (owner and agent): `automation.create`, `automation.list`, `automation.get {id, runs?}`, `automation.update` (a given `triggers` replaces the set; a webhook trigger passed with its `id` keeps its secret), `automation.delete`, `automation.trigger {id, input?}`, `automation.runs {id, limit?, before?}`.
- Triggers: `schedule {cron, tz?}`, `once {at}`, `webhook {contains?, regex?, rules?}`; next fire per trigger in `nextAt`.
- Webhook: `POST /hooks/<secret>` with no token; 404, 413, 200 ignored, 202 started or batched. `idempotency-key` dedupes.
- Coalescing rules: `when`, `groupBy`, `count`, `maxWaitSeconds`, `quietSeconds`; open groups show under `automation.get` → `batches`.
- Targets: `fresh` (new thread per run in `project`) or `same` (one standing conversation).
- Runs: `queued`, `running`, `delivered`, `completed`, `failed`, `cancelled`, with `threadId`, `cost`, `tokens`. Home stream part `automations: {revision}` bumps on every change.
- Agent tools: `automation_save`, `automation_list`, `automation_trigger`.

## How to get to it

The owner asks "every weekday at 9:30 IST summarize my inbox" and the agent calls `automation_save` with `{kind:"schedule", cron:"30 9 * * 1-5", tz:"Asia/Kolkata"}`. A CI system posts to the webhook path.

## Drive it

```bash
S=.claude/skills/verify-ingle/ingle.sh
$S call POST /v1/cmd '{"id":"a1","op":"project.create","args":{"slug":"auto","name":"auto"}}'
$S call POST /v1/cmd '{"id":"a2","op":"automation.create","args":{"title":"Hook","prompt":"Summarize","project":"auto","triggers":[{"kind":"webhook","rules":[{"groupBy":["repo"],"count":2}]}]}}'
# take triggers[0].path from the reply, then post without a token:
curl -s -X POST "http://localhost:8799$HOOK_PATH" -d '{"repo":"a"}'   # {"status":"batched","count":1}
curl -s -X POST "http://localhost:8799$HOOK_PATH" -d '{"repo":"a"}'   # 202 {"status":"started","run":...}
$S call POST /v1/cmd '{"id":"a3","op":"automation.get","args":{"id":"<id>"}}'
```

Proof: `plugins/automations/automations.test.ts`, `cron.test.ts`, and the webhook bound in `src/cost.test.ts`.
