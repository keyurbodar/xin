# Web client

The first-party client is a SolidJS app in `web/` that talks to the same contract the agent uses: `POST /v1/cmd` for commands and `GET /v1/socket` with subprotocol `xin, bearer.<token>` for the home stream and each conversation stream. It is a separate package, so the Worker gate never compiles it.

## Sub-features

- `#/signin` — owner token, verified with `GET /v1/status`, kept in `localStorage`.
- `#/` — Home: greeting, the five counts, Needs You, the project grid, all from the `home` stream.
- `#/p/:slug` — project chat: transcript over `conv:<coordinatorId>`, composer, right panel (Threads, Files, Memory, Schedules, Jobs).
- `#/inbox` — pending questions (`request.list`) plus waiting and failed threads.
- `#/extensions` — Discover, Installed, Updates, Customize, Sources over `plugin.*`, `market.*`.
- `#/settings/:tab` — general, usage, models, notifications, profile, system.
- `#/schedules` — `schedule.list`, pause and resume through `schedule.edit`.
- `#/welcome` — first provider key, first project, first message, notifications.
- `#/landing` — public landing page, outside the shell.
- ⌘K — the command palette over projects, threads, pages and actions.
- Below 1024px the sidebar becomes a bottom tab bar and the right panel becomes a bottom sheet.

## How to get to it (user POV)

Open the client, paste the owner token, land on Home. Projects in the sidebar open their chat. Inbox collects everything that waits. ⌘K jumps anywhere.

## Driving it

The client is a Vite dev server that proxies `/v1` and `/health` to the Worker.

```bash
S=.claude/skills/verify-xin/xin.sh
$S launch                                   # the Worker on :8799
cd web && bun run dev                       # the client on :5174, proxying to :8799
agent-browser open http://localhost:5174/
agent-browser fill "input" "verify-owner-token"
agent-browser eval "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Continue').click()"
```

Route-by-route screenshots:

```bash
.claude/skills/verify-xin/shots.sh .verify/shots   # one png per route at 1440x900
```

Build and typecheck are the client's own gate; run them in `web/`, never through `scripts/gate.ts`:

```bash
cd web && bun run typecheck && bun run build
```

## Gotchas

- The client keeps its token in `localStorage`; a fresh browser profile needs the sign-in step again.
- A hash route change does not reload state; a full reload reconnects the socket and re-subscribes.
- The home stream pushes a full snapshot on every thread change; the conversation stream sends a bounded snapshot plus `ev` deltas.
- Skeleton states come from skullet: the sample render must not throw, because an error inside a Solid effect aborts the queue and leaves the surface stuck.
- Screenshots need the viewport set first: `agent-browser viewport 1440 900`.
