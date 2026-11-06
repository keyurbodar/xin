# Plugins (everything is a row)

Xin's plugin layer is dsh's Cordis stack. Every part of Home is a loader row, kernel services included (`db`, `pi`, `ops`, `http`, `wire`, `clock`, `secrets`, `plugins`, `system`), and so is every feature (`models`, `files`, `intake`, ...) and every package under `plugins/*`. The rows come from the bundles in `xin.profile.json`, then that file's patch, then the owner patch stored in `kv` `plugins.patch`. Changes apply live. New code needs a rebuild and deploy.

## Sub-features

- Ops: `plugin.list`, `plugin.catalog`, `plugin.tree`, `plugin.enable`, `plugin.configure`, `plugin.insert`, `plugin.remove`, `plugin.reset`, `plugin.secret.set`.
- Row states: `active`, `pending` (a service it injects is missing), `disabled`, `failed` (with the error), `missing` (no code in this build). A failed start returns `application: "failed"` with the row and leaves the other rows running.
- Required rows (the kernel) cannot be disabled. A failed required row makes `/v1/cmd` answer 503 `boot_failed`.
- `system.version`, `system.restart {hard?}`, `system.update` through the `deployer` seam (default row `deploy-hook`, which needs its `url` secret).
- Agent tool `plugin_manager`: reads always work. `enable` and `configure` work only with `plugins` config `allowAgent: true`.
- CLI (build time): `bun scripts/xin.ts plugin list | generate | add <spec> [--enable] | remove | enable | disable`.
- Example package: `plugins/time` (`current_time` tool, `timezone` config).

## How to get to it (user POV)

A Plugins page lists every row with its state and layer. It toggles rows, edits config from the schema in `plugin.catalog`, and offers Restart and Update buttons.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call GET /v1/status                                                                    # build, bundles, degraded, row states
$S call POST /v1/cmd '{"id":"c","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Asia/Kolkata"}}}'   # applied, layer owner
$S call POST /v1/cmd '{"id":"b","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Mars/Olympus"}}}'   # application failed, row error
$S call POST /v1/cmd '{"id":"r","op":"plugin.reset","args":{"id":"time"}}'                # back to layer bundle
$S call POST /v1/cmd '{"id":"d","op":"plugin.enable","args":{"id":"push","enabled":false}}'
$S call POST /v1/cmd '{"id":"q","op":"plugin.enable","args":{"id":"pi","enabled":false}}'  # bad_args: required
$S call POST /v1/cmd '{"id":"x","op":"system.restart","args":{}}'                         # soft restart; push stays disabled
$S call POST /v1/cmd '{"id":"u","op":"system.update","args":{}}'                          # failed until the deploy-hook url secret is set
```

Proof: the end states above. Evidence from the last wrangler dev drive: `.verify/evidence/P1-plugins.txt`.

## Gotchas

- Rows start by readiness, not list order. Two rows that define the same op name race, and whichever mounts second fails. Give each op one owner.
- Cordis already uses `ctx.runtime`, so the host facts service is `ctx.host`. Services are reached through proxies, so they cannot use `#private` fields.
- `system.restart {hard:true}` aborts the object. The next request reopens it, so expect one failed request.
