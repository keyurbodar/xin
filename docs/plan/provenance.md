# 19 · Provenance: what came from where

This section records which parts of the design are taken from which source, and what was deliberately left out.

Read with: [01 Host](./architecture/01-host.md), [06 Orchestration](./architecture/06-orchestration.md), [09 Plugins](./architecture/09-plugins.md), [10 Time](./architecture/10-time.md) for the mechanisms named below.

| Source | Taken | Left |
| --- | --- | --- |
| pi-durable 1.5 | Harness, DO adapter + prefix, onWake host loop, inbox steer/follow-up, background anchors + reporters, sleepUntil tasks, hooks, wrapTool, deferred tools, compaction, usage | codemode, bash/CodingTools, Photon images |
| pi-ai / pi-mcp | runtime catalog, CredentialStore, OAuth refresh, cross-provider history transform, createProvider; MCP client | - |
| t3code orch v2 | shared command layer, receipts, 4 dispatch modes, delegate/status/cancel/send/read/wait contract, brief-only children, privilege ceiling, question notification + cancel-on-answer, short capability lists | provider-thread handoffs (pi-ai's transcript is already portable), checkpoints/rollback, PR/worktree, 75k LOC |
| Instinct notes | burst debounce 2 s / 8 s cap, atomic claim, restart-before-tools, silence is valid, heartbeat/timeout/visible failure | - |
| kiko | web-first, Ping/Pong auto-response, hibernation attachments, seal crypto, safe-fetch, append-only migrations | rooms, multi-agent, Effect RPC, journal, admission/budget, computer/browser/apps/installer |
| pi-pocket | secret redaction hook, schedules as sleepUntil tasks, Web Push | Node server, drop-in extension dir |
| hermes | memory injection scan, cron catch-up collapse | file-locked MEMORY.md, 28 platforms |
| magpie | reconcile lifecycle, requires/provides, API caret range, failed-plugin isolation | gateway/provider plugins |
