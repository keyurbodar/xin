# Web client

The first-party client is a SolidJS app in `web/` that talks to the same contract the agent uses: `POST /v1/cmd` for commands and `GET /v1/socket` with subprotocol `xin, bearer.<token>` for the home stream and each conversation stream. It is a separate package, so the Worker gate never compiles it.

## Sub-features

- `#/signin` — owner token, verified with `GET /v1/status`, kept in `localStorage`.
- `#/` — Home: greeting, the five counts, Needs You, the project grid, all from the `home` stream. The stream also carries up to five pending questions (`requests`), so a Needs You row shows the question and its option chips and answers with `request.respond`; a failed row carries Retry (`thread.send`). At phone width the dashed New project tile is replaced by a full-width button above the tab bar.
- `#/p/:slug` — project chat: transcript over `conv:<coordinatorId>`, composer with a paperclip that uploads to `PUT /files/projects/<slug>/attachments/...` and sends `message.send.attachments`, right panel (Threads, Files, Memory, Schedules, Jobs; Jobs reads `job.list`). The Memory tab reads `memory.list` and `memory.suggested`, drives `memory.add`, `memory.pin`, `memory.edit`, `memory.forget` and `memory.dismiss`, and shows a Suggested card for a rule from the last message. The Schedules tab reads `schedule.list` with `outcomes: true`, toggles with `schedule.edit`, and draws the last six runs as dots. A transcript past the snapshot window shows a "Load older messages" button that pages `history.page` from the snapshot's own `before` and keeps the scroll position.
- `#/inbox` — pending questions (`request.list`) plus waiting and failed threads.
- `#/extensions` — Discover, Installed, Updates, Customize, Sources over `plugin.*`, `market.*`.
- `#/settings/:tab` — general (`owner.read`/`owner.set`: the owner's name, autosaved, and the workspace instructions textarea with its 4,000-character counter), usage (range tabs, KPIs, the daily chart with the dashed `alert` line, by project, by model, by tool, the monthly cap with `usage.cap`/`usage.cap.set` and the daily alert with `usage.alert`/`usage.alert.set`), models, notifications (four kind switches over `notify.prefs`/`notify.set` including `spend`, quiet hours over `notify.quiet`/`notify.quiet.set` shown in local time, Other devices over `push.list` plus `push.unsubscribe`), profile (the owner's name and dreamer profile, the masked owner token with reveal and copy, Rotate token over `session.rotate` which stores the new token in this browser, Show QR for phone which draws a `#/signin?token=` link that prefills the field and strips the query, and live sockets over `session.list` with per-socket `session.close`), system (the build, `system.metrics` figures, update, restart, Download logs over `system.logs`). Extensions: Discover and Installed read `market.search`/`package.list`, Updates skips a version (`market.skip`/`unskip`) and Installed rolls back (`market.rollback`), Sources toggles auto-update (`market.policy`) and refreshes (`market.refresh`), Customize lists connectors with `mcp.tools`, reads a skill body with `skill.read`, and edits prompts with `prompt.list`/`prompt.put`/`prompt.delete`. A message starting with `/name` expands through the prompt store before `message.send`.
- The sidebar footer shows the owner's name from `owner.read`; the Profile pane's Edit button opens General.
- `#/schedules` — `schedule.list`, pause and resume through `schedule.edit`.
- `#/p/:slug/run/<conversationId>` — a schedule run's transcript, read-only, opened by a run dot.
- `#/welcome` — first provider key, first project, first message, notifications.
- `#/landing` — public landing page, outside the shell.
- ⌘K — the command palette over projects, threads, pages and actions.
- Layout follows `DDL0wyMU8c`. At 1280 and up the sidebar is 264 wide with labels and the panel is docked. From 1024 to 1279 the sidebar is a 56px rail and the panel is a non-modal drawer, 400 wide, with a shadow and no scrim. Below 1024 the sidebar becomes a bottom tab bar and the panel becomes a bottom sheet at 76% height on a scrim.
- Identity follows `I2`–`I4`. Status is the D Grid from `I2` (`components/ui/status-glyph.tsx`). A project's mark is one of the 24 glyphs from `I3` (`lib/project-glyphs.ts`, picked from the project's words) and its tile corner carries the state. Empty states use the 16 pictograms from `I4` at 88px (`components/ui/pictogram.tsx`). Small loads use the `I1` arc (`Spinner`, 0.8s a turn).
- Motion follows `lv7gYmXLnV` and `NhJwMUwK2F`. A dialog fades and scales .98 in 200 and leaves in 140; a right sheet and the panel drawer slide 24px in over 320; a menu drops 4px in 140; a fan-out row drops 4px in 200 with a 40ms stagger; a report card rises 6px in 320; a press scales .98 within 80; a toggle knob travels in 140; a rejected input shakes once. All of it collapses under `prefers-reduced-motion`.

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

Settings panes, per feature (S1 General, S2 Usage, S3 Models, S4 Notifications, Profile + token, System):

```bash
agent-browser open "http://localhost:5174/#/settings/profile"
agent-browser snapshot -i                       # the pane's real controls
agent-browser screenshot body .verify/shots/x.png
```

Two browsers on one origin (the "which row is mine" proof): give each its own session, sign in with the same token, and compare what each marks.

```bash
export AGENT_BROWSER_SESSION=a; agent-browser open "http://localhost:5174/#/signin?token=verify-owner-token"
export AGENT_BROWSER_SESSION=b; agent-browser open "http://localhost:5174/#/signin?token=verify-owner-token"
# each session: click Continue, open #/settings/profile, then
agent-browser eval "JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Sign out').map(b=>b.parentElement.innerText))"
# exactly one row per browser carries THIS BROWSER, and it is a different row in each
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
- Screenshots are `agent-browser screenshot body <path>`; this build takes `[selector] [path]`, and a bare path is read as a selector and dropped in a temp dir. There is no `viewport` command: phone width needs `close --all` and `--args "--window-size=390,844"`, then sign in again.
- An attachment proof needs a real file: `agent-browser` sets the composer's hidden input with a paths list, then Send. The owner bubble shows a chip and the model's next reply names the file.
- The faux transport bills every run at cost 0, so a live `usage.summary` shows `today.spend` 0 with non-zero tokens unless a real provider answered.
