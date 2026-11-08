# Plugins (everything is a row)

Xin's plugin layer is dsh's Cordis stack. Every part of Home is a loader row, kernel services included (`db`, `pi`, `ops`, `http`, `wire`, `clock`, `secrets`, `plugins`, `packages`, `system`), and so is every feature (`models`, `files`, `intake`, ...) and every package under `plugins/*`. The rows come from the bundles in `xin.profile.json`, then the installed runtime bundles, then that file's patch, then the owner patch stored in `kv` `plugins.patch`. Changes apply live. New code needs a rebuild and deploy.

## Sub-features

- Ops: `plugin.list`, `plugin.catalog`, `plugin.tree`, `plugin.enable`, `plugin.configure`, and the kernel credential op `secret.set {ref, value}` (an empty value deletes).
- Rows are added by a bundle, never by an op: `bundle.put` installs a local bundle (`docs/plan/architecture/12-market.md`). The owner patch records only what the owner changed (enable, config), computed as the minimal departure from the lower layers; writing a row's inherited config back drops the override.
- `plugin.tree` reports `layers` as `{ [rowId]: { addedBy, patchedBy } }`: each row's `addedBy` layer (`bundle`, `runtime`, `profile`, `owner`) and the layers that patched it (dsh `--dump-config`).
- Install from the client (P5): `plugin.install {spec}`, `plugin.uninstall {package}`, `plugin.packages {}` record a pending list in kv `plugins.packages`; `system.update` sends it to the deployer; `GET /v1/build/packages` serves it to a pipeline; a new build clears what it now contains. Specs are parsed: registry names and ranges, `@scope/x@~1`, `github:o/r#ref` and git URLs are accepted; `file:`, `link:`, `npm:`, tarballs and shell characters are `bad_args`. Uninstalling an in-repo package is `bad_args` (disable its bundle). Pending entries survive restarts on the same build and settle on a new one. The owning kernel row is `packages`. Nothing installs until a build and deploy (`docs/deploy/install-pipeline.md`).
- Presets (P5/P9): the `presets` row's config names the `default`; each `preset` row carries `{ id, name?, description?, order?, tools }`, where `tools` is `"all"` or an allowlist of `tool-*` extension names. A conversation records its preset when it is created; `preset.list {}` reports the presets, the default and each conversation's recorded preset, and `preset.select {conversation, preset}` changes it only while the conversation has no turns.
- Events (P5): `intake/batch` rewrites or drops a claimed batch; `thread/settled` fires once a thread's terminal status is committed.
- Row states: `active`, `pending` (a service it injects is missing), `disabled`, `failed` (with the error), `missing` (no code in this build). A failed start returns `application: "failed"` with the row and leaves the other rows running.
- Required rows (the kernel) cannot be disabled. A failed required row makes `/v1/cmd` answer 503 `boot_failed`.
- `system.version`, `system.restart {hard?}`, `system.update` through the `deployer` seam (default row `deploy-hook`, which needs its `url` secret).
- Agent tool `plugin_manager` (`tool-plugins`): the row is disabled by default. When enabled, the agent can `list`, `catalog`, `tree`, `enable {id, enabled}` and `configure {id, config}`; approval of those mutations follows the P10 `tools/pre-execute` gate.
- CLI (build time): `bun scripts/xin.ts plugin list | generate | add <spec> [--enable] | remove | enable | disable`.
- Example package: `plugins/time` (`timezone` and `refreshIntervalMs` config, dsh `context/time-context`). It offers no tool: it installs extension `clock-<row>`, which appends a user-role reading starting `Time sampled while preparing turn ` to each model request when due. A bundle can add a second `time` row with its own zone, which installs its own `clock-<row>` extension. A second row of a plugin that registers a fixed extension name fails to start and reports `failed`, as a duplicate does in dsh.
- Tool rows: each feature package ships `tool-<name>` next to its service row (`tool-files`, `tool-models`, `tool-memory`, `tool-questions`, `tool-skills`, `tool-schedules`, `tool-orchestrator`, `tool-mcp`, kernel `tool-plugins`). Disabling one hides those tools; the service row stays `active`.

## How to get to it (user POV)

A Plugins page lists every row with its state and layer. It toggles rows, edits config from the schema in `plugin.catalog`, and offers Restart and Update buttons.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call GET /v1/status                                                                    # build, bundles, degraded, row states
$S call POST /v1/cmd '{"id":"c","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Asia/Kolkata"}}}'   # applied, layer owner
$S call POST /v1/cmd '{"id":"b","op":"plugin.configure","args":{"id":"time","config":{"timezone":"Mars/Olympus"}}}'   # application failed, row error
$S call POST /v1/cmd '{"id":"r","op":"plugin.configure","args":{"id":"time","config":{"timezone":"UTC"}}}'            # inherited value written back: owner patch drops the override
$S call POST /v1/cmd '{"id":"i","op":"bundle.put","args":{"package":"xin-plugin-extra-time","rows":[{"id":"time-tokyo","plugin":"time","config":{"timezone":"Asia/Tokyo"}}]}}'  # applied; second row of a plugin
$S call POST /v1/cmd '{"id":"j","op":"bundle.put","args":{"package":"xin-plugin-bad","rows":[{"id":"pi2","plugin":"pi"}]}}'  # bad_args: required plugin
$S call POST /v1/cmd '{"id":"d","op":"plugin.enable","args":{"id":"push","enabled":false}}'
$S call POST /v1/cmd '{"id":"t","op":"plugin.enable","args":{"id":"tool-memory","enabled":false}}'  # tool row disabled, memory stays active
$S call POST /v1/cmd '{"id":"t2","op":"plugin.enable","args":{"id":"tool-mcp","enabled":false}}'  # tool_search and server tools hidden; mcp stays active and mcp.list answers
$S call POST /v1/cmd '{"id":"tp","op":"plugin.enable","args":{"id":"tool-plugins","enabled":true}}'  # the agent's plugin_manager tool appears
$S call POST /v1/cmd '{"id":"q","op":"plugin.enable","args":{"id":"pi","enabled":false}}'  # bad_args: required
$S call POST /v1/cmd '{"id":"x","op":"system.restart","args":{}}'                         # soft restart; push stays disabled
$S call POST /v1/cmd '{"id":"u","op":"system.update","args":{}}'                          # failed until the deploy-hook url secret is set
$S call POST /v1/cmd '{"id":"k1","op":"plugin.install","args":{"spec":"xin-plugin-weather@1.2.0"}}'   # pending add (twice is still one)
$S call POST /v1/cmd '{"id":"k2","op":"plugin.install","args":{"spec":"evil; rm -rf /"}}'           # bad_args
$S call GET /v1/build/packages                                                              # {"add":[...],"remove":[...]}, 401 without the token
$S call POST /v1/cmd '{"id":"pl","op":"preset.list","args":{}}'                              # presets, default and per-conversation selections
$S call POST /v1/cmd '{"id":"ps","op":"preset.select","args":{"conversation":"con_x","preset":"minimal"}}'  # bad_args once the conversation has turns
$S call POST /v1/cmd '{"id":"sec","op":"secret.set","args":{"ref":"DEPLOY_URL","value":"https://example.test/hook"}}'
```

Proof: the end states above. Evidence from the last wrangler dev drive: `.verify/evidence/P5-plugins.txt` (earlier: `P4-plugins.txt`, `P1-plugins.txt`).

## Gotchas

- Rows start by readiness, not list order. Two rows that define the same op name race, and whichever mounts second fails. Give each op one owner.
- Cordis already uses `ctx.runtime`, so the host facts service is `ctx.host`. Services are reached through proxies, so they cannot use `#private` fields.
- `system.restart {hard:true}` aborts the object. The next request reopens it, so expect one failed request.
