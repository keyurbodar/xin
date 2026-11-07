# 15 · Plugins: everything is a plugin

This section decides that Xin's plugin layer is the one deepseek-harness (dsh) uses: Cordis contexts, services, typed events and reversible effects, composed from a tree of loader rows. There is no privileged core. The kernel services, pi-durable itself and every feature are rows that a patch can configure, disable or replace.

Read with: [01 Host](./01-host.md) for the alarm loop the `clock` service owns, [03 Commands and wire](./03-commands-and-wire.md) for the `ops` and `wire` services, [05 Models](./05-models.md) for the `models` seam.

## Stack

| Package | Version | Role |
| --- | --- | --- |
| `@deepseek-ai/cordis` | 4.1.0 | Context, Service, plugin registry, fibers, events, effects |
| `@deepseek-ai/cordis-plugin-loader` | 1.1.0 | the entry tree: rows, groups, isolates, update, disable |
| `@deepseek-ai/schemastery` | 3.19.0 | plugin `Config` schemas, serialisable for settings forms |

The loader runs in workerd unchanged. It needs one build define, `import.meta.url = "file:///bundle/index.js"`, because it calls `createRequire(import.meta.url)` when constructed. `XinLoader` sets `internal = undefined`, and every row's `name` is a `cordis:<catalog name>` builtin. Nothing is imported at run time. pi-schema stays the schema for tool parameters, op args and wire frames. schemastery is only for plugin config.

## Model

```mermaid
flowchart TB
  DO["Home DO constructor<br/>blockConcurrencyWhile"] --> ROOT["root Context<br/>host facts: state, env"]
  ROOT --> L["XinLoader<br/>builtins = CATALOG"]
  L --> ROWS["composed rows<br/>bundles, profile patch, owner patch"]
  ROWS --> K["kernel rows<br/>db, pi, ops, http, wire, clock, secrets, plugins, packages, system"]
  ROWS --> F["feature rows<br/>models, files, intake, memory, push, skills, mcp,<br/>workspace, schedules, orchestrator, jobs, questions, watchdog, failures"]
  K -->|"pi row init"| OPEN["Harness.open<br/>provides ctx.harness"]
  OPEN --> F
  L -->|"loader.await()"| RES["harness.resume()"]
```

- **A plugin is a Cordis plugin.** It is a module with `name`, `inject`, `Config` and `apply(ctx, config)`, or a `Service` subclass. It needs only the services named in `inject`, never a concrete module.
- **Every registration is an effect.** Extensions, tools, ops, routes, timers, home snapshot parts and listeners return a disposer. Disposing or reconfiguring a plugin unwinds exactly what it added.
- **Boot order comes from `inject`.** It does not come from list order. A row stays pending until its services exist, and it unloads when one goes away.
- **The `pi` row owns the Harness.** Its init opens the Harness, provides `harness`, and closes it on dispose. Rows that need the Harness name `harness` in `inject`, so they start after it and restart with it. Scheduling stays off until `Home` calls `harness.resume()` after `loader.await()`, so a resumed task finds its definition installed. A row's startup work runs in its own `apply`. A failure fails only that row, and the row's disposers (commit observers included) run when it is disabled.

## Kernel services (seams)

Each service is a row in `xin-base`. A different row can provide the same key in its place.

| Key | Row | Surface |
| --- | --- | --- |
| `host` | root facts, not a row | `state: DurableObjectState`, `env: Env`, `abort(reason)` |
| `db` | `db` | `SqliteDatabase` plus `applySqliteMigrations(owner, steps)`. Host steps stay in the append-only `HOST_MIGRATIONS`, and a plugin's own tables use its own migration list, tracked in the table `migrations_<owner>` |
| `pi` | `pi` | `registry`, `install(extension)` (effect), `models(fn)` and `env(fn)` providers (effects), `open()` |
| `harness` | `pi` (provided by its init) | the pi-durable `Harness`, closed when the `pi` row unloads |
| `ops` | `ops` | `define(op)` (effect), `run(command, actor)`, `list()`. Receipts as in §3 |
| `http` | `http` | `route("GET /path" or "GET /prefix*", handler)` (effect), `handle(request)` |
| `wire` | `wire` | sockets, `home(part, fn)` (effect), `publishHome()` |
| `clock` | `clock` | `timer({ due, fire })` (effect), `arm(wake)`, `fire(now)`. It owns the single DO alarm (§1) |
| `secrets` | `secrets` | named credentials, as dsh `credentials`: `get(ref)` and `set(ref, value)` over values sealed with `KEK`, one namespace for the Home. Config strings that accept credentials resolve `${credential:REF}` with `expandCredentials(text, secrets)` from `src/credentials.ts`. `values()` is kernel-only and feeds the redaction hook. Defines the owner op `secret.set { ref, value }` (empty `value` deletes) |
| `plugins` | `plugins` | the plugin manager below |
| `packages` | `packages` | the build's `installed` packages, the parsed `pending` list, `plugin.install` and `plugin.uninstall`, `GET /v1/build/packages`, and the boot reconcile |
| `system` | `system` | version, restart, update. Deploys go through the `deployer` seam |

Feature services follow the same pattern (`models`, `files`, `memory`, `push`, `skills`, `mcp`, `workspace`, `threads`, `jobs`, `questions`). A feature that other features call provides a key. A feature that only adds tools, ops or timers provides none.

**Service rows and tool rows.** A feature package splits what it serves from what the model sees.

- The service row (`<name>`) owns state, ops, routes, timers and the home part, and provides `ctx.<key>` (`files`, `models`, `threads`, `jobs`, `intake`, `memory`, `questions`, `skills`, `schedules`, `mcp`, `watchdog`, `push`, `workspace`). Its `apply` calls `ctx.provide("<key>", value)`.
- The tool row (`tool-<name>`) is a plain plugin with `inject: ["pi", "<key>"]` that installs one extension, named `tool-<name>`, holding the model-facing tools (and their prompt sections). Disabling it removes those tools and leaves the service running.
- Both rows are declared in the package's `xin.plugins` and listed in its `xin.bundle`.
- Each service's interface lives in `src/contracts/<key>.ts`, which augments Cordis `Context` with `<key>: <Interface>`. That folder holds only types, doc definitions, schemas and pure helpers. A plugin may import `src/contracts/*`, `src/kernel/index.ts` and shared libs in `src/`, never another plugin's files. Calls into another feature go through `inject` (required) or `ctx.get(key)` (optional). A row module lists every service it reads in `inject` and reads it as `ctx.<key>` only inside that file; helper files take narrow ports as parameters (intake reads the optional `push` with `ctx.get("push")` at call time). `bun scripts/boundaries.ts` checks both rules. Each plugin reads and writes only its own SQL tables; `src/kernel/dbtables.ts` maps every table to its owning plugin or `kernel`, and `bun scripts/boundaries.ts`, run by `lint`, fails on any import from one plugin (or test plugin) into another, and on any SQL that names another feature's table. The kernel's `kv`, `receipts`, `plugins` and migration tables are shared infrastructure.

| Key | Provider row | Called by |
| --- | --- | --- |
| `intake` | `intake` | jobs, watchdog, orchestrator, questions, schedules, failures |
| `push` | `push` | intake (optional) |
| `jobs` | `jobs` | mcp, watchdog, orchestrator |
| `watchdog` | `watchdog` | orchestrator, questions |
| `models` | `models` | orchestrator, memory, tool-models |
| `threads` | `orchestrator` | questions, tool-orchestrator |
| `files` | `files` (or any row, e.g. the test `fake-files`) | tool-files |

 `ctx.pi.install(defineExtension({ ... }))` accepts any pi extension: tools, `wrapTool`, hooks, prompt sections, tasks, docs. It installs it in the live registry and calls `registry.uninstall` on dispose. pi treats a reinstall under the same name as a hot replace, so a reconfigured plugin swaps its extension in place.

## Events

Events are declared on Cordis `Events` with an `@mode` tag. The dispatch mode is part of the contract.

| Event | Mode | Use |
| --- | --- | --- |
| `ops/before(call, next)` | waterfall | policy over every op: deny, rewrite args, or observe. `call = { command, actor }` returns an `Outcome` |
| `intake/batch(batch, next)` | waterfall | rewrite a claimed batch before dispatch. `batch = { batchId, target, rows }`; a listener edits `rows` or a row's `text` in place, then calls `next()` (Cordis passes no value through `next`). Returning `{ kind: "dropped", reason }` without `next()` marks the batch done unsent. `next()` stores the rewritten rows (and a completed marker in DO kv `intake.dispatched.<batchId>`) before submitting, so a crash replay resubmits the stored rows without running the event again. Listeners run at the first fire after every row mounts; one that throws or rejects is logged and skipped, and the batch dispatches as given |
| `thread/settled(event)` | emit | a thread reached a terminal status. `event = { threadId, parentId, projectId, title, status, result? }`. Emitted from the reporter's replay-safe report phase after the status commit: at least once, never inside a transaction. Each listener is contained: a throw or rejection is logged and the others still run |
| `wire/typing(conversation, on)` | parallel | typing indicators |
| `plugins/changed()` | emit | the composed tree or a row's state changed |
| `credentials/updated(ref)` | emit | a credential reference now resolves to a new value, or was deleted; rows with `${credential:REF}` templates reconnect |
| `mcp/changed()` | emit | the MCP server tool set changed; `tool-mcp` republishes its extension |

Turn, tool and request interception stay pi-native: install an extension with hooks or `wrapTool`.

## Rows, bundles and layers

A row is a loader `EntryOptions`: `{ id, name: "cordis:<plugin>", config?, disabled?, group?, isolate? }`.

- **Catalog.** `src/catalog.ts` lists the kernel rows in the `xin-base` bundle: the required ones (`db`, `clock`, `pi`, `ops`, `http`, `wire`, `secrets`, `plugins`, `packages`, `system`) and one that is not required and is disabled by default, `tool-plugins`. Every feature is a package under `plugins/<name>/` (models, files, intake, memory, push, skills, mcp, workspace, schedules, orchestrator, jobs, questions, watchdog, failures, deploy-hook, time), and the generated `src/catalog.gen.ts` lists them and installed dependencies, one bundle per package. Entries are `{ plugin, title, description, required?, local?, source }`; `local: true` marks a package that lives in this repository. A package can never declare a core plugin, bundle or row id.
- **Feature modules** are native Cordis plugins, as in dsh: `export const name`, `inject` and `apply(ctx, config)`. `apply` registers each part as an effect through the kernel services: `ctx.provide`, `ctx.pi.install`, `ctx.ops.define`, `ctx.http.route`, `ctx.wire.home`, `ctx.clock.timer`, `ctx.on("wire/typing")`, and `ctx.effect` for start-up work with a disposer. Helpers take narrow ports (`{ db, arm }`) that `apply` builds and tests build directly. (P1 to P4 mounted features through a `hostModule` adapter; P5 removed it.)
- **Bundles.** A bundle is an ordered list of rows. `xin-base` holds the kernel rows. `xin.profile.json` names `xin-base` and every feature package's bundle. A package can ship its own bundle.
- **Layers**, applied in order to an empty list (as in dsh):
  1. The bundles named in `xin.profile.json`, in order, then the runtime bundles (§12).
  2. That file's `patch`. It is build time and checked in.
  3. The owner patch. It is run time and stored in the `kv` key `plugins.patch`.

  The last write wins per row.
- **Patch semantics (dsh).**
  - `{ insert: [rows] }` appends rows.
  - `{ id, ...fields }` replaces each named field of that row whole, `config` included, with no deep merge.
  - An unknown id is reported and skipped.
- **Persistence.** `XinLoader.commit(change)` recomputes the owner patch as the minimal departure from the lower layers and stores it, so the owner patch records only what the owner changed, and writing a row's inherited value back drops its override (dsh `config-editor`). The owner adds rows by putting a local bundle (§12), as dsh adds rows through a bundle.
- **Failure.**
  - A failed `required` row puts Home in `boot_failed`. `/v1/status` reports it and ops return `unavailable`.
  - Any other failed row is reported as `failed` with its error, and the rest keep running.
  - A row whose plugin is missing from the catalog, for example after a removal, is reported as `missing` and is not mounted.

## Plugin manager (`plugins` row)

| Op | Effect |
| --- | --- |
| `plugin.list` | rows with id, name, state (`active`, `pending`, `failed`, `disabled`, `missing`), error, layer, config and its schema JSON |
| `plugin.catalog` | compiled plugins with meta, `Config` schema JSON and the package they came from |
| `plugin.tree` | `{ [id]: { addedBy, patchedBy } }` for every composed row (dsh `--dump-config`), plus the bundles, runtime bundles, lower rows, owner patch and warnings |
| `plugin.enable` | `{ id, enabled }`. Rejected for a `required` row |
| `plugin.configure` | `{ id, config }`, validated against the plugin's `Config` before it is committed. Rejected for a plugin with no `Config` (every kernel service but `plugins`) and for a `missing` row |
| `plugin.install` | `{ spec }` records a parsed package spec for the next build: `{ kind: "registry", name, range? }` or `{ kind: "git", url, ref? }`. Idempotent per spec, and it cancels a pending removal of the same package |
| `plugin.uninstall` | `{ package }` records a package for the next build to remove. Rejected when the package provides a core row, is local to this repository, or is not in the build |
| `plugin.packages` | the build's `installed` packages as `{package, version}`, and the `pending` `{add, remove}` list the next build will apply |

`plugin.install`, `plugin.uninstall`, `plugin.packages`, the `GET /v1/build/packages` route and the boot reconcile live in the `packages` row; the other ops in this table live in `plugins`.

Every mutating result carries `application: "applied" | "failed"` and the row's new state. A change applies live in place through Cordis disposal. New code always means a rebuild and `system.update`.

The agent tool `plugin_manager` is its own row, `tool-plugins` (`src/kernel/managertool.ts`, not required, disabled by default, as dsh ships `plugin_manager` as an optional tool row). It takes `action: list | catalog | tree | enable | configure`. Approval of its mutations follows dsh `tools/pre-execute` and `user-approval` (P10).

A row whose new config or code fails to start is an outcome, not an error: the op returns `application: "failed"` with the row and its recorded error, and the other rows keep running.

## Presets

As in dsh (`agent-preset`, `agent-preset-registry`), a preset is an ordinary row and the registry only names the default.

```yaml
- id: presets                 # the registry row
  plugin: presets
  config: { default: full }
- id: preset-full
  plugin: preset
  config: { id: full, name: Full, description: Every tool row., tools: all }
- id: preset-minimal
  plugin: preset
  config: { id: minimal, name: Minimal, tools: [tool-memory, tool-skills] }
```

A `preset` row config is `{ id, name?, description?, order?, tools }`, where `tools` is `"all"` or an allowlist of tool extension names (dsh lists child plugin rows; Xin's agent shares one tree, so a preset selects the `tool-*` extensions those rows install). Every extension that carries tools is named `tool-*`: `ctx.pi.install` throws for any other name. A new preset, or an override of a shipped one, is a bundle row or patch entry, as in dsh. Two preset rows with one `id` leave the later row `failed`. As in dsh, an unknown id fails only when it is used: `preset.select` and `project.create` answer `bad_args`, and a conversation whose recorded preset and default are both undeclared keeps every tool.

- **Selection** is per conversation, as dsh records a preset per session. A conversation records its preset id when it is created (`project.create { preset? }` for a coordinator, else the registry `default`); `preset.select { conversation, preset }` changes it only while the conversation has no turns, as dsh allows only for a blank session. A thread records its coordinator's preset when it is spawned. The records live in the plugin's own table (`presets`, one row per conversation). The service is `ctx.presets`: `list()` and `presetOf(conversation)`.
- **Definitions are read live.** A conversation keeps its preset id; each apply uses that preset's current definition, as dsh recovers a session with the current definition of its recorded preset. A conversation whose preset no longer exists uses `default`.
- **Removals.** For a conversation, the removed extensions are every installed `tool-*` extension that the preset's allowlist does not name; `"all"` removes none. Each apply computes them from `ctx.pi.installed` and calls `configure({ extensions: { remove } })` (or `null` for `"all"`) only when the resolved set differs, so replay is harmless.
- **Serialization.** Every apply runs through one queue: the row's start, `plugins/changed`, a new conversation and `preset.select` all append to it.
- **When.** The row applies on its own start, on `plugins/changed`, and when a conversation is created or selected. When the row unloads, it configures every recorded conversation back to `extensions: null`.

| Op | Effect |
| --- | --- |
| `preset.list` | the presets in `order`, the default, and each conversation's recorded preset |
| `preset.select` | `{ conversation, preset }` for a conversation with no turns; otherwise, or for an unknown conversation or preset, `bad_args` |
| `prompt.list` / `prompt.put` / `prompt.delete` | owner slash commands in kv `prompts`, a name-to-`{ description?, text }` map: list sorts by name, put replaces whole (name `^[a-z][a-z0-9-]*$`, text at most 8,000 characters), delete is idempotent. The composer expands `/name rest` through these before `message.send` |

## Install, update, restart

- **Code is installed at build time.** It cannot be installed in a running Worker.
  - A plugin package declares itself in `package.json`: `"xin": { "plugins": { "<name>": { "module": "./index.ts", "title", "description" } }, "bundle"?: [{ "id", "plugin", "config"?, "disabled"? }] }`. Without `bundle`, each plugin gets one row with its own name as the id. The bundle is named after the package.
  - `bun scripts/xin.ts plugin add <npm spec | git url | path> [--enable]` runs `bun add`, regenerates `src/catalog.gen.ts` and, with `--enable`, appends the bundle to `xin.profile.json`. `generate`, `list`, `enable`, `disable` and `remove` work the same way. In-repo packages under `plugins/*` are found without installing.
  - `plugin remove` and `plugin list` work the same way. Then deploy.
- **`system.version`** reports the build id (the `XIN_BUILD` define), the package versions, the bundles and whether the tree is degraded.
- **`system.restart`.**
  - `{ hard: false }` disposes the root context and boots it again in place, with the same code and fresh fibers.
  - `{ hard: true }` calls `state.abort()`, so the DO restarts on the next request.
- **`system.update`** asks the `deployer` seam to deploy. The default row, `deploy-hook`, POSTs to the URL, token and ref its config builds from `${credential:REF}` templates, such as a GitHub `workflow_dispatch` or a Cloudflare Workers Builds deploy hook. The new version comes up when Cloudflare restarts the DO on the new code. The result is `{ application: "deploying" }`, and the client polls `system.version`.

## Installing from the client

A Worker cannot run `bun add` or load code it did not ship with. An install is therefore two steps: the owner records the wish, and a build applies it.

1. The owner calls `plugin.install` or `plugin.uninstall`. The `packages` row parses an install spec at the boundary into `{ kind: "registry", name, range? }` or `{ kind: "git", url, ref? }`, and stores the list in the `kv` key `plugins.packages` together with the build id each entry was recorded under. It accepts a registry name, `name@range`, `github:owner/repo[#ref]`, `git+https://host/x.git[#ref]` and `https://host/x.git[#ref]`, and rejects every other scheme (`file:`, `link:`, `npm:`), tarball URLs, whitespace and shell characters. Both ops are idempotent, and an install cancels a pending removal of the same package. A package in this repository (`local: true`) cannot be uninstalled; disable its bundle instead.
2. `system.update` reads that list and calls `deployer.deploy({ packages })`. `deploy-hook` puts `{ ref, inputs: { packages: JSON.stringify(packages) } }` in its POST body, which is what a GitHub `workflow_dispatch` accepts. A pipeline that cannot take a body fetches the same JSON from `GET /v1/build/packages`, behind the Worker's owner token.
3. The pipeline runs `bun scripts/xin.ts plugin sync <file|->`, which applies `bun add` and `bun remove`, then edits `xin.profile.json` and regenerates `src/catalog.gen.ts`. Every `bun` command runs before the profile changes, so a failed removal leaves both files untouched. An empty list does nothing.
4. When a later build boots, the `packages` row reconciles the list. An entry recorded under this build is kept. On a newer build, a registry add settles when the build has the package name (and, when the spec gives a range, the built version satisfies it), a git add settles when its resolved name is present or, without one, when the build changed, and a removal settles when the package is gone. Reconcile is idempotent, so a boot after a crash repeats it harmlessly.

`plugin.packages` returns the build's `installed` packages (from the catalog's `source` values) and the `pending` list, so the client can show both what is running and what the next build will change. The full workflow is in `docs/deploy/install-pipeline.md`.

## Authoring a plugin

```ts
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { type Context, Schema } from "../src/kernel/index.ts"

export const name = "hello"
export const inject = ["pi", "ops"]
export const Config = Schema.object({ greeting: Schema.string().default("hi") })

export function apply(ctx: Context, config: { greeting: string }) {
  ctx.pi.install(
    defineExtension({
      name: "hello",
      tools: [
        defineTool({
          name: "hello",
          description: "Say hello.",
          parameters: obj({}),
          execute: async () => ({ output: [{ type: "text", text: config.greeting }] }),
        }),
      ],
    }),
  )
  ctx.on("ops/before", async (call, next) =>
    call.command.op === "hello.forbidden" ? { kind: "rejected", code: "forbidden", message: "no" } : next(),
  )
}
```

## Trust

In-process plugins run in the Home isolate with full access to what they `inject`, as in dsh. Installing a package is the trust decision. There is no network allowlist. Secrets are scoped by the calling row's id, so one row cannot read another's values by accident, but in-process scoping is not a security boundary. Running untrusted third-party code without a redeploy needs a separate isolate behind the same services over RPC. Cloudflare's Dynamic Workers (the Worker Loader binding) provide one with no container, but only on the Workers Paid plan (checked 2026-11-07), so it is later. On the free plan, code arrives through the install pipeline: build, then deploy.

## Later

- **A market index.** A read-only list of plugin packages, with an install hint, for the CLI.
