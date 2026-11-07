# web · the Xin client

The first-party client for a Xin home: a SolidJS app that talks to the Worker's command API and socket. It is a separate package so the Worker gate never compiles it.

## Run

The Worker has to be up first, because the client proxies `/v1` and `/health` to it.

```bash
# from the repo root
.claude/skills/verify-xin/xin.sh launch          # wrangler dev on http://127.0.0.1:8799

# from web/
bun run dev                                      # vite on http://localhost:5174
```

The token is the `OWNER_TOKEN` your deployment was started with. The verify skill's throwaway instance uses `verify-owner-token`. It is kept in `localStorage`; signing out is clearing it.

Point at a different Worker with `XIN_DEV_URL=http://127.0.0.1:8800 bun run dev`.

## Check

```bash
bun run typecheck     # tsgo, strict, exactOptionalPropertyTypes
bun run build         # vite production build
```

These are the client's gate; they never go through `scripts/gate.ts`.

## Shape

| Path | What lives there |
| --- | --- |
| `src/main.tsx`, `src/app.tsx` | mount, the token gate, and which surface the route renders |
| `src/lib/` | hash router, command client and socket streams, formatting, status words |
| `src/state/` | one store per stream or read op; screens never call `cmd` directly for data they share |
| `src/components/ui/` | the primitives: D Grid status glyphs, icons, skullet skeletons, torph counters |
| `src/components/shell/` | sidebar, top bar, command palette, tab bar, connection banner, bottom sheet |
| `src/components/<feature>/` | feature pieces; a screen composes them |
| `src/screens/` | one file per route |
| `src/styles/` | the token block, base layer, utilities and status keyframes |

Rules the code follows are in `docs/plan/architecture/14-client.md`; the visual source is the Doop canvas `fTzMMHDuiN`. Orange means "needs you" or a primary action, blue means working, and nothing else uses those two colours.
