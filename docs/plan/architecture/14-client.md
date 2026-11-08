# 20 · The web client

This section decides how the first-party web client is built and what it talks to. The client is a SolidJS app in `web/`, a separate package from the Worker so the backend gate never compiles it.

**Design source.** Structure, sizing, density and motion follow kiko's web client (`/home/keyur/kiko/apps/web-solid`); colour and the composition of controls follow `app.lighter.xyz`. The Doop canvas `fTzMMHDuiN` still defines which screens and controls exist, but its Factory palette and square geometry no longer apply. kiko is a reference for composition only: no kiko code, data or copy is imported. The tokens live in `web/src/styles/app.css`; a hex or oklch value exists once, in that block. A rule the screens keep:

- **White is the primary action.** A primary button is `ink` on `fg`, like lighter's connect button. It is never coloured.
- **Orange means "needs you". Nothing else.** `--color-waiting`.
- **Blue means "working". Nothing else.**
- **Mint successes, red failures, amber pauses, grey queue and cancel.**
- No product name in the UI chrome; the wordmark slot stays a placeholder.
- No star or sparkle icons. A pinned model uses the pin glyph, never a star. No coloured pictograms. No duotone project tiles.

## Theme

The palette is lighter's dark set, read from its bundle: a cool near-black page, four greys above it, white-alpha hairlines and fills, one pale lavender link. Type is kiko's: Satoshi for everything, Fraunces for page and display headings, JetBrains Mono for figures, labels and code. All three are self-hosted in `web/public/fonts`; no font request leaves the origin.

| Token | Value | Use |
| --- | --- | --- |
| `page` | `#06060c` | the page ground |
| `surface` | `oklch(18.5% .012 285)` | sidebar, cards, panels |
| `raised` | `oklch(19.3% .008 286)` | composer box, dialogs |
| `overlay` | `oklch(20.7% .011 285)` | menus, popovers, drawers |
| `elevated` | `oklch(29.1% .009 286)` | the hover/selected step |
| `fg` / `fg-2` / `fg-3` / `fg-4` | `96.4%` / `74.1%` / `64.5%` / `56%` lightness | ink, body, meta, faint |
| `line` / `line-inner` / `line-strong` | white `7%` / `10%` / `16%` | hairline, control edge, focus |
| `fill` / `fill-strong` | white `5%` / `8%` | field ground, resting control |
| `hover` / `selected` | white `6%` / `10%` | row hover, active row or tab |
| `accent` / `ink` | `oklch(96.4% 0 0)` / `#06060c` | primary button |
| `accent-text` | `oklch(85.7% .07 271.6)` | links and quiet emphasis |

Only the radii and type tokens that CSS reads are declared: `--radius-micro` 4, `control` 8, `card`/`pop` 12, `full` 999, and `--text-section` 26/32 with `--text-title` 40/44. Every other value in the scale is written where it is used, so the scale cannot drift from what renders: radii 16, 18, 20 and 22 on sheets, bubbles, heroes and the composer; controls at 32px, chips 26, rows 34, the sidebar 296, the rail 56, the top bar 52, the header 44, the chat column 820. Type is `nano` 10, `micro` 11, `hint` 11.5, `label` 12.5, `caption` 13, `row` 13.5, `ui` 14, `msg` 15/24, `heading` 16. Fraunces is set at weight 400 with `SOFT 50, WONK 0`.

A floating surface is one hairline inside a 24px/64px shadow (`--shadow-float`); a scrim is 50% black with `blur(6px) saturate(.7)`. A menu is `overlay`, 12px radius, 4px padding, 28-32px rows at 4px radius. Hovering a menu, a settings nav or a picker slides one fill between rows over 160ms on `--ease-kiko` instead of repainting each row (`components/ui/glide.tsx`). A segmented control is one 34px track (`line` edge, `fill` ground) with a sliding `selected` pill over a group of buttons, each carrying `aria-pressed`; every tab strip, range switch and editor switch uses that one primitive (`components/ui/segmented.tsx`). Every text input, select and textarea is the shared `FIELD` style (`components/ui/field.ts`), in five exports: `FIELD` and `MONO_FIELD` for one-line controls, `FIELD_AREA` and `MONO_AREA` for multi-line ones, `FIELD_ROW` for a bordered box that holds an icon and an unstyled input, and `FIELD_BOX` for a bordered box that holds a field and a footer bar. Each is a `line` edge on a `fill` ground with an inset top highlight; border and fill step up on hover and focus, and no field ever draws a ring. A pictogram's single accent mark is orange (`--color-waiting`), never white: white is the primary button, not decoration.

## Status palette

| State | Value | Word |
| --- | --- | --- |
| queued | `oklch(56% .006 286)` | Queued |
| working | `oklch(70% .12 255)` | Working |
| waiting | `#ff5a00` | Waiting on you |
| done | `oklch(82.8% .186 159)` | Done |
| failed | `oklch(67% .195 19)` | Failed |
| paused | `oklch(84% .172 84)` | Paused |
| cancelled | `oklch(47.8% .007 256)` | Cancelled |

Rows, chips and the sidebar use the **D Grid** family from `I2`: a 3×3 grid of square cells where every state is its own pattern, at 12, 16, 20 or 24px. Chat chips use the **Capsule** family, which pairs the glyph with the state's word.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| framework | SolidJS + Vite | the same stack kiko ships, and fine-grained reactivity suits a streaming transcript |
| styles | Tailwind 4 with `@theme` tokens | one token block generates every utility, so a hex exists once |
| router | a 40-line hash router in `src/lib/router.ts` | six routes, no dependency, works on any static host |
| icons | inline Lucide paths in `src/components/ui/icon.tsx` | the design names Lucide; inlining keeps the tree to the icons we use |
| deltas | `@earendil-works/chord/delta` `applyImmutable` | the server sends the watch's decoded ops, so the client applies them with the library that defines them instead of a copy |
| loading | `skullet` (measured skeletons), `torph` (text morph) | the owner's picks; a skeleton the size of the real content stops the layout shifting |
| syntax | `sugar-high`, the highlighter kiko ships | C12 tints fenced code; it is a few KB, has no dependencies, and escapes the code it marks up |
| primitives | Kobalte only if a surface needs real focus management | dialogs, the command palette and menus |

**What came from kiko, and what did not.** kiko's `apps/web-solid` is the reference for this stack, and Xin takes its versions as they are: Solid 1.9, Vite 8, Tailwind 4.3, skullet for measured skeletons, torph for text morphs, and now sugar-high for code. The rest of kiko's list is declined until a frame asks for it: Kobalte and cmdk-solid (the palette is a plain list with its own keyboard handling, and no surface needs a focus-trapping primitive yet), TipTap and CodeMirror (every editor here is a plain textarea over markdown, not rich text), `@corvu/calendar` and `@corvu/resizable` (no date picker or split panes in the frames), virtua, mermaid, jszip, pdfjs-dist and `@pierre/trees` (no virtualised lists, diagrams, archives, PDFs or file trees), and Phosphor icons (the design names Lucide). The comparison is `docs/log/decisions.tsv` under P14.

## Data

The client talks to the Worker over the same contract the agent uses.

- **Commands** go to `POST /v1/cmd` as `{ id, op, args }`; every mutation in the UI is one op.
- **Streams** come from `GET /v1/socket` with subprotocol `xin, bearer.<token>`: the socket first answers `{t:"hello",socket}` with its own id, then `{t:"sub", stream:"home"}` for the workspace projection and `{t:"sub", stream:"conv:<id>"}` for a conversation. A subscription answers one `{t:"snap"}` and then `{t:"ev"}` deltas, applied with chord's own `applyImmutable`. The hello id is how Settings marks this tab's own socket row, and a push row claims "This browser" only when its endpoint is the subscription this browser holds.
- **C12 is the renderer's contract.** `components/chat/markdown.tsx` gives a fenced block a header (language, Wrap, Copy), a numbered gutter and sugar-high tints, and a diff replaces the number with `+` or `−`; links are white with a grey underline that turns white on hover, italics render upright, a GFM table becomes a real table with the design's hairlines, and a reply's H1 renders one step down.
- **Home answers instead of redirecting.** The `home` snapshot carries up to five pending questions (`{ requests: [...] }`, contributed by the questions plugin through `wire.home`), so a Needs You row shows the question and its option chips and answers with the same `request.respond` the Inbox uses; a failed row keeps Retry. The projection's own `openRequests` count still drives the numbers and the mobile Inbox dot.
- **One entry renders once.** `components/chat/entries.tsx` maps a transcript's entries to items and renders them; the project chat and a thread's body both call it, so a new entry kind reaches both.
- **A send is keyed once per draft.** The composer mints one command id and `clientTs` per draft text and reuses them on retry, so a lost ack cannot add a second message: the host dedupes on the command id.
- **The composer is a 16px raised box with one hairline, a 15px/24 textarea, and a footer of 32px round controls** (`V3-a`): attach, preset, model, effort, then a 32px round send that is white when it will send. Menus open upward from their trigger, are `overlay` surfaces with 4px padding, and slide one fill between rows. The preset comes from `preset.list`'s `conversations` map and changes with `preset.select`; the effort comes from the snapshot's `pi.agent.thinkingLevel` and changes with `conv.configure { thinking }`, and the chip is drawn only when the catalog calls the current model reasoning.
- **The model picker is a 400×392 anchored panel** (`components/chat/model-picker.tsx`): a 112px provider rail of full provider names on the left, a server-backed search field, 36px rows with `$` to `$$$` price marks and `no key` on an unkeyed provider, a pin per row (favourites are local, never a star), an animated check on the current model, and arrow/Enter keyboard movement. It reads `models.list { includeUnkeyed: true }`; once the catalog passes twelve models the search is the server's (`models.list { query }`), because the op caps a reply at forty and a client-side filter could never reach the rest.
- **Auth** is the owner token, kept in `localStorage`, checked with `GET /v1/status`. Same-origin in production; Vite proxies `/v1` and `/health` to `wrangler dev` in development.

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
| `notify.quiet` / `notify.quiet.set` | `{}` / `{ enabled?, start?, end? }` | the quiet window as minutes since UTC midnight, defaults 22:00–07:00 and off; while it is on a report waits until the window ends, and a question waits until it has been paused two hours or the window ends, whichever is first |
| `push.list` | `{}` | `[{ endpoint, origin }]`, one row per subscribed browser, for the pane's Other devices list |
| `owner.read` / `owner.set` | `{}` / `{ name?, instructions? }` | `{ name, instructions }`, trimmed on write; the instructions render as the `<owner>` system section for every conversation |
| `session.list` / `session.close` | `{}` / `{ id? }` | one row per live socket `{ id, since, origin }`; close drops that socket, or every socket when the id is omitted, and answers `{ closed }` |
| `session.rotate` | `{}` | mints a new owner token, stores its digest, closes every socket, and answers `{ token }` once; the Worker answers 204 from `POST /v1/auth { token }` for a rotated token, so the old one is dead at the next request |
| `system.logs` | `{}` | `{ entries: [{ at, level: "warn" \| "error", text }] }`, the ring the home kept since it woke (200 lines, newest last); System downloads it as a text file |
| `skill.read` | `{ name }` | `{ name, description, markdown }`: the full skill document the model receives, stored copy first, then the derived header and body |
| `mcp.tools` | `{ name }` | `{ name, tools: [{ name, description? }] }` for one server, from its last successful connect |
| `memory.profile.write` | `{ markdown }` | replaces the dreamer's profile document (20,000 characters; an empty string deletes it) and answers `{ profile_md }` |
| `prompt.list` / `prompt.put` / `prompt.delete` | `{}` / `{ name, description?, text }` / `{ name }` | owner slash commands stored in kv `prompts`: `[{ name, description?, text }]` sorted by name. The composer expands `/name rest` into the prompt's text plus `rest` before `message.send` |
| `market.policy` / `market.policy.set` | `{}` / `{ autoUpdate }` | `{ autoUpdate }`, off by default; while on, `market.refresh` also installs each installed package's offered patch version (same major and minor) and reports them under `applied` |
| `market.refresh` | `{}` | `{ indexes: [{ url, title?, description?, error? }], applied? }`; `applied` is present only while auto-update is on |
| `market.skip` / `market.unskip` / `market.skipped` | `{ name, version? }` / `{ name }` / `{}` | a skipped version is marked in `market.search` and `market.entry` and `market.update` answers `{ application: "skipped" }`; `market.skipped` lists `[{ name, version }]` |
| `market.rollback` | `{ name }` | reinstalls the newest version in `market_history` other than the installed one, and answers an install result or `{ application: "failed", reason }` |
| `system.metrics` | `{}` | `{ uptimeMs, storageBytes, sockets, rows: { total, active }, pushDevices }`, all measured |
| `history.page` | `{ conversationId, before?, limit? }` | older entries than the socket snapshot: `{ entries, nextBefore? }`. `before` is inclusive, the same value the view reports as its first missing entry, so the first page starts at the snapshot's own boundary; `nextBefore` is the oldest returned id minus one |

The Home cell and the sidebar footer show `today.spend` and are labelled "Spend today"; the sidebar footer also shows the owner's name from `owner.read`. The Usage pane is the S2 frame: range tabs (7 days, this month, last month), a four-up row (spend and tokens for the range, models and tools in this home), a daily bar chart with a hover tooltip, the dashed daily-alert line and a Table toggle that lists the same days, then by project, by model and by tool, and a Monthly cap row with the month's progress, the 80% marker and the cap input. A day is cut at UTC midnight (11), and the pane says so. With a model that reports no cost the chart says so instead of drawing a flat row of bars.

The Notifications pane is the S4 left pane: the browser's subscription and Send test, the five kind switches, quiet hours with two time fields in local time plus the sentence about a question that has waited more than two hours, and Other devices with a Remove per endpoint. The Profile pane is the S4 middle pane: the owner's name, what the dreamer knows about the owner, the masked owner token with reveal and copy, Rotate token (the new token is shown once, this browser adopts it, every other device must sign in again), the live sockets with a Sign out per socket, and Sign out everywhere, which rotates and then offers to keep this browser or leave. The System pane is the S4 right pane: the build, the plugin rows, measured services (plugin rows, storage, sockets, push devices, uptime), update and restart. Extensions › Sources lists the versions the owner skipped, with Unskip (`market.skipped`, `market.unskip`).

## Screens

| Route | Frame | What it is |
| --- | --- | --- |
| `#/` | D3 | Home: greeting, the four counts, Needs You, the project grid |
| `#/p/:slug` | D1, D2, D5, D6 | project chat: transcript, composer, right panel (Threads, Files, Memory, Schedules, Jobs). An opened thread widens the panel to 520, so the coordinator stays in view (`V3-a`). The more menu in the top bar opens project settings: the same name and goal as New project, saved with `project.update`, and Archive with `project.archive`. Memory reads `memory.list` and `memory.suggested`, and drives add, pin, edit, forget and dismiss; Schedules lists with `outcomes: true` and draws the last six runs as dots |
| `#/p/:slug/files/<path>` | D5 | the file reader: breadcrumb, size and age, Copy and Download, the document, and the project's file list beside it |
| `#/p/:slug/run/<conversationId>` | D6 | one schedule's delivered run, read-only: the transcript the timer produced, with a breadcrumb back to the project |
| `#/schedules` | D6 | every schedule with pause, resume and delete, and a New schedule form whose When field is plain words parsed by `schedule.parse` with the next three runs shown before saving |
| `#/inbox` | D7 | everything that waits on the owner |
| `#/extensions` | E1–E7 | Discover, package page, install review, installed, sources, customize |
| `#/settings/:tab` | S1–S4 | General, Usage, Models, Notifications, Profile, System |
| `#/signin` | O1 | owner token |
| `#/welcome` | O2–O5 | first provider key, first project, first message, notifications |

Layout follows the breakpoint table in `DDL0wyMU8c`, at kiko's sizes. At 1280 and up the sidebar is 296 wide with labels and the panel is docked: 400 wide, 440 from 1440. From 1024 to 1279 the sidebar collapses to the 56px rail and the panel is a non-modal drawer, 400 wide with an elevation shadow and no scrim, so the chat stays readable at the left edge. Below 1024 the sidebar becomes the bottom tab bar and the panel becomes a bottom sheet at 76% height, on a blurred scrim, with a grab handle that drags it down to dismiss. An opened thread takes the docked panel to 520 (`V3-a`). The chat column never exceeds 820, and the composer and top bar align to it. Settings is a 1240×820 surface on the page: a 240px side nav of 34px rows with the glide fill, a serif 26px page title, and 12px cards inside.

## Identity

Status uses the D Grid family from `I2`. A 3 by 3 grid of cells gives every state its own pattern and its own loop, so shape reads before colour, even at 12px and in greyscale. `components/ui/status-glyph.tsx` draws it wherever a thread, a report or a job shows state.

A project's mark is one of the 24 glyphs from `I3`, in `lib/project-glyphs.ts`. It is chosen from the project's own words, first match wins, and by slug when nothing matches. Picking or shuffling the glyph from New project would need a stored field on the project, which the schema does not have, so the mark stays derived. `components/chat/project-glyph.tsx` draws it on a 24-unit grid with a 1.5 stroke and at most one solid part, and puts the project's state on the tile's corner: a breathing white square while work runs, a pulsing orange square when someone waits on the owner, a red square after a failure. The glyph itself never changes.

Empty states use the pictograms from `I4`, in `components/ui/pictogram.tsx`, at 88px. A 64 grid, a 1.5px stroke that stays 1.5px at any size, one orange detail, and one small loop per drawing. They never sit inside a control.

Small loads use the arc from `I1`: a faint ring with a quarter arc turning once every 0.8s, in the current colour. The construction trace from the same frame is for a cold boot of the whole client. This client paints its shell at once and shows layout-matched skeletons (C11) while data lands, so the trace is never drawn.

## Motion

Tokens are `--dur-instant|fast|base|slow|deliberate` (80/120/200/320/450) on kiko's curves: `--ease-kiko` `cubic-bezier(.2,.8,.2,1)` for most things, `--ease-snap` `cubic-bezier(.32,.72,0,1)` for exits, and `--ease-pop` `cubic-bezier(.34,1.3,.64,1)` only for a surface arriving from an edge on touch. Exits are always faster or equal to entrances, never slower. A hover fill glides between rows in 160ms; a press is 120ms.

| Surface | Enter | Exit | Utility |
| --- | --- | --- | --- |
| Dialog | 200, opacity and scale .98 to 1, kiko curve | 140, exit curve | `enter`, `dialog-out` |
| Right sheet and panel drawer | 320, 24px from the right plus fade, standard | 200, exit curve | `slide-right`, `slide-right-out` |
| Bottom sheet | 320 on the spring, 100% from the bottom | 200, exit curve | `sheet-in`, `sheet-out` |
| Menu and popover | 200, 4px drop and .98 scale, kiko curve | unmount | `menu-in` |
| Glide fill | 160, transform and size, kiko curve | 120 fade | `.glide-mark` |
| Fan-out row | 200, 4px drop, 40ms stagger capped at six | unmount | `row-in` |
| Report card | 320, 6px rise | unmount | `card-in` |
| Scrim | 200 linear fade | 200 | `fade-in` |

Panel tabs slide their pill over 200 and crossfade the body over 140. Controls answer within 120ms: a press scales .98, a hover tints in 120 and fades out over 120, a toggle knob travels in 120, and a rejected input shakes 4px once over 240. `prefers-reduced-motion` collapses every animation and transition to 1ms.

## Decisions taken from the review frame's open questions

1. **Owner token is the only sign-in.** The backend authenticates one owner; members would need their own auth, which does not exist.
2. **Jobs live in the workspace panel**, not per project.
3. **Auto-update defaults to patch only**; anything that adds a row or a permission always asks.
4. **The monthly cap pauses threads and asks**, rather than failing them.
5. **The community index is off by default** and labelled Unverified.
6. **The landing page keeps a placeholder name** until the owner picks one.
7. **Tablet is a responsive layout**, not a separate frame set.
