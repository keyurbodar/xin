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
| primitives | Kobalte only if a surface needs real focus management | dialogs, the command palette and menus |

## Data

The client talks to the Worker over the same contract the agent uses.

- **Commands** go to `POST /v1/cmd` as `{ id, op, args }`; every mutation in the UI is one op.
- **Streams** come from `GET /v1/socket` with subprotocol `xin, bearer.<token>`: `{t:"sub", stream:"home"}` for the workspace projection and `{t:"sub", stream:"conv:<id>"}` for a conversation. A subscription answers one `{t:"snap"}` and then `{t:"ev"}` deltas, applied with chord's own `applyImmutable`.
- **One entry renders once.** `components/chat/entries.tsx` maps a transcript's entries to items and renders them; the project chat and a thread's body both call it, so a new entry kind reaches both.
- **A send is keyed once per draft.** The composer mints one command id and `clientTs` per draft text and reuses them on retry, so a lost ack cannot add a second message: the host dedupes on the command id.
- **Auth** is the owner token, kept in `localStorage`, checked with `GET /v1/status`. Same-origin in production; Vite proxies `/v1` and `/health` to `wrangler dev` in development.

Deviations from the backend spec that the UI needs are logged in `docs/log/decisions.tsv` as they land.

## Ops the client adds

The client needed three reads the agent never asked for. Each is owner-only, reads state that already exists, and adds no storage.

| Op | Args | Result |
| --- | --- | --- |
| `request.list` | `{ limit?, projectId? }` | pending questions across live projects, or one project's: `{ requests: [{ id, conversationId, projectId, projectName, threadTitle?, question, options?, askedAt }] }`. Reads run in parallel and never read a coordinator, which cannot hold an open request |
| `usage.summary` | `{}` | pi's usage ledger, summed: `{ spend, tokens, byModel[], byTool[] }` |
| `job.list` | `{ limit? }` | background jobs the jobs plugin holds: `{ jobs: [{ id, tool, title, parentId, startedAt, deadlineAt, detached, state: running\|completed\|failed, result? }] }` |
| `history.page` | `{ conversationId, before?, limit? }` | older entries than the socket snapshot: `{ entries, nextBefore? }`. `before` is inclusive, the same value the view reports as its first missing entry, so the first page starts at the snapshot's own boundary; `nextBefore` is the oldest returned id minus one |

`usage.summary` reads the lifetime ledger; the ledger carries no day bucket, so the Home cell is labelled "Spend", not "Spend today".

## Screens

| Route | Frame | What it is |
| --- | --- | --- |
| `#/` | D3 | Home: greeting, the four counts, Needs You, the project grid |
| `#/p/:slug` | D1, D2, D5, D6 | project chat: transcript, composer, right panel (Threads, Files, Memory, Schedules, Jobs) |
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
