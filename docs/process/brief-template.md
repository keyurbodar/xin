# Worker brief template

Copy this, fill in every field, and pass it as `task` to `delegate_task`. The worker sees nothing else, so the brief must stand alone. Never put secrets in it.

```text
You are implementing one lane of Xin, a personal-agent backend on Cloudflare built on pi-durable.
Repo: <absolute path of the checkout>. Read AGENTS.md first and follow it, especially "The gate" and "Code".
Use /pstack:typescript-best-practices for all .ts work.

LANE: <id> · Milestone M<n> · wave W<n>
GOAL: <one sentence: the behaviour that exists when you're done>
SPEC: read <docs/plan/architecture/NN-*.md §…> (the source of truth) and <any other file>.
OWN (only you edit these): <files to create or edit>
DO NOT TOUCH: <files other lanes own, plus package.json, the lockfile and wrangler.jsonc. Ask in your report if you need a change there>
USE (already exists, import it, don't redefine it): <src/ids.ts, …>
PROOF: write <path>.test.ts asserting <observable behaviour>. It must pass with:
  bun scripts/gate.ts submit test --only=<path> && bun scripts/gate.ts wait <id>
  (at most 3 gate jobs in total; never run vitest, tsc or wrangler directly; no bun install)
DONE WHEN: the proof passes through the gate and the code matches the spec section.
If the spec is unclear or wrong, stop and report "blocked" with the question. Don't invent a design.

End your final message with exactly:
LANE <id> · status: done|blocked
changed: <files>
proof: <test file> · gate job <id> <ok|FAIL>
decisions: <one line each, or none>
```
