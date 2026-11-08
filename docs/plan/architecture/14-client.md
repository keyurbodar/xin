# 20 · The web client

This section decides how the first-party web client is built and what it talks to. The client is a SolidJS app in `web/`, a separate package from the Worker so the backend gate never compiles it.

**Design source.** The design system is the Doop canvas `fTzMMHDuiN`, guideline `xin-system`: dark only, Factory core-v2 tokens, Geist and Geist Mono, one orange, square geometry. The frames are the specification for every screen; the guideline is the specification for every token. A rule the frames follow and this client must keep:

- **Orange means "needs you" or "primary action". Nothing else.**
- **Blue means "working". Nothing else.** (status palette below)
- No product name in the UI chrome; the wordmark slot stays a placeholder.
- No star or sparkle icons. No coloured pictograms. No duotone project tiles.

## Status palette

| State | Hex | Word |
| --- | --- | --- |
| queued | `#80756f` | Queued |
| working | `#6aa8ff` | Working |
| waiting | `#ff5a00` | Waiting on you |
| done | `#6fae5d` | Done |
| failed | `#f0442e` | Failed |
| paused | `#f7a828` | Paused |
| cancelled | `#6b615c` | Cancelled |

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

The Notifications pane is the S4 left pane: the browser's subscription and Send test, the five kind switches, quiet hours with two time fields in local time plus the sentence about a question that has waited more than two hours, and Other devices with a Remove per endpoint. The Profile pane is the S4 middle pane: the owner's name, what the dreamer knows about the owner, the masked owner token with reveal and copy, Rotate token (the new token is shown once, this browser adopts it, every other device must sign in again), the live sockets with a Sign out per socket, and Sign out everywhere, which rotates and then offers to keep this browser or leave. The System pane is the S4 right pane: the build, the plugin rows, measured services (plugin rows, storage, sockets, push devices, uptime), update and restart.

## Screens

| Route | Frame | What it is |
| --- | --- | --- |
| `#/` | D3 | Home: greeting, the four counts, Needs You, the project grid |
| `#/p/:slug` | D1, D2, D5, D6 | project chat: transcript, composer, right panel (Threads, Files, Memory, Schedules, Jobs). Memory reads `memory.list` and `memory.suggested`, and drives add, pin, edit, forget and dismiss; Schedules lists with `outcomes: true` and draws the last six runs as dots |
| `#/p/:slug/files/<path>` | D5 | the file reader: breadcrumb, size and age, Copy and Download, the document, and the project's file list beside it |
| `#/p/:slug/run/<conversationId>` | D6 | one schedule's delivered run, read-only: the transcript the timer produced, with a breadcrumb back to the project |
| `#/schedules` | D6 | every schedule with pause, resume and delete, and a New schedule form whose When field is plain words parsed by `schedule.parse` with the next three runs shown before saving |
| `#/inbox` | D7 | everything that waits on the owner |
| `#/extensions` | E1–E7 | Discover, package page, install review, installed, sources, customize |
| `#/settings/:tab` | S1–S4 | General, Usage, Models, Notifications, Profile, System |
| `#/signin` | O1 | owner token |
| `#/welcome` | O2–O5 | first provider key, first project, first message, notifications |

Mobile (M1–M8) is the same surfaces with the sidebar replaced by a sheet and the right panel by a bottom sheet; the breakpoint is 1024px.

## Decisions taken from the review frame's open questions

1. **Owner token is the only sign-in.** The backend authenticates one owner; members would need their own auth, which does not exist.
2. **Jobs live in the workspace panel**, not per project.
3. **Auto-update defaults to patch only**; anything that adds a row or a permission always asks.
4. **The monthly cap pauses threads and asks**, rather than failing them.
5. **The community index is off by default** and labelled Unverified.
6. **The landing page keeps a placeholder name** until the owner picks one.
7. **Tablet is a responsive layout**, not a separate frame set.
