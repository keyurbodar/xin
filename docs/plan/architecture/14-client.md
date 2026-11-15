# 20 · The web client

This section decides how the first-party web client is built and what it talks to. The client is a SolidJS app in `web/`, a separate package from the Worker: the local gate typechecks it (`tsgo -p web/tsconfig.json`), CI's `web` job installs, typechecks and builds it, and neither bundles it into the Worker, because the Worker's own bundle step builds `src/worker.ts` alone.

**Hosting.** A deploy serves `web/dist` from the Worker's own origin as static assets, so the client, `/v1`, `/files` and the socket share one origin and no request crosses it. The assets arrive on the deploy command (`wrangler deploy --assets ./web/dist`), not in `wrangler.jsonc`, because the gate's `bundle` step runs on machines where `web/dist` does not exist.

**Design source.** The design system is the Ingle v4 handoff (Doop canvas `elsVZejERK`, tokens in `web/src/styles/tokens.css`), with the owner's reference screenshots as the final word where they disagree. Dark is the default, `[data-theme="light"]` is its matched counterpart and `[data-theme="rose"]` is a dark variant with a rose accent; the action colour is `--color-accent`, which `primary` follows; the choice is per device (`localStorage` key `ingle.theme`, applied before first paint by `index.html`). Type is Inter for the interface and Geist Mono for ids, costs and code, both self-hosted from `@fontsource-variable`; there is no serif anywhere. Every colour, radius, size, shadow and motion curve is a token, and components reference tokens, never hex.

- **The accent (`--color-accent`, which `primary` follows) is the one action colour.** It is blue in dark and light and rose in the rose theme. Needs-you stays blue and is told apart by the Signal's shape.
- Status colours never follow the accent: working amber, done green, failed red, merged violet; waiting is ink-3.

## Status palette

The values live in `tokens.css`; `web/src/lib/status.ts` maps each state to its token.

| State | Token | Word |
| --- | --- | --- |
| queued | `ink-3` | Queued |
| working | `working` | Working |
| waiting | `needs` | Waiting on you |
| done | `done` | Done |
| failed | `failed` | Failed |
| paused | `working` | Paused |
| cancelled | `icon` | Cancelled |

Rows, chips and the sidebar use the **D Grid** family from `I2`: a 3×3 grid of square cells where every state is its own pattern, at 12, 16, 20 or 24px. Chat chips use the **Capsule** family, which pairs the glyph with the state's word.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| framework | SolidJS + Vite | the same stack kiko ships, and fine-grained reactivity suits a streaming transcript |
| styles | Tailwind 4 with `@theme` tokens | one token block generates every utility, so a hex exists once |
| router | a 40-line hash router in `web/src/lib/router.ts` | six routes, no dependency, works on any static host |
| icons | `lucide-solid` | the design names Lucide; imports are per icon, so the bundle carries only the icons used |
| deltas | `@earendil-works/chord/delta` `applyImmutable` | the server sends the watch's decoded ops, so the client applies them with the library that defines them instead of a copy |
| loading | `skullet` (measured skeletons), `torph` (text morph) | the owner's picks; a skeleton the size of the real content stops the layout shifting |
| syntax | `sugar-high`, the highlighter kiko ships | C12 tints fenced code; it is a few KB, has no dependencies, and escapes the code it marks up |
| primitives | `@ark-ui/solid` | headless menus, popovers, selects and dialogs with real focus management, and `--transform-origin` so a popover scales from its trigger |
| fonts | `@fontsource-variable/inter`, `@fontsource-variable/geist-mono` | self-hosted variable fonts, so no third-party font request |

**What came from kiko, and what did not.** kiko's `apps/web-solid` is the reference for this stack, and Ingle takes its versions as they are: Solid 1.9, Vite 8, Tailwind 4.3, skullet for measured skeletons, torph for text morphs, and now sugar-high for code. The rest of kiko's list is declined until a frame asks for it: Kobalte and cmdk-solid (the palette is a plain list with its own keyboard handling, and no surface needs a focus-trapping primitive yet), TipTap and CodeMirror (every editor here is a plain textarea over markdown, not rich text), `@corvu/calendar` and `@corvu/resizable` (no date picker or split panes in the frames), virtua, mermaid, jszip, pdfjs-dist and `@pierre/trees` (no virtualised lists, diagrams, archives, PDFs or file trees), and Phosphor icons (the design names Lucide). The comparison is `docs/log/decisions.tsv` under P14.

## Data

The client talks to the Worker over the same contract the agent uses.

- **Commands** go to `POST /v1/cmd` as `{ id, op, args }`; every mutation in the UI is one op.
- **Streams** come from `GET /v1/socket` with subprotocol `ingle, bearer.<token>`: the socket first answers `{t:"hello",socket}` with its own id, then `{t:"sub", stream:"home"}` for the workspace projection and `{t:"sub", stream:"conv:<id>"}` for a conversation. A subscription answers one `{t:"snap"}` and then `{t:"ev"}` deltas, applied with chord's own `applyImmutable`. The hello id is how Settings marks this tab's own socket row, and a push row claims "This browser" only when its endpoint is the subscription this browser holds.
- **C12 is the renderer's contract.** `components/chat/markdown.tsx` gives a fenced block a header (language, Wrap, Copy), a numbered gutter and sugar-high tints, and a diff replaces the number with `+` or `−`; links are white with a grey underline that turns white on hover, italics render upright, a GFM table becomes a real table with the design's hairlines, and a reply's H1 renders one step down.
- **There is no Home or Inbox screen.** `#/` opens the first active project's chat, and questions are answered on their thread card in that chat with `request.respond`.
- **One entry renders once.** `components/chat/entries.tsx` maps a transcript's entries to items and renders them; the project chat and a thread's body both call it, so a new entry kind reaches both.
- **A send is keyed once per draft.** The composer mints one command id and `clientTs` per draft text and reuses them on retry, so a lost ack cannot add a second message: the host dedupes on the command id.
- **The composer's row is attach, preset, model, effort, send** (`V3-a`). The preset comes from `preset.list`'s `conversations` map and changes with `preset.select`; the effort comes from the snapshot's `pi.agent.thinkingLevel` and changes with `conv.configure { thinking }`, and the chip is drawn only when the catalog calls the current model reasoning. The model menu puts **This project** first, then **Catalog**, marks each price with `$` to `$$$`, and greys a model whose provider has no credential with `no key` instead of hiding it, from `models.list { includeUnkeyed: true }`. Once the catalog passes twelve models the menu searches the server (`models.list { query }`), because the op caps a reply at forty and a client-side filter could never reach the rest.
- **Auth** is the owner token, kept in `localStorage`, checked with `GET /v1/status` (`lib/auth.ts` `probe`), which tells four answers apart: ok enters the shell, 401 opens sign-in, 503 `{ error: "boot_failed", failure }` opens the boot-failed screen, and no answer still enters the shell so the offline screen can take over. Same-origin in production; Vite proxies `/v1` and `/health` to `wrangler dev` in development.
- **Offline** (`screens/offline.tsx`): the banner covers a drop shorter than 10 s; after 10 s without an open socket, or at once when `navigator.onLine` is false, a full-screen state covers the shell, which stays mounted beneath it. It shows whether the network or the home is the problem, counts down to the socket's next backoff dial, and offers Reconnect now (one `/v1/status` read, then an immediate dial with the backoff reset) and Reload. On showing, the same read sends a boot failure or a rotated token to its own screen. The browser's `online` event dials at once.
- **Boot failed** (`screens/boot-failed.tsx`): a home that cannot open answers only `POST /v1/repair`. The screen posts it without a body to show the failure and the journal and checkpoint row counts, then offers Check again (re-read `/v1/status`), Drop the journal (`{ drop: "journal" }`) and Start from empty (`{ drop: "all" }`), each drop behind an inline confirm and hidden when its rows are zero. A reply without a failure, or 409 because the home is open, enters the app. A 503 from repair means the token is a rotated one, which only the closed home could verify, so the screen asks for the deploy's `OWNER_TOKEN`.

Deviations from the backend spec that the UI needs are logged in `docs/log/decisions.tsv` as they land.

## Ops the client adds

The client needed owner-only ops the agent never asks for: the reads behind every pane, the writes behind the switches and editors, and the actions the Extensions and Profile panes press. Each is owner-only.

| Op | Args | Result |
| --- | --- | --- |
| `request.list` | `{ limit?, projectId? }` | pending questions across live projects, or one project's: `{ requests: [{ id, conversationId, projectId, projectName, threadTitle?, question, options?, askedAt }] }`. Reads run in parallel and never read a coordinator, which cannot hold an open request |
| `usage.summary` | `{}` | pi's usage ledger, summed: `{ spend, tokens, today, month, days[], cap, alert, byModel[], byTool[], byProject[] }`. `spend`/`tokens` are all time; `today` and `month` are `{ spend, tokens }` from `usage_daily`, flushed before the read; `cap` is the monthly cap or null, `alert` the daily alert in USD, and `byProject` sums each project's coordinator and threads |
| `usage.cap` / `usage.cap.set` | `{}` / `{ usd?, clear? }` | the monthly cap in USD or null; a cap at or below the month's spend makes `message.send` answer `forbidden` |
| `usage.alert` / `usage.alert.set` | `{}` / `{ usd }` | the daily alert threshold in USD (default 8) |
| `job.list` | `{ limit? }` | background jobs the jobs plugin holds: `{ jobs: [{ id, tool, title, parentId, startedAt, deadlineAt, detached, state: running\|completed\|failed, result? }] }` |
| `push.test` | `{}` | delivers one notification to every subscribed browser and answers `{ sent }`; it ignores open sockets, because the owner asked to see it arrive |
| `notify.prefs` | `{}` | `{ waiting, finished, failed, spend, schedule }`; the first four are true and `schedule` is false by default |
| `notify.set` | `{ waiting?, finished?, failed?, spend?, schedule? }` | the stored prefs after the patch; `announce` skips a kind that is off |
| `notify.quiet` / `notify.quiet.set` | `{}` / `{ enabled?, start?, end? }` | the quiet window as minutes since UTC midnight, defaults 22:00–07:00 and off; while it is on a report waits until the window ends, and a question waits until it has been paused two hours or the window ends, whichever is first. A held notification leaves the held list only after its send returns; one whose send throws is retried five minutes later |
| `push.list` | `{}` | `[{ endpoint, origin }]`, one row per subscribed browser, for the pane's Other devices list |
| `owner.read` / `owner.set` | `{}` / `{ name?, instructions? }` | `{ name, instructions }`, trimmed on write; the instructions render as the `<owner>` system section for every conversation |
| `session.list` / `session.close` | `{}` / `{ id? }` | one row per live socket `{ id, since, origin }`; close drops that socket, or every socket when the id is omitted, and answers `{ closed }` |
| `session.rotate` | `{}` | mints a new owner token, stores its digest, closes every socket, and answers `{ token }` once; the Worker answers 204 from `POST /v1/auth { token }` for a rotated token, so the old one is dead at the next request |
| `system.logs` | `{}` | `{ entries: [{ at, level: "warn" \| "error", text }] }`, the ring the home kept since it woke (200 lines, newest last); System downloads it as a text file |
| `skill.read` | `{ name }` | `{ name, description, markdown }`: the full skill document the model receives, stored copy first, then the derived header and body |
| `mcp.tools` | `{ name }` | `{ name, tools: [{ name, description? }] }` for one server, from its last successful connect |
| `mcp.resources` / `mcp.prompts` | `{ name }` | `{ name, resources: [{ uri, name, title?, description?, mimeType? }], templates: [...] }` and `{ name, prompts: [{ name, title?, description?, arguments? }] }`, read live from one server |
| `memory.profile.write` | `{ markdown }` | replaces the dreamer's profile document (20,000 characters; an empty string deletes it) and answers `{ profile_md }` |
| `prompt.list` / `prompt.put` / `prompt.delete` | `{ conversation? }` / `{ name, description?, text }` / `{ name }` | owner slash commands stored in kv `prompts`, plus prompts contributed by plugin rows, each with `source` (`{ kind: "stored" }` or `{ kind: "row", row }`), sorted by name; with `conversation`, a contributed prompt is omitted while its plugin is outside that conversation's preset. The composer expands `/name rest` into the prompt's text plus `rest` before `message.send` |
| `market.policy` / `market.policy.set` | `{}` / `{ autoUpdate }` | `{ autoUpdate }`, off by default; while on, `market.refresh` also installs each installed package's offered patch version (same major and minor) and reports them under `applied` |
| `market.refresh` | `{}` | `{ indexes: [{ url, title?, description?, error? }], applied? }`; `applied` is present only while auto-update is on |
| `market.skip` / `market.unskip` / `market.skipped` | `{ name, version? }` / `{ name }` / `{}` | a skipped version is marked in `market.search` and `market.entry` and `market.update` answers `{ application: "skipped" }`; `market.skipped` lists `[{ name, version }]` |
| `market.rollback` | `{ name }` | reinstalls the newest version in `market_history` other than the installed one, and answers an install result or `{ application: "failed", reason }` |
| `system.metrics` | `{}` | `{ uptimeMs, storageBytes, sockets, rows: { total, active }, pushDevices }`, all measured |
| `history.page` | `{ conversationId, before?, limit? }` | older entries than the socket snapshot: `{ entries, nextBefore? }`. `before` is inclusive, the same value the view reports as its first missing entry, so the first page starts at the snapshot's own boundary; `nextBefore` is the oldest returned id minus one |

The Home cell and the sidebar footer show `today.spend` and are labelled "Spend today"; the sidebar footer also shows the owner's name from `owner.read`. The Usage pane is the S2 frame: range tabs (7 days, this month, last month), a four-up row (spend and tokens for the range, models and tools in this home), a daily bar chart with a hover tooltip, the dashed daily-alert line and a Table toggle that lists the same days, then by project, by model and by tool, and a Monthly cap row with the month's progress, the 80% marker and the cap input. A day is cut at UTC midnight (11), and the pane says so. With a model that reports no cost the chart says so instead of drawing a flat row of bars.

The Notifications pane is the S4 left pane: the browser's subscription and Send test, the five kind switches, quiet hours with two time fields in local time plus the sentence about a question that has waited more than two hours, and Other devices with a Remove per endpoint. The Profile pane is the S4 middle pane: the owner's name, what the dreamer knows about the owner, the masked owner token with reveal and copy, Rotate token (the new token is shown once, this browser adopts it, every other device must sign in again), and Sign out everywhere, which rotates and then offers to keep this browser or leave. The Members pane is the single owner (there are no invites or roles) and the live sockets from `session.list`, newest first, this browser marked, with Disconnect (`session.close { id }`) on every other row and a note that only rotating keeps a device out. The Plugins pane counts running, off and not-running rows, filters them, lists optional rows with a `plugin.enable` switch and required rows without one, and grows the shared config form in place from `plugin.catalog`'s schema for a row that declares one (`plugin.configure`); installs and updates stay in Extensions. The System pane is the S4 right pane: the build, the plugin rows, measured services (plugin rows, storage, sockets, push devices, uptime), update and restart. Extensions › Sources lists the versions the owner skipped, with Unskip (`market.skipped`, `market.unskip`).

## Screens

| Route | Frame | What it is |
| --- | --- | --- |
| `#/` | D1 | the first active project's chat; with no project, an empty state that opens New project |
| `#/p/:slug`, `#/p/:slug/t/<threadId>` | D1, D2, D5, D6 | the project workspace: a centre panel with a tab bar of open conversations (the coordinator first, then every thread the person opened; the address names the active one) and a right pane. Thread tabs open from the sidebar, the palette, Overview, the view menu and transcript cards, close with × or a middle click, reorder by drag (pointer capture, 1.02 lift, neighbours slide), and persist per project in `localStorage["ingle.tabs"]` (`state/tabs.ts`); tabs of threads the home no longer lists are dropped. Right of the tabs: the active conversation's spend (the sum of `cost.total` over every bucket of its `docs["pi.usage"]`), a more menu (Project settings, Archive project, both opening the settings dialog with `project.update` and `project.archive`), and a show-pane button when the pane is hidden. A thread tab renders the thread's transcript with the same `Transcript` and the steer composer (`thread.send`, `thread.stop`). New thread (sidebar and the tab bar's +) opens a dialog that calls `thread.create` with a title and a task |
| right pane | D2 | `components/pane/views.tsx` holds the one registry: `PANE_VIEWS` (`{id, label, icon, render}`: Overview, Files, Memory, Schedules, Jobs, All threads) drives the pane tabs, the + view menu and the bodies, and `OVERVIEW_SECTIONS` (same shape without an icon) drives Overview. The + menu is a searchable Popover + Listbox: the views, then a Crew group of the project's threads (each opens a centre tab) and All threads with its count. Overview: Needs you (the home snapshot's `requests`, shown when `openRequests` > 0), In progress (working and waiting threads with their status line), Threads, and Drive (`file.list` count and the newest four files). Sections are collapsible 28px rows on secondary. Ingle has no issues or pull requests, so the pane has no PR section. Memory reads `memory.list` and `memory.suggested`; Schedules lists with `outcomes: true` |
| `#/p/:slug/files/<path>` | D5 | the file reader: breadcrumb, size and age, Copy and Download, the document, and the project's file list beside it |
| `#/p/:slug/run/<conversationId>` | D6 | one schedule's delivered run, read-only: the transcript the timer produced, with a breadcrumb back to the project |
| `#/schedules` | D6 | every schedule with pause, resume and delete, and a New schedule form whose When field is plain words parsed by `schedule.parse` with the next three runs shown before saving |
| `#/extensions` | E1–E7 | Discover, package page, install review, installed, sources, customize |
| `#/settings/:tab` | S1–S4, 08.x | General, Models + providers, Usage + cost, Notifications, Plugins, Members, Profile + token, System: a flat 200 sub-nav, then the page title and one-line description in a centred 800 column |
| `#/signin` | O1 | owner token |
| `#/welcome` | O2–O5 | first provider key, first project, first message, notifications |

Layout (v4 shell, render 12.1): the sidebar (240, on bg) holds the app mark, search (⌘K) and collapse (⌘B), the nav rows New thread, Schedules, Extensions and Settings, a Projects section with each project's state glyph and +, the current project's Threads (all statuses, newest first, with a filter toggle), and the owner menu (Settings; Theme: Dark, Light, Rose). The centre and the pane are panels inset 8 from the window with radius 12 and an 8 gutter; the pane is 432 and docked from 1280. Below 1280 the pane overlays the centre from the right; below 1024 the sidebar is a drawer opened from the menu button in the tab bar, closed by the scrim, its × or any navigation. Expand widens the pane over the centre. The chat column never exceeds 720. There is no rail and no bottom tab bar.

## Identity

Status uses the D Grid family from `I2`. A 3 by 3 grid of cells gives every state its own pattern and its own loop, so shape reads before colour, even at 12px and in greyscale. `components/ui/status-glyph.tsx` draws it wherever a thread, a report or a job shows state.

A project's mark is one of the 24 glyphs from `I3`, in `lib/project-glyphs.ts`. It is chosen from the project's own words, first match wins, and by slug when nothing matches. Picking or shuffling the glyph from New project would need a stored field on the project, which the schema does not have, so the mark stays derived. `components/chat/project-glyph.tsx` draws it on a 24-unit grid with a 1.5 stroke and at most one solid part, and puts the project's state on the tile's corner: a breathing white square while work runs, a pulsing orange square when someone waits on the owner, a red square after a failure. The glyph itself never changes.

Empty states use the pictograms from `I4`, in `components/ui/pictogram.tsx`, at 88px. A 64 grid, a 1.5px stroke that stays 1.5px at any size, one orange detail, and one small loop per drawing. They never sit inside a control.

Small loads use the arc from `I1`: a faint ring with a quarter arc turning once every 0.8s, in the current colour. The construction trace from the same frame is for a cold boot of the whole client. This client paints its shell at once and shows layout-matched skeletons (C11) while data lands, so the trace is never drawn.

## Motion

Motion follows design system §7. Every rule lives in `web/src/styles/motion.css`; tokens are in `tokens.css` (`--dur-color|press|release|tooltip|fast|base|slow|drawer`, `--dur-exit-fast|base|slow|sheet`, `--ease-color|in-out|drawer|enter|exit|spring`, `--loop-skeleton|shimmer|working|needs|waiting`). Enter and exit both run on out-quint, exits are about 70% of the entrance, only transform and opacity move (grow-in-place height is the one exception), and nothing starts below scale .96.

`web/src/lib/motion.ts` marks the root: `data-input="key"` after a keydown and `"pointer"` after a pointer moves or presses, and `data-hidden` while the tab is hidden. A keyboard-started action takes no time: the CSS zeroes the animation and transition durations under `data-input="key"`, `createPresence` and the extension sheets unmount at once, and the pane tab pill jumps. The command palette never animates. Hover is gated to `(hover: hover) and (pointer: fine)` by overriding Tailwind's `hover` variant, so taps never stick.

| Element | Motion | Reduce motion | Where |
| --- | --- | --- | --- |
| Button, `[role=button]` | press scale .97, 120 down / 160 up, out-quint; not on keyboard press | no scale | base layer |
| Button, link, tab, menu item, option, `.tint` | colour 100 in / 140 out, ease | same | base layer |
| Switch | knob `translate-x-3` and track colour, 150 in-out | instant | `knob` |
| Menu, popover, select, combobox (Ark) | opacity and scale .97 from `--transform-origin`, 150 / 100 | 120 fade | `[data-scope][data-part=content][data-state]` |
| Dialog | opacity and scale .96, centred, 200 / 140; scrim fades with it | 120 fade | `dialog-in`, `dialog-out`, `fade-in`, `fade-out` |
| Right sheet (install review, undocked pane) | translateX 100% to 0 on the drawer curve, 240 / 180 | 120 fade | `sheet-in`, `sheet-out` |
| Sidebar drawer (narrow screens) | translateX -100% to 0 on the drawer curve, 240 / 180 | 120 fade | `drawer-in`, `drawer-out` |
| Pane tab pill | FLIP translateX and scaleX, 200 in-out, pointer select only | instant | `glide` in `lib/motion.ts` |
| Pane swap | opacity and translateY 4, 150 | instant | `pane-swap` |
| Grow in place (overview sections) | Ark `--height` 0 to full, 200 / 140; content opacity and translateY 4 after 60 | instant | `[data-scope=collapsible]` |
| List arrival (sidebar projects and threads, overview sections) | first load only: opacity and translateY 8, 200, 40 stagger over the first six | 120 fade, no stagger | `arrive` via `arrival()` |
| Fan-out row, report card, page surface, composer menu | 200 rise / 240 rise / 200 scale .98 / 150 drop | 120 fade | `row-in`, `card-in`, `enter`, `menu-in` |
| Skeleton | Skullet `pulse`, 1 to .45 over 2.4s, held back 150 | still (Skullet) | `--skullet-animation` |
| Streaming text | background-position sweep, `--loop-shimmer`, linear | still, ink-3 | `shimmer` |
| Signal dots | working chase `--loop-working`, needs breathe `--loop-needs`; project corners breathe | still frame | `status.css`, `breath`, `pulse` |
| Drag to reorder tabs | lift scale 1.02 and overlay shadow | no lift | `[data-tab-lifted]` |

Loops (signal dots, shimmer, corners, spinners, pictograms) pause while the tab is hidden. There are no toasts yet, so the toast row of §7 has no consumer; the Send to Stop swap and attachment chips belong to the composer.

## Decisions taken from the review frame's open questions

1. **Owner token is the only sign-in.** The backend authenticates one owner; members would need their own auth, which does not exist.
2. **Jobs live in the workspace panel**, not per project.
3. **Auto-update defaults to patch only**; anything that adds a row or a permission always asks.
4. **The monthly cap pauses threads and asks**, rather than failing them.
5. **The community index is off by default** and labelled Unverified.
6. **There is no landing page.** The client is the signed-in app only.
7. **Tablet is a responsive layout**, not a separate frame set.
