# Web client

The first-party client is a SolidJS app in `web/` that talks to the same contract the agent uses: `POST /v1/cmd` for commands and `GET /v1/socket` with subprotocol `xin, bearer.<token>` for the home stream and each conversation stream. It is a separate package, so the Worker gate never compiles it.

## Sub-features

- `#/signin` — owner token, verified with `GET /v1/status`, kept in `localStorage`.
- `#/` — Home: greeting, the five counts, Needs You, the project grid, all from the `home` stream.
- `#/p/:slug` — project chat: transcript over `conv:<coordinatorId>`, composer with a paperclip that uploads to `PUT /files/projects/<slug>/attachments/...` and sends `message.send.attachments`, right panel (Threads, Files, Memory, Schedules, Jobs; Jobs reads `job.list`). A transcript past the snapshot window shows a "Load older messages" button that pages `history.page` from the snapshot's own `before` and keeps the scroll position.
- `#/inbox` — pending questions (`request.list`) plus waiting and failed threads.
- `#/extensions` — Discover, Installed, Updates, Customize, Sources over `plugin.*`, `market.*`.
- `#/settings/:tab` — general (`owner.read`/`owner.set`: the owner's name, autosaved, and the workspace instructions textarea with its 4,000-character counter), usage (range tabs, KPIs, the daily chart with the dashed `alert` line, by project, by model, by tool, the monthly cap with `usage.cap`/`usage.cap.set` and the daily alert with `usage.alert`/`usage.alert.set`), models, notifications (four kind switches over `notify.prefs`/`notify.set` including `spend`, quiet hours over `notify.quiet`/`notify.quiet.set` shown in local time, Other devices over `push.list` plus `push.unsubscribe`), profile (the owner's name and dreamer profile, the masked owner token with reveal and copy, Rotate token over `session.rotate` which stores the new token in this browser, Show QR for phone which draws a `#/signin?token=` link that prefills the field and strips the query, and live sockets over `session.list` with per-socket `session.close`), system (the build, `system.metrics` figures, update, restart, Download logs over `system.logs`). Extensions: Discover and Installed read `market.search`/`package.list`, Updates skips a version (`market.skip`/`unskip`) and Installed rolls back (`market.rollback`), Sources toggles auto-update (`market.policy`) and refreshes (`market.refresh`), Customize lists connectors with `mcp.tools`, reads a skill body with `skill.read`, and edits prompts with `prompt.list`/`prompt.put`/`prompt.delete`. A message starting with `/name` expands through the prompt store before `message.send`.
- The sidebar footer shows the owner's name from `owner.read`; the Profile pane's Edit button opens General.
- `#/schedules` — `schedule.list`, pause and resume through `schedule.edit`.
- `#/welcome` — first provider key, first project, first message, notifications.
- `#/landing` — public landing page, outside the shell.
- ⌘K — the command palette over projects, threads, pages and actions.
- Below 1024px the sidebar becomes a bottom tab bar and the right panel becomes a bottom sheet.

## How to get to it (user POV)

Open the client, paste the owner token, land on Home. Projects in the sidebar open their chat. Inbox collects everything that waits. ⌘K jumps anywhere.

## Driving it

The client is a Vite dev server that proxies `/v1`, `/files` and `/health` to the Worker. `/files` matters: without it an attachment upload gets a 404 from Vite itself.

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
- The home stream pushes a full snapshot on every thread change; the conversation stream sends a bounded snapshot plus `ev` deltas, applied with `@earendil-works/chord/delta`, which validates each op.
- The snapshot window is 60 entries: a conversation needs more than that before "Load older messages" appears, so seed one with many messages to drive that control.
- One composer draft keeps one command id and `clientTs`; sending the same text again after a failure replays the same command instead of adding a second message.
- Skeleton states come from skullet: the sample render must not throw, because an error inside a Solid effect aborts the queue and leaves the surface stuck.
- Screenshots need the viewport set first: `agent-browser viewport 1440 900`.
- An attachment proof needs a real file: `agent-browser` sets the composer's hidden input with a paths list, then Send. The owner bubble shows a chip and the model's next reply names the file.
- The faux transport bills every run at cost 0, so a live `usage.summary` shows `today.spend` 0 with non-zero tokens unless a real provider answered.
