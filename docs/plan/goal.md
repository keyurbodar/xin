# Goal: Xin backend, M0 to M9, verified

Paste the block below as the goal.

```text
Build the complete Xin backend in this repo, milestones M0 through M9 in docs/plan/milestones.md,
exactly as specified in docs/plan/ and following AGENTS.md.

Done means: every milestone's named proof test passes through `bun scripts/gate.ts` (all steps green);
the verification skill (.claude/skills/verify-xin, created at M0 with /pstack:create-verification-skill)
drives every feature once against the real Worker under wrangler dev and reports pass; a live run with
XIN_LIVE=1 completes one coordinator reply, one delegated thread with its report, and one mid-run model
switch, on the OpenCode Go model order in .dev.vars (iceman-contributor-free,
else beam-free, else muse-spark-1.3-contributor); docs/plan matches the code; one commit per milestone.

Work unattended. Don't stop to ask me. Decide, log the decision in docs/log/decisions.tsv, and continue.
Run it the way docs/process/orchestration.md describes: you are the lead (plan each wave, brief lanes from
docs/process/brief-template.md, review, iterate, commit). Workers are delegate_task subagents on magpie
group/workhorse[1m], with shared checkout and disjoint files by default, at most 6 live and at most 2
worktrees. All builds, lint, typecheck and tests go through the `bun scripts/gate.ts` background queue.
Workers submit only their own scoped tests, and you submit the full gate once per merged wave. Before
marking any milestone done, run /pstack:thermo-nuclear-code-quality-review and /pstack:no-comments on
its diff and fix what they find. Do not deploy to Cloudflare and do not push. Stop only when all of the
above holds, or when a blocker needs something only I can provide (a credential or account). In that
case, write the blocker and what you tried at the top of docs/log/decisions.tsv and finish every
milestone it doesn't block first.
```

## Why it's worded this way

- **"Done" is a set of checks, not a feeling**: gate green, verification skill passing against the real Worker, one live run. Each of those is something you can rerun.
- **One background queue runs every heavy job**, one at a time, with identical requests merged and unchanged trees cached. 20 workers can never trigger 20 builds.
- **"Don't ask, log"** keeps the run unattended without hiding judgement calls. `docs/log/decisions.tsv` is where you review them afterwards.
- **No deploy and no push**: those are the only steps that leave this machine, so they wait for you.

## Expected lane plan

| Wave | Lanes in parallel |
|---|---|
| 1 | M0 host loop + scaffold (lead, alone: everything depends on it) |
| 2 | M1 ops/receipts/wire + minimal plugin host (alone: every feature plugs into it) |
| 3 | M2 intake + dispatch · M3 models · M4 files · M8 plugin permissions/skills/MCP/schedules |
| 4 | M5 orchestrator + threads · M7 memory |
| 5 | M6 jobs/questions/watchdog · M9 push + cost guard |
| 6 | verification-skill sweep, live run, final reviews |

Matches the "Depends on" and "Parallel with" lines in `milestones.md`.
