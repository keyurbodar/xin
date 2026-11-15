# 20 · The web client

This section decides how the first-party web client is built and what it talks to. The client is a SolidJS app in `web/`, a separate package from the Worker: the local gate typechecks it (`tsgo -p web/tsconfig.json`), CI's `web` job installs, typechecks and builds it, and neither bundles it into the Worker, because the Worker's own bundle step builds `src/worker.ts` alone.

**Hosting.** A deploy serves `web/dist` from the Worker's own origin as static assets, so the client, `/v1`, `/files` and the socket share one origin and no request crosses it. The assets arrive on the deploy command (`wrangler deploy --assets ./web/dist`), not in `wrangler.jsonc`, because the gate's `bundle` step runs on machines where `web/dist` does not exist.

**Design source.** The design system is the Ingle v4 handoff (Doop canvas `elsVZejERK`, tokens in `web/src/styles/tokens.css`), with the owner's reference screenshots as the final word where they disagree. Dark is the default, `[data-theme="light"]` is its matched counterpart and `[data-theme="rose"]` is a dark variant with a rose accent; the action colour is `--color-accent`, which `primary` follows; the choice is per device (`localStorage` key `ingle.theme`, applied before first paint by `index.html`). Type is Inter for the interface and Geist Mono for ids, costs and code, both self-hosted from `@fontsource-variable`; there is no serif anywhere. Every colour, radius, size, shadow and motion curve is a token, and components reference tokens, never hex.

- **The accent (`--color-accent`, which `primary` follows) is the one action colour.** It is blue in dark and light and rose in the rose theme. Needs-you stays blue and is told apart by the Signal's shape.
- Status colours never follow the accent: working amber, done green, failed red, merged violet; waiting is ink-3.

## Status palette

The values live in `tokens.css`; the `.sig` rules in `ingle-motion.css` pick each state's token, and `web/src/lib/status.ts` maps backend statuses onto the states and names them.

| State | Token | Word | Shape | Backend status |
| --- | --- | --- | --- | --- |
| idle | `ink-3` | Stopped | centre dot, still | `cancelled`; a paused schedule |
| queued | `ink-3` | Queued | dim grid, still | anything not yet running |
| working | `working` | Working | chasing ring, `--loop-chase` | `working` |
| needs | `needs` | Needs you | plus, breathes `--loop-breathe` | `waiting` (a question to the owner) |
| done | `done` | Done | check, still | `completed` |
| failed | `failed` | Failed | X, still | `failed` |

Every status in the client is the **Signal** (v5 page 16.1): a 3×3 grid of round dots at 12, 14, 16 or 20px, `components/ui/signal.tsx` over the `.sig` rules. Shape reads before colour, settled states crossfade dot by dot in 200ms, and only working and needs loop. The motion file also draws waiting and merged, which no backend status produces, so the client does not use them. fTz's paused and cancelled have no Signal shape (design system §0.8), so a cancelled thread and a paused schedule show idle.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| framework | SolidJS + Vite | the same stack kiko ships, and fine-grained reactivity suits a streaming transcript |
| styles | Tailwind 4 with `@theme` tokens | one token block generates every utility, so a hex exists once |
| router | a 40-line hash router in `web/src/lib/router.ts` | six routes, no dependency, works on any static host |
| icons | `lucide-solid` | the design names Lucide; imports are per icon, so the bundle carries only the icons used |
| deltas | `@earendil-works/chord/delta` `applyImmutable` | the server sends the watch's decoded ops, so the client applies them with the library that defines them instead of a copy |
| loading | `torph` (text morph); skeletons are plain `.im-skeleton` blocks | the owner's pick for text; v5 page 16.3 draws fixed skeletons at the real rows' measure, so skullet's measured ghosts were dropped |
| syntax | `sugar-high`, the highlighter kiko ships | C12 tints fenced code; it is a few KB, has no dependencies, and escapes the code it marks up |
| primitives | `@ark-ui/solid` | headless menus, popovers, selects and dialogs with real focus management, and `--transform-origin` so a popover scales from its trigger |
| fonts | `@fontsource-variable/inter`, `@fontsource-variable/geist-mono` | self-hosted variable fonts, so no third-party font request |

**What came from kiko, and what did not.** kiko's `apps/web-solid` is the reference for this stack, and Ingle takes its versions as they are: Solid 1.9, Vite 8, Tailwind 4.3, torph for text morphs (skullet was taken too and later dropped for page 16.3's skeletons), and now sugar-high for code. The rest of kiko's list is declined until a frame asks for it: Kobalte and cmdk-solid (the palette is a plain list with its own keyboard handling, and no surface needs a focus-trapping primitive yet), TipTap and CodeMirror (every editor here is a plain textarea over markdown, not rich text), `@corvu/calendar` and `@corvu/resizable` (no date picker or split panes in the frames), virtua, mermaid, jszip, pdfjs-dist and `@pierre/trees` (no virtualised lists, diagrams, archives, PDFs or file trees), and Phosphor icons (the design names Lucide). The comparison is `docs/log/decisions.tsv` under P14.

## Data

The client talks to the Worker over the same contract the agent uses.

- **Commands** go to `POST /v1/cmd` as `{ id, op, args }`; every mutation in the UI is one op.
- **Streams** come from `GET /v1/socket` with subprotocol `ingle, bearer.<token>`: the socket first answers `{t:"hello",socket}` with its own id, then `{t:"sub", stream:"home"}` for the workspace projection and `{t:"sub", stream:"conv:<id>"}` for a conversation. A subscription answers one `{t:"snap"}` and then `{t:"ev"}` deltas, applied with chord's own `applyImmutable`. The hello id is how Settings marks this tab's own socket row, and a push row claims "This browser" only when its endpoint is the subscription this browser holds.
- **C12 is the renderer's contract.** `components/chat/markdown.tsx` gives a fenced block a header (language, Wrap, Copy), a numbered gutter and sugar-high tints, and a diff replaces the number with `+` or `−`; links are white with a grey underline that turns white on hover, italics render upright, a GFM table becomes a real table with the design's hairlines, and a reply's H1 renders one step down.
- **There is no Home or Inbox screen.** `#/` opens the first active project's chat, and questions are answered on their thread card in that chat with `request.respond`.
- **One entry renders once.** `components/chat/entries.tsx` maps a transcript's entries to items and renders them; the project chat and a thread's body both call it, so a new entry kind reaches both.
- **A send is keyed once per draft.** The composer mints one command id and `clientTs` per draft text and reuses them on retry, so a lost ack cannot add a second message: the host dedupes on the command id.
- **The composer's row is +, model, reasoning, then the context ring and send** (`web/src/components/composer/`, all popovers on `@ark-ui/solid`, scaling .97→1 from `--transform-origin` over 150ms, 100ms out). The **+ menu** uploads attachments (also ⌘/, drag-and-drop and paste) and inserts mentions of what the project has: Threads (`@thread:<id>`, from the project's thread groups), Files (`@<path>`, from `file.list` under the project, attachments excluded), Skills (`@skill:<name>`, `skill.list`), Prompts (`/name `, `prompt.list`, expanded on send) and Memory (the note quoted, `memory.list { scope: project:<id> }`); a category with nothing in it is hidden. **Attachments** are a grid of chips with a thumbnail for images, the size and kind, and the upload's real XHR progress as Preparing → percent → Finishing; removing one aborts its request (`uploadFile` takes an `AbortSignal`). The **model picker** is a popover with a search field, a rail of provider marks (favourites star first), and a listbox grouped by provider with favourites first and a check on the current model; a model whose provider has no credential is greyed with `no key` and cannot be picked, from `models.list { includeUnkeyed: true }`, and a query searches the server (`models.list { query }`). Favourites are kept in this browser (`localStorage` `ingle.favoriteModels`) because no op writes `owner.favorites`. The **reasoning menu** lists the `ThinkingSchema` levels (Off, Low, Medium, High) when the model reasons, set with `conv.configure { thinking }`, and a **Modes** section with the presets (`preset.select`), fixed once the conversation has started. The **context ring** reads `conv.context` when the composer mounts, when its popover opens and when a turn ends (`pi.live.run` goes away), never on a timer, and shows used / window, one row per category (System prompt, Tools, Conversation), Compact at `compactAt` / window, and "estimated" when `measured` is false. **Send** becomes **Stop** (`conv.stop`, inverse) while the run is live and the draft is empty.
- **Auth** is the owner token, kept in `localStorage`, checked with `GET /v1/status` (`lib/auth.ts` `probe`), which tells four answers apart: ok enters the shell, 401 opens sign-in, 503 `{ error: "boot_failed", failure }` opens the boot-failed screen, and no answer still enters the shell so the offline screen can take over. Same-origin in production; Vite proxies `/v1` and `/health` to `wrangler dev` in development.
- **Offline** (`screens/offline.tsx`): the banner covers a drop shorter than 10 s; after 10 s without an open socket, or at once when `navigator.onLine` is false, a full-screen `aria-modal` state covers the shell, which stays mounted beneath it but `inert`. Tab is trapped inside it (`lib/focus.ts`), Reconnect now takes focus when it opens, and focus returns when it closes. It shows whether the network or the home is the problem, counts down to the socket's next backoff dial, and offers Reconnect now (one `/v1/status` read, then `dialNow`) and Reload. On showing, the same read sends a boot failure or a rotated token to its own screen. The socket keeps one retry chain: `open()` cancels the pending backoff timer and any wait for visibility, and `dialNow()` (Reconnect now and the browser's `online` event) does nothing while a dial is in flight.
- **Boot failed** (`screens/boot-failed.tsx`, offers in `lib/repair.ts`): a home that cannot open answers only `POST /v1/repair`. The screen posts it without a body to show the failure and the journal and checkpoint row counts, then offers Check again (re-read `/v1/status`); Drop the journal (`{ drop: "journal" }`) only when a checkpoint exists, worded as a rewind to it; and Start from empty behind typing the word `empty`, which sends `{ drop: "journal" }` when there is no checkpoint (dropping the journal then empties pi just the same) and `{ drop: "all" }` otherwise. Start from empty says what goes: projects and their threads, schedules, jobs, captains, goals, questions and artifacts, which are pi documents. Every drop keeps the home's own tables and storage: provider keys, files, plugin rows and their config, the owner's name and instructions, model defaults, notification settings, memory notes, presets and daily usage totals. A confirm focuses its first control and closes on Escape. A reply without a failure, or 409 because the home is open, enters the app; a 401 means the token is no longer valid (the home authorizes repair itself, rotated tokens included) and opens sign-in.

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
| `session.rotate` | `{}` | mints a new owner token, stores its digest, closes every socket, and answers `{ token }` once; the home authorizes every forwarded request against the digest it holds in memory, so the old token is dead at the next request |
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

The Notifications pane is the S4 left pane: the browser's subscription and Send test, the five kind switches, quiet hours with two time fields in local time plus the sentence about a question that has waited more than two hours, and Other devices with a Remove per endpoint. The Profile pane is the S4 middle pane: the owner's name, what the dreamer knows about the owner, the masked owner token with reveal and copy, Rotate token (the new token is shown once, this browser adopts it, every other device must sign in again), and Sign out everywhere, which rotates and then offers to keep this browser or leave. General's Reduce motion select (System or On, in `localStorage["ingle.motion"]`, applied in `index.html` before first paint like the theme) sets `:root[data-motion="reduce"]` for On and leaves it unset for System, which the motion file's `prefers-reduced-motion` query then governs; the motion file has no opt-out from the OS setting, so there is no Off. The Members pane is the single owner (there are no invites or roles) and the live sockets from `session.list`, newest first, this browser marked, with Disconnect (`session.close { id }`) on every other row and a note that only rotating keeps a device out. The Plugins pane counts running, off and not-running rows, filters them, lists optional rows with a `plugin.enable` switch and required rows without one, and grows the shared config form in place from `plugin.catalog`'s schema for a row that declares one (`plugin.configure`). Rows are keyed by id, so the reload after a switch keeps open forms and their drafts; installs and updates stay in Extensions. The System pane is the S4 right pane: the build, the plugin rows, measured services (plugin rows, storage, sockets, push devices, uptime), update and restart. Extensions › Sources lists the versions the owner skipped, with Unskip (`market.skipped`, `market.unskip`).

## Screens

| Route | Frame | What it is |
| --- | --- | --- |
| `#/` | D1 | the first active project's chat; with no project, an empty state that opens New project |
| `#/p/:slug`, `#/p/:slug/t/<threadId>` | D1, D2, D5, D6 | the project workspace: a centre panel with a tab bar of open conversations (the coordinator first, then every thread the person opened; the address names the active one) and a right pane. Thread tabs open from the sidebar, the palette, Overview, the view menu and transcript cards, close with × or a middle click, reorder by drag (pointer capture, 1.02 lift, neighbours slide), and persist per project in `localStorage["ingle.tabs"]` (`state/tabs.ts`); tabs of threads the home no longer lists are dropped. Right of the tabs: the active conversation's spend (the sum of `cost.total` over every bucket of its `docs["pi.usage"]`), a more menu (Project settings, Archive project, both opening the settings dialog with `project.update` and `project.archive`), and a show-pane button when the pane is hidden. A thread tab renders the thread's transcript with the same `Transcript` and the steer composer (`thread.send`, `thread.stop`). New thread (sidebar and the tab bar's +) opens a dialog that calls `thread.create` with a title and a task |
| right pane | D2 | `components/pane/views.tsx` holds the one registry: `PANE_VIEWS` (`{id, label, icon, render}`: Overview, Files, Memory, Schedules, Jobs, All threads, plus one `issue:<id>` view per opened issue) drives the pane tabs, the + view menu and the bodies, and `OVERVIEW_SECTIONS` (same shape without an icon) drives Overview. The + menu is a searchable Popover + Listbox: the views, then a Crew group of the project's threads (each opens a centre tab) and All threads with its count. Overview: Needs you (the home snapshot's `requests`, shown when `openRequests` > 0), In progress (working and waiting threads with their status line), Issues, Threads, and Drive (`file.list` count and the newest four files). Sections are collapsible 28px rows on secondary. Issues (`pane/issues.tsx`, decisions in `lib/issues.ts`) is the project's open issues from one `issue.list { project, closed: false, limit: 200 }` plus `issue.states` (read once per session), grouped under their open state with Needs you first and then the owner's state order, by priority inside a state; each row has its state ring, title, `#id`, due date (red once overdue), linked-thread count, priority bars and assignee chip, and the header's + opens New issue (title, then optional priority and state; `issue.create` with the project). A row opens the pane view `issue:<id>`, tabbed as "Issue #N" (`pane/issue.tsx`, resolved by `paneEntry` outside the + menu's list): title, a State and a Priority picker (`issue.update`), due, assignees, parent, description, sub-issues, Blocks / Blocked by / Related, linked threads (each opens its tab) and pull requests, then the timeline with comments and their one level of replies, and a comment box (`issue.comment`, Ctrl/⌘+Enter). Both re-read only when the home snapshot's `issues.rev` settles (a 275 ms trailing debounce in `state/issues.ts`, so a burst costs one read; the rev is global, so another project's change re-lists this one), each read is cached per key and rev so switching views at one rev sends nothing, and `issue.states` is read once and again only when a list or issue names an unknown state, whose issues wait in a group named by the id meanwhile. Ingle has no pull requests, so the pane has no PR section. Memory reads `memory.list` and `memory.suggested`; Schedules lists with `outcomes: true` |
| `#/p/:slug/files/<path>` | D5 | the file reader: breadcrumb, size and age, Copy and Download, the document, and the project's file list beside it |
| `#/p/:slug/run/<conversationId>` | D6 | one schedule's delivered run, read-only: the transcript the timer produced, with a breadcrumb back to the project |
| `#/schedules` | D6 | every schedule with pause, resume and delete, and a New schedule form whose When field is plain words parsed by `schedule.parse` with the next three runs shown before saving |
| `#/extensions` | E1–E7 | Discover, package page, install review, installed, sources, customize |
| `#/settings/:tab` | S1–S4, 08.x | General, Models + providers, Usage + cost, Notifications, Plugins, Members, Profile + token, System: a flat 200 sub-nav, then the page title and one-line description in a centred 800 column |
| `#/signin` | O1 | owner token |
| `#/welcome` | O2–O5 | first provider key, first project, first message, notifications |

Layout (v4 shell, render 12.1): the sidebar (240, on bg) holds the app mark, search (⌘K) and collapse (⌘B), the nav rows New thread, Schedules, Extensions and Settings, a Projects section with each project's state glyph and +, the current project's Threads (all statuses, newest first, with a filter toggle), and the owner menu (Settings; Theme: Dark, Light, Rose). The centre and the pane are panels inset 8 from the window with radius 12 and an 8 gutter; the pane is 432 and docked from 1280. Below 1280 the pane overlays the centre from the right; below 1024 the sidebar is a drawer opened from the menu button in the tab bar, closed by the scrim, its × or any navigation. Expand widens the pane over the centre. The chat column never exceeds 720. There is no rail and no bottom tab bar.

## Identity

The app mark is the Ingle avatar from the brand handoff. `components/ui/brand-mark.tsx` paints `public/brand/ingle-mark-20.svg` as a CSS mask over `currentColor`, so it takes the surrounding ink and follows `data-theme` (dark, light, rose) without per-theme files. It sits alone at 20px in the sidebar header and beside the word Ingle in the onboarding and sign-in top bar. `index.html` links `favicon.ico`, `favicon.svg` (which follows `prefers-color-scheme`, since a tab icon cannot read `data-theme`) and `apple-touch-icon.png`. There is no web manifest, so the 192 and 512 icons are not shipped.

Status is the Signal (see Status palette). `components/ui/signal.tsx` draws it wherever a thread, a project, a report, a schedule or a job shows state, with the state's word as its accessible name.

A project's mark is one of the 24 glyphs from `I3`, in `lib/project-glyphs.ts`. It is chosen from the project's own words, first match wins, and by slug when nothing matches. Picking or shuffling the glyph from New project would need a stored field on the project, which the schema does not have, so the mark stays derived. `components/chat/project-glyph.tsx` draws it on a 24-unit grid with a 1.5 stroke and at most one solid part. The glyph itself never changes, and the tile carries no status: the project's state is a Signal at the end of its sidebar row (fTz I3's corner square is dropped, per the v5 inventory).

Empty states use the pictograms from `I4`, in `components/ui/pictogram.tsx`, at 88px. A 64 grid, a 1.5px stroke that stays 1.5px at any size, one orange detail, and one small loop per drawing. They never sit inside a control.

Indicators follow v5 page 16 and live in `components/ui/`:

- `loaders.tsx`: `Spinner`, the arc (a faint ring and a quarter arc, one turn every .8s, 12/14/16/20/32, in the current colour, never the accent), which replaces a button's leading icon while it is busy. `BootLoader`, the construction trace (a pen draws a square, a circle and a triangle over dashed guides, 9s linear with a 1.8s hold), shown by `app.tsx` while the stored token is checked and faded in only after 400ms, so a fast boot never shows it. `Thinking`, three breathing dots before the first token; streaming and tool-running text uses `.im-shimmer`. Page 16.2's progress bar and context ring have no surface outside the composer yet, so none is built here.
- `skeleton.tsx`: `Loading` swaps a skeleton for its content, which fades in with `.im-content`. For a resource it is driven by `firstLoad()` in `lib/loading.ts`, which is true only while the first value is pending, so a refetch after a mutation keeps the stale rows on screen instead of flashing the skeleton; the skeleton itself fades in after `--skeleton-delay` (150ms) and pulses on `--loop-skeleton`. `ThreadSkeleton` stands in for a transcript, `RowSkeleton` for 46px two-line rows, `PaneSkeleton` for a right-pane section (28px header and rows), and `Bar` for anything else.
- `morph-icon.tsx`: `MorphIcon` morphs a control's icon when it changes meaning, in 200ms out-quint: copy→check (the check draws), chevron down→up, plus→×, eye→eye slashed (the slash draws) and pause→play. It plays once, at the change, and swaps with no motion under reduced motion.

## Motion

Motion is the handoff file `web/src/styles/ingle-motion.css` (design system §0.8, canvas page 17), vendored verbatim and imported after `tokens.css`; it owns the motion tokens (`--ease-*`, `--dur-*`, `--loop-*`, the scales) and the `.im-*` and `.sig` primitives. Other lanes build on its class names, so the path stays. Ark overlays animate with keyframes on `data-state` because Ark's presence waits for `animationend`; app-driven UI uses transitions and `@starting-style` so it can be interrupted.

`web/src/styles/motion.css` holds only what the file leaves to the app: Tailwind's `hover` variant gated to `(hover: hover) and (pointer: fine)`, the combined transition for an element that is both `.im-press` and `.im-hover` (each sets `transition` on its own), the left-edge variant of `.im-sheet` (`data-side="left"`) for the sidebar drawer, the pane tab pill (`.im-pill`, translate and width over `--dur-flip` in-out), and the composer's `menu-in` and `shake` on the file's keyframes. Each has the same reduce rule both ways the file has them.

`web/src/lib/motion.ts` sets `:root[data-visibility]` from `visibilitychange`, so loops pause in a hidden tab, and tracks whether the last input was a key. A keyboard-started action takes no time: components that render the moving element put `data-instant` on it at that moment (pane view, pane pill, overview sections), a MutationObserver puts it on any `.im-*` overlay that mounts or changes `data-state` after a keypress (menus, popovers, dialogs, sheets), and `createPresence` unmounts at once. `stagger()` adds `.im-stagger` and each row's `--i` on a list's first load only. Nothing sets `:root[data-motion="reduce"]` yet because Appearance has no such setting; the file and the glue already honour it.

| Surface | Primitive | Where |
| --- | --- | --- |
| Icon buttons | `.im-press .im-hover` | `shell/menu.ts` `ICON_BUTTON` |
| Rows and tabs | `.im-hover` | sidebar rows, pane rows, inactive conversation and pane tabs |
| Menus and popovers (Ark) | `.im-pop` | `MENU_CONTENT` |
| Dialogs | `.im-dialog` + sibling `.im-scrim`, `data-state` from `createPresence` | `ui/dialog.tsx`, add-from-URL, new schedule |
| Right sheet | `.im-sheet` + `.im-scrim` | install review, undocked project pane |
| Sidebar drawer | `.im-sheet[data-side="left"]` + `.im-scrim` | `shell/shell.tsx` |
| Pane view swap | `.im-pane` | `pane/pane.tsx` |
| Pane tab pill | `.im-pill` | `pane/pane.tsx` |
| Conversation tabs | `.im-tab .im-lift .im-flip`: open scales in, close fades then neighbours slide (FLIP on `translate`), drag lifts with `data-dragging` and `--drag-x` | `shell/conversation-tabs.tsx` |
| Overview sections | `.im-grow` + `.im-chevron` | `pane/overview.tsx` |
| First-load lists | `.im-stagger` via `stagger()` | sidebar projects and threads, overview sections, thread fan-out |
| Report card | `.im-event` | `chat/cards.tsx` |
| Signal | `.sig` with `data-state` and `data-size`; state changes crossfade dot by dot | `ui/signal.tsx` |
| Spinner, boot trace, morphing icons | `.im-spinner`, `.im-boot`, `.im-morph` from `indicators.css`, on the file's tokens, still under reduced motion and paused in a hidden tab | `ui/loaders.tsx`, `ui/morph-icon.tsx` |
| Thinking | `.im-dots` | `ui/loaders.tsx` |
| Skeletons | `.im-skeleton` fading in after `--skeleton-delay`; content enters with `.im-content` | `ui/skeleton.tsx` |
| Working text, streaming caret | `.im-shimmer`, `.im-caret` | transcript, cards, pane rows |
| Switches | `.im-switch` with an `<i>` knob | extensions `Toggle`, onboarding notifications |
| Onboarding and sign-in pages | `.im-content` | onboarding steps, sign-in |

No toasts exist yet, so `.im-toast` has no consumer. The composer lane owns the Send/Stop morph, upload progress, the context ring and attachment chips.

## Decisions taken from the review frame's open questions

1. **Owner token is the only sign-in.** The backend authenticates one owner; members would need their own auth, which does not exist.
2. **Jobs live in the workspace panel**, not per project.
3. **Auto-update defaults to patch only**; anything that adds a row or a permission always asks.
4. **The monthly cap pauses threads and asks**, rather than failing them.
5. **The community index is off by default** and labelled Unverified.
6. **There is no landing page.** The client is the signed-in app only.
7. **Tablet is a responsive layout**, not a separate frame set.
