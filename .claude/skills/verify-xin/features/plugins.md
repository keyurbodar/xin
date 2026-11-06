# Plugin host

Features ship as bundled plugins (`src/plugins/bundled.ts`). The host reconciles them when the object opens, in `requires`/`provides` order. Each plugin ends `active`, `failed`, `blocked` (missing requirement) or `disabled` (`plugins.enabled = 0`), and one failure never stops the others.

## Sub-features

- Plugin states: in the `plugins` table and the `home` snapshot.
- Ops and pi extensions: contributed by active plugins only. A duplicate op name fails the later plugin.
- `host.fetch`: limited to `permissions.net` (`*`, exact host, `*.domain`).

## How to get to it (user POV)

The home view lists each plugin's state.

## Driving it with xin.sh

```bash
.claude/skills/verify-xin/xin.sh ws '{"t":"sub","stream":"home"}'      # value.plugins lists every bundled plugin's state
```

Ordering, isolation and net limits are proven in `src/plugins/host.test.ts`, and active/failed/blocked inside a real object in `src/wire.test.ts`.

## Gotchas

- Until M2 bundles the first core plugin, `plugins` under `wrangler dev` is `{}`.

Evidence from the last wrangler dev drive: `.verify/evidence/M2-M8skills.txt`.
