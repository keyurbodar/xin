# Plugins (everything is a row)

Xin's plugin layer is dsh's Cordis stack. Every part of Home is a loader row, kernel services included (`db`, `pi`, `ops`, `http`, `wire`, `clock`, `secrets`, `plugins`, `packages`, `system`), and so is every feature (`models`, `files`, `intake`, ...) and every package under `plugins/*`. The rows come from the bundles in `xin.profile.json`, then that file's patch, then the owner patch stored in `kv` `plugins.patch`. Changes apply live. New code needs a rebuild and deploy.

## Sub-features

- Ops: `plugin.list`, `plugin.catalog`, `plugin.tree`, `plugin.enable`, `plugin.configure`, `plugin.insert`, `plugin.remove`, `plugin.reset`, `plugin.secret.set`.
- Install from the client (P5): `plugin.install {spec}`, `plugin.uninstall {package}`, `plugin.packages {}` record a pending list in kv `plugins.packages`; `system.update` sends it to the deployer; `GET /v1/build/packages` serves it to a pipeline; a new build clears what it now contains. Specs are parsed: registry names and ranges, `@scope/x@~1`, `github:o/r#ref` and git URLs are accepted; `file:`, `link:`, `npm:`, tarballs and shell characters are `bad_args`. Uninstalling an in-repo package is `bad_args` (disable its bundle). Pending entries survive restarts on the same build and settle on a new one. The owning kernel row is `packages`. Nothing installs until a build and deploy (`docs/deploy/install-pipeline.md`).
- Presets (P5): the `presets` row's config holds named tool-row allowlists (`full`: all, `minimal`: tool-memory and tool-skills) and a `default`. `preset.list {}` and `preset.assign {projectId, preset}`; the project's coordinator and threads are offered only that preset's tool rows. Assignments survive restart.
- Events (P5): `intake/batch` rewrites or drops a claimed batch; `thread/settled` fires once a thread's terminal status is committed.
- Row states: `active`, `pending` (a service it injects is missing), `disabled`, `failed` (with the error), `missing` (no code in this build). A failed start returns `application: "failed"` with the row and leaves the other rows running.
- Required rows (the kernel) cannot be disabled. A failed required row makes `/v1/cmd` answer 503 `boot_failed`.
- `system.version`, `system.restart {hard?}`, `system.update` through the `deployer` seam (default row `deploy-hook`, which needs its `url` secret).
- Agent tool `plugin_manager`: reads always work. `enable` and `configure` work only with `tool-plugins` config `allowAgent: true`. Disabling the `tool-plugins` row hides the tool and keeps the `plugin.*` ops.
- CLI (build time): `bun scripts/xin.ts plugin list | generate | add <spec> [--enable] | remove | enable | disable`.
- Example package: `plugins/time` (`current_time` tool, `timezone` config). It declares `multiple: true`, so `plugin.insert` can add more rows; each extra row installs its own extension named after the row and a tool `current_time_<row>`. Inserting a second row of any other plugin is `bad_args`.
- Tool rows: each feature package ships `tool-<name>` next to its service row (`tool-files`, `tool-models`, `tool-memory`, `tool-questions`, `tool-skills`, `tool-schedules`, `tool-orchestrator`, `tool-mcp`, kernel `tool-plugins`). Disabling one hides those tools; the service row stays `active`.

## How to get to it (user POV)

A Plugins page lists every row with its state and layer. It toggles rows, edits config from the schema in `plugin.catalog`, and offers Restart and Update buttons.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call GET /v1/status                                                                    # build, bundles, degraded, row states
$S call POST /v1/cmd '{"id":"c","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Asia/Kolkata"}}}'   # applied, layer owner
$S call POST /v1/cmd '{"id":"b","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Mars/Olympus"}}}'   # application failed, row error
$S call POST /v1/cmd '{"id":"r","op":"plugin.reset","args":{"id":"time"}}'                # back to layer bundle
$S call POST /v1/cmd '{"id":"i","op":"plugin.insert","args":{"id":"time-tokyo","plugin":"time","config":{"timezone":"Asia/Tokyo"}}}'  # applied, layer owner
$S call POST /v1/cmd '{"id":"j","op":"plugin.insert","args":{"id":"files2","plugin":"files","config":{}}}'  # bad_args: single instance
$S call POST /v1/cmd '{"id":"d","op":"plugin.enable","args":{"id":"push","enabled":false}}'
$S call POST /v1/cmd '{"id":"t","op":"plugin.enable","args":{"id":"tool-memory","enabled":false}}'  # tool row disabled, memory stays active
$S call POST /v1/cmd '{"id":"t2","op":"plugin.enable","args":{"id":"tool-mcp","enabled":false}}'  # tool_search and server tools hidden; mcp stays active and mcp.list answers
$S call POST /v1/cmd '{"id":"q","op":"plugin.enable","args":{"id":"pi","enabled":false}}'  # bad_args: required
$S call POST /v1/cmd '{"id":"x","op":"system.restart","args":{}}'                         # soft restart; push stays disabled
$S call POST /v1/cmd '{"id":"u","op":"system.update","args":{}}'                          # failed until the deploy-hook url secret is set
$S call POST /v1/cmd '{"id":"m","op":"plugin.remove","args":{"id":"time-tokyo"}}'         # owner row gone
$S call POST /v1/cmd '{"id":"k1","op":"plugin.install","args":{"spec":"xin-plugin-weather@1.2.0"}}'   # pending add (twice is still one)
$S call POST /v1/cmd '{"id":"k2","op":"plugin.install","args":{"spec":"evil; rm -rf /"}}'           # bad_args
$S call GET /v1/build/packages                                                              # {"add":[...],"remove":[...]}, 401 without the token
$S call POST /v1/cmd '{"id":"pr","op":"project.create","args":{"slug":"trip","name":"Trip"}}'
$S call POST /v1/cmd '{"id":"pa","op":"preset.assign","args":{"projectId":"prj_pr","preset":"minimal"}}'
$S call POST /v1/cmd '{"id":"pl","op":"preset.list","args":{}}'                             # prj_pr on minimal, also after system.restart
```

Proof: the end states above. Evidence from the last wrangler dev drive: `.verify/evidence/P5-plugins.txt` (earlier: `P4-plugins.txt`, `P1-plugins.txt`).

## Gotchas

- Rows start by readiness, not list order. Two rows that define the same op name race, and whichever mounts second fails. Give each op one owner.
- Cordis already uses `ctx.runtime`, so the host facts service is `ctx.host`. Services are reached through proxies, so they cannot use `#private` fields.
- `system.restart {hard:true}` aborts the object. The next request reopens it, so expect one failed request.
