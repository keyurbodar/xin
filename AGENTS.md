# Xin

Xin is a personal agent backend on Cloudflare: one Worker, one SQLite-backed Durable Object per owner (`Home`), and R2. It is built on `@earendil-works/pi-durable`, `pi-ai` and `pi-mcp` 1.5.0, and shaped like Claude Projects (a coordinator per project, plus threads). The client is a web app. This repo is the backend only.

**The spec is `docs/plan/`.** Start at `docs/plan/README.md`. When the code and the spec disagree, either fix the code or change the spec in the same commit and log why (see Decision log). Never let them drift silently.

## Scope rules (hard)

- Files only. No code execution: no bash tool, no sandbox, no codemode, no git tools for the agent.
- Web only. No Telegram/SMS/VPS/computer/browser integrations. No A2A, no multi-agent rooms.
- **No model ids in product code.** Models come from the pi-ai catalog at run time and from the owner's choices (`docs/plan/architecture/05-models.md`). Test code may name models.
- Official primitives first: pi-durable (Harness, tasks, docs, inbox, hooks, `onWake`), pi-ai (catalog, `CredentialStore`), pi-mcp, Cloudflare runtime APIs. Before writing a mechanism, check whether pi already ships it (`node_modules/@earendil-works/pi-durable/README.md`).
- No Effect, no RPC framework, no custom journal or storage proxy. Plain TypeScript.
- Kiko (`/home/keyur/kiko`) is a reference only. Copy an idea only when the spec names it.

## Skills

Use these pstack skills. They are part of the workflow, not optional extras.

| When | Skill |
|---|---|
| Any non-trivial task (default entry point) | `/pstack:poteto-mode` |
| Reading or editing any `.ts` file | `/pstack:typescript-best-practices` |
| End of M0: create the project verification skill (`.claude/skills/verify-xin/`) that drives the real Worker through `wrangler dev` / vitest-pool-workers | `/pstack:create-verification-skill` |
| End of every later milestone: keep that skill and its feature map honest | `/pstack:maintain-verification-skill` |
| Before a milestone counts as done: strict maintainability review of its diff | `/pstack:thermo-nuclear-code-quality-review` |
| Before a milestone counts as done: remove comment noise | `/pstack:no-comments` |
| Long or unattended runs: one TSV row per decision in `docs/log/decisions.tsv` | `/pstack:show-me-your-work` |

## The gate: the only way to build, lint and test

Never run `tsc`, `tsgo`, `vitest`, `oxlint`, `biome`, `oxfmt` or `wrangler deploy --dry-run` directly. Heavy jobs go through one background queue with one runner for the whole machine:

```bash
id=$(bun scripts/gate.ts submit types test)       # enqueue, returns at once with a job id
bun scripts/gate.ts submit test --only=src/gateway  # tests under a path
bun scripts/gate.ts wait $id                       # block until that job's result (run it in the background)
bun scripts/gate.ts status                         # runner, queue, recent results, free disk
bun scripts/gate.ts [run] [steps]                  # lead only: run now, still behind the same lock
```

- **One runner, serial**: jobs run one at a time under `nice -n 10`, with vitest capped at 2 workers. `submit` starts the runner when needed, and it exits after 10 idle minutes. The machine has 4 cores and 15 GB.
- **Coalescing**: identical jobs (same checkout, steps and filter) submitted within 1.5 s run once, and every submitter gets the result.
- **Cache**: a step that passed is skipped until its inputs change, so an unchanged tree costs nothing.
- **Logs**: `.gate/<step>.log` in the checkout, and results in `/tmp/xin-gate/results/<id>.json`. Read them instead of re-running.
- `package.json` must define `fmt:check`, `lint`, `typecheck`, `test` and `bundle`. The gate calls exactly those.
- Workers may only `submit test --only=<own path>` and `wait`, at most 3 jobs per lane. Only the lead submits the full gate, once per merged wave.

## Subagents

The full system is in `docs/process/orchestration.md`, and briefs use `docs/process/brief-template.md`. In short:

- The lead (this session) plans, briefs, reviews, iterates and commits. Workers implement exactly one lane each.
- Workers always use `delegate_task` with `target: { providerInstanceId: "magpie", model: "group/workhorse[1m]" }`.
- Disk: default `isolation: "shared"` with disjoint file ownership. Use a worktree only for overlapping files, at most 2 at once, only with more than 15 GB free, and remove it after merge.
- At most 6 live workers. Workers never commit in the shared checkout, never `bun install`, never run `wrangler dev`.
- If a lane stalls or fails the same way twice, cancel it, split it smaller or re-brief it, and log the choice.
- Never put secrets in a brief. Live keys live in `.dev.vars`.

## Code

- TypeScript strict, ESM, Bun for scripts, wrangler for the Worker.
- Schemas: pi-ai's TypeBox (`Type` from `@earendil-works/pi-ai`) for tool parameters and wire frames. Parse at the boundary (socket frame, HTTP body, tool args, stored JSON), then trust the types.
- Branded ids (`ConversationId`, `ProjectId`, `ThreadId`, `CommandId`, `BatchId`). Discriminated unions with a `kind` field for states and frames. No `as` casts except right after validation. Exhaustive `switch` with `const _exhaustive: never`.
- One module per mechanism, matching the spec's sections: `src/host.ts`, `src/db.ts`, `src/ops.ts`, `src/wire.ts`, `src/gateway.ts`, `src/models.ts`, `src/plugins/host.ts`. Features live in `plugins/*` (see `docs/plan/architecture/09-plugins.md`).
- Host schema changes append a step to the migration list. Never edit an existing step.
- Everything that runs after a crash must be safe to run twice. Use the derived idempotency keys from `docs/plan/architecture/02-state.md`.

## Tests and proof

- Vitest with `@cloudflare/vitest-pool-workers` against the real Worker and DO: `runInDurableObject`, evictions, `runDurableObjectAlarm`. Use the pi-ai faux provider by default.
- No mocks of pi, SQLite or the DO runtime. Only the model transport is faked.
- Tests sit beside the source as `*.test.ts`. Assert observable behaviour (replies, stored state, frames), not internals.
- **Live tests** (Xin talking to a real model) are opt-in (`XIN_LIVE=1`). They read `OPENCODE_API_KEY` from `.dev.vars` (provider `opencode-go`, a temporary key; use it as is). Model order is in `XIN_LIVE_MODELS`:
  1. `iceman-contributor-free`
  2. `beam-free` if the first is unavailable
  3. `muse-spark-1.3-contributor` otherwise
  The test helper takes the first one that answers a one-token probe. All three were checked working on 2026-11-06. pi-ai sends the required `x-opencode-session` header from the conversation's session id. These names live only in test code and `.dev.vars`, never in product code.
- Every milestone in `docs/plan/milestones.md` has a named proof. A milestone is done only when its proof passes through the gate.

## Definition of done for a milestone

1. The proof test(s) pass via `bun scripts/gate.ts` (all steps green).
2. `/pstack:thermo-nuclear-code-quality-review` and `/pstack:no-comments` have run on the milestone diff, and accepted findings are fixed.
3. The verification skill is updated (`/pstack:maintain-verification-skill`) and drives the new behaviour once against the real Worker.
4. The spec matches the code, and deviations are logged in `docs/log/decisions.tsv`.
5. One commit per milestone on the working branch, message `M<n>: <what>`.

## Decision log

`docs/log/decisions.tsv`, columns: `time  milestone  decision  why  evidence  result`. Add a row for every spec deviation, library surprise, or choice between two designs. This is how the owner audits unattended work.
