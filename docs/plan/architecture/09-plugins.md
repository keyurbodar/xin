# 15 · Plugins: one model, three scopes

Xin's plugin layer is the one deepseek-harness (dsh) uses: Cordis contexts, services, typed events and reversible effects, composed from a tree of loader rows. There is no privileged core. The kernel services, pi-durable itself and every feature are rows that a patch can configure, disable or replace.

This section adds the one thing dsh leaves implicit and Xin makes a first-class word: **a plugin is mounted at a scope**. A plugin can apply to the whole Home, to one project, or to one thread, and the composition of a scope is resolved by inheritance. That is what makes a personal agent feel configurable without a settings maze: the same plugin can be on everywhere and off in one project, with no second mechanism.

A plugin is **trusted code that just runs**. Installing the build is the only trust decision. There are no permission grants, no approval prompts and no sandbox; those were designed, then cut (see [Dropped for simplicity](#dropped-for-simplicity)).

Read with: [01 Host](./01-host.md) for the alarm loop the `clock` service owns, [03 Commands and wire](./03-commands-and-wire.md) for the `ops` and `wire` services, [05 Models](./05-models.md) for the `models` seam, [12 Market](./12-market.md) for installs.

**Status.** Slices 1 and 2 of this design are implemented in this build: the manifest, catalog generation, `plugin.doctor`, mount-time API and requirement checks, presets as plugin sets, and per-scope preset selection for Home, projects and threads. Per-scope host-row mounting is not built; no plugin needs it yet.

## The model in two sentences

- **For a plugin author:** a plugin is one module that declares what it is in `package.json` and registers capabilities as effects on the context it is given.
- **For a person:** a plugin adds an ability; a preset is a named set of plugins; you can give a preset to the whole Home, a project, or a thread. There is nothing to approve: installing it is the decision.

Everything else is engine.

## Vocabulary budget

The design goal is the smallest vocabulary that still covers every case dsh covers. Three words are for the person, three are for the author (two of them shared), and six are internal and never appear in the UI or in author documentation.

| Word | Who says it | Means | dsh equivalent |
| --- | --- | --- | --- |
| **Plugin** | author, user | one module plus its manifest; the thing you install and turn on | plugin entry / package |
| **Preset** | user | a named set of plugins | agent preset |
| **Scope** | user | where a preset applies: Home, a project, or a thread | profile + agent scope |
| **Capability** | author | one typed extension point a plugin registers on (tool, hook, op, timer, …) | service + event |
| **Manifest** | author | the `xin.plugins.<name>` declaration in `package.json` | `dsh` field, `engines.dsh` |

| Internal word | What it is | Why it stays internal |
| --- | --- | --- |
| row | one mounted instance of a plugin with its config | ids are an implementation detail; the UI groups by plugin |
| bundle | the ordered rows a package ships | a package with one plugin needs no second word |
| layer, patch | how rows compose from build, profile and owner edits | only `plugin.tree` needs them |
| catalog | the plugins compiled into this build | "what is in this build" is enough |
| isolate realm | a service scope inside Cordis | a scope is a place, not a realm |
| loader | Cordis' row tree | engine |

dsh asks a user to hold profile, bundle, patch, row, preset, isolate, plugin, market index, version exemption, platform and approval: eleven. Xin keeps dsh's engine and reduces the public set to five by giving three of those words a default that needs no decision (one Home, one bundle per package, one trust decision per build) and by dropping approvals and exemptions entirely.

## What a plugin can hook into

A capability is a typed registration on a kernel service. The closed set below is the whole extension surface; a new capability means a new service plus a typed event, never a new mechanism.

**Agent** — per conversation, installed in the pi registry and selected by the conversation's agent:

| Capability | Registration | What it does |
| --- | --- | --- |
| tool | `defineTool` in an extension named `tool-*` | model-facing action |
| prompt | `section(key, render)` | a system-prompt section |
| hook | `hook(GenerationTask \| ToolTask, handlers)` | intercept a request, a tool call, a run's end |
| wrap | `wrapTool` / `wrapSection` | decorate another tool or section by name |
| task | `defineTask` | durable background work, resolved by name |
| doc | `defineDoc` | typed conversation or session state committed with the transcript |
| extension | `ctx.pi.install(extension)` | the bundle the six above travel in |

**Host** — per Home:

| Capability | Registration | What it does |
| --- | --- | --- |
| service | `ctx.provide(key, value)` | a seam other plugins inject |
| op | `ctx.ops.define(op)` | an owner or agent command with a receipt |
| route | `ctx.http.route("GET /path", handler)` | an HTTP endpoint in the Home |
| wire | `ctx.wire.home(part, fn)` | a part of the home snapshot |
| event | `ctx.on(name, fn)` / `ctx.emit(name, …)` | a typed event, with a declared dispatch mode |
| timer | `ctx.clock.timer({ due, fire })` | work on the single DO alarm |
| migration | `ctx.db.applySqliteMigrations(owner, steps)` | the plugin's own tables, append-only |
| secret | `ctx.secrets.get(ref)` | a named credential, sealed with the KEK |
| files | `ctx.files` | the file index and R2 bytes |
| config | `export const Config = Schema.object({…})` | a validated, serialisable configuration |

**Integration** — the seams that connect Xin to the outside:

| Capability | Registration | What it does |
| --- | --- | --- |
| MCP server | `mcp-server` row | tools from a remote MCP server; the plugin is compiled into the build, but no bundle mounts it, so the shipped profile never starts one (see "MCP surface" below) |
| model provider | `ctx.pi.models(fn)` / host providers | model catalog and credentials |
| deployer | `ctx.deployer` | how `system.update` ships a build |

**Human** — the two things a plugin may ask a person for, below.

**Contributions without an extension.** A plugin can contribute a slash-command prompt with `ctx.prompts.contribute(prompt, rowId(ctx))` and a skill with `ctx.skills.contribute(skill, rowId(ctx))`. The row is the source, exactly as it is for an extension, and a preset keeps or drops it by the plugin that owns the row. `prompt.list { conversation }` filters prompts for that conversation, and `tool-skills` filters the skills section and the `skill` tool the same way. A stored owner prompt or skill always survives, because the owner made it.

Rules:

- Every registration is an effect. Disposing a row or reconfiguring it unwinds exactly what it added, in reverse order.
- Boot order comes from `inject`, not from list order. A row waits for its services and unloads when one goes away.
- A helper takes a narrow port (`{ db, arm }`), never the whole context. Only the row module that declares `inject` reads `ctx.<service>`; `bun scripts/boundaries.ts` enforces it.
- Policy hooks are waterfalls and must call `next()`; a listener that returns an outcome decides it. Order between independent listeners is not a contract.

### pi-durable is the agent seam

Xin does not reimplement the agent loop. pi-durable's **extension** is the unit the registry installs; Xin's **plugin** is the unit the owner installs. One plugin may install several extensions (a service row and a `tool-*` row), and an extension may come from a plugin with no host surface at all.

| pi surface | What a plugin does with it | Rule |
| --- | --- | --- |
| extension | `ctx.pi.install(defineExtension({ name, tools, sections, hooks, wraps, tasks }))` | named `tool-*` when it carries tools |
| tool | `defineTool({ name, description, parameters, execute, replay })` | `replay: "safe"` only when the call is idempotent |
| section | `section(key, render)` | stable text first; live state as entries, not sections |
| hook | `hook(GenerationTask, …)`, `hook(ToolTask, …)` | generation: `beforeRequest`, `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools`, `afterRun`; tools: `beforeTool`, `afterTool` |
| task | `defineTask` | durable background work: use a pi task when it must survive a restart, a `clock` timer when it only needs to run |
| doc | `defineDoc` | typed state committed with the transcript, at conversation or session scope |
| selection | `conversation.configure({ extensions })` | the seam scopes use: install once, select per conversation |

What this buys: a plugin's background work is durable and replay-safe for free, a hook reads committed state through `api.snapshot()`, and scoping becomes a selection rather than a second registry. It also means a plugin never needs to know how the loop works to add a tool, a prompt section or a guard.

## Declaration: the manifest

A package declares its plugins in `package.json`. Everything is optional; a plugin that declares nothing runs at Home.

```json
{
  "name": "xin-plugin-weather",
  "version": "1.2.0",
  "xin": {
    "plugins": {
      "weather": {
        "module": "./index.ts",
        "title": "Weather",
        "description": "Forecasts and alerts for the owner's places.",
        "api": 1,
        "requires": ["models@^0.1"]
      }
    },
    "bundle": [{ "id": "weather", "plugin": "weather" }]
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `api` | `1` | the plugin API version the module is written against |
| `requires` | `[]` | other plugins it needs, `name` or `name@range` |

`bun scripts/xin.ts plugin generate` parses and validates every manifest and writes it into `src/catalog.gen.ts`. A bad manifest fails the build, not boot. The running Worker never reads `package.json`; the catalog is the single source at run time.

The two fields earn their place:

- `api` is the only hard compatibility axis for in-process code. Semver of the package is for distribution; the API version is the contract.
- `requires` catches the common failure of a plugin that calls a service another plugin provides.

`scopes` joins the manifest with per-scope host mounting (slice 4). The agent surface is scoped today by presets, which need no declaration from the plugin.

There is deliberately no `permissions` field. A plugin is trusted code; asking a person to tick capabilities before it can work was ceremony with no enforcement behind it, so it is gone.

## Discovery

Three questions, three surfaces:

| Question | Surface | Answers |
| --- | --- | --- |
| What can I install? | `market.search` / `market.entry` | the build's own packages plus any configured index: package, version, `engines.xin`, code or bundle, install spec |
| What is in this build? | `plugin.catalog` | every plugin with title, description, manifest, config schema, source package@version |
| What is running, and is it healthy? | `plugin.list`, `plugin.doctor`, `plugin.tree` | row state, issues, and the composition that produced them |

`plugin.doctor` is the one place that explains a plugin. Each row reports its manifest, package, version and `issues`:

| Issue | Meaning | Action |
| --- | --- | --- |
| `api` | the module wants a plugin API this build does not support | update the plugin or the build |
| `require` | a required plugin is absent or outside the range | install it, or change the requirement |
| `failed` | the row threw while starting | read the error, fix config or code |
| `missing` | the row names code this build does not have | install the package and rebuild |

`ok` is true when no row has an issue. The mount-time checks (`api`, `require`) fail only that row: it appears in `plugin.list` with a `failed` state and its reason, the rest of the Home keeps running, and a required row that fails still puts Home in `boot_failed`.

The next slice adds the inverse check: an inventory of what each active row actually registered, compared with its declaration, so "declares tools but added none" is visible.

## Versioning

Four axes, each with one rule:

| Axis | Field | Rule | On mismatch |
| --- | --- | --- | --- |
| Plugin API | `xin.plugins.*.api` | equality with `PLUGIN_API` (1) | row `failed`, doctor explains |
| Package | `version` | semver; the market reads `engines.xin` | the market hides or marks it |
| Requirements | `requires` | semver range against the build's plugin version | row `failed`, doctor explains |
| Config and data | `Config`, own migrations | schemastery validates on write; SQL migrations are append-only | a write is rejected; a migration is applied once |

Composition is **not pinned**. A scope records a preset id, not versions, and each apply resolves the current build's plugins (as dsh recovers a session with the current definition of its recorded preset). An update therefore takes effect on the next apply; a conversation already running keeps its extension selection until then. `plugin.doctor` reports drift: a preset that names a plugin this build no longer has.

An update whose `api` matches applies live through Cordis disposal; one that needs a new API needs a build and `system.update`. Rollback is the same operation in reverse: reinstall the previous version (a deploy for code, `bundle.put` for a bundle). No separate rollback store and no version exemptions: a plugin either fits this build or it does not.

## Scopes

**Implemented for the agent surface.** A scope is a node in a tree: Home → project → thread. Each node selects one preset, and a preset names the plugins whose capabilities its conversations get.

| Scope | Set by | Applies to |
| --- | --- | --- |
| Home | the `presets` row's `default` | the root chat and every project without a preset |
| project | `project.create { preset }` or `project.update { preset }` | the coordinator and its threads |
| thread | `preset.select { conversation, preset }` | that thread |
| root chat | `preset.select { conversation, preset }` | the root chat |

**Resolution.** A conversation's own selection, else its project's preset, else Home's default. A thread with no selection follows its project, so changing the project's preset reaches threads that never overrode it. An unknown preset id falls back to the default, never fails a run. `project.update { preset }` clears an explicit selection on the coordinator, so the project setting wins unless the owner selected a preset on that conversation directly.

**What a scope changes.** The conversation's pi extension selection. Every installed extension is attributed to the plugin row that installed it, and the selected preset keeps the extensions of the plugins it names; `"all"` keeps everything. That covers tools, prompt sections, hooks, wraps and tasks, because they all travel in an extension. A preset that names `tool-memory` keeps memory's tools; a preset that names `time` keeps the time section.

The same rule covers plugin-contributed prompts and skills. A contributed prompt appears in `prompt.list { conversation }` only while its plugin is in the conversation's preset; a contributed skill appears in the skills section and the `skill` tool only under the same condition. The source is the row that contributed it, so one rule serves extensions, prompts and skills.

**What a scope does not change yet.** Host rows: services, ops, routes, timers and SQL migrations stay at Home. Per-scope mounting would need a child Cordis context and service isolation, and no plugin needs it today. A project-scoped timer is the first use case that would justify it; until then a preset filters the agent surface, not the host surface.

**Presets.** A preset is `{ id, name?, description?, order?, plugins }`, where `plugins` is `"all"` or plugin names. Definitions are read live: editing a preset changes every scope that uses it on the next apply, and `plugins/changed` triggers that apply. `preset.select` only works while the conversation has no turns, as before; `project.update` works at any time and takes effect on the next turn.

**The breaking change.** `tools` is gone. A preset row that still declares `tools` fails validation and its row reports `failed`; the fix is to rename the field to `plugins`. A `tools` list maps one-to-one when its names are `tool-*`, which is what the shipped presets use.

**Lifecycle.** A Home restart rebuilds the scope maps from `WorkspaceDoc` and the `presets` table, so a crash converges. A new thread resolves its project's current preset. Archiving a project does not dispose anything, because nothing is mounted per project yet.

## Trust: a plugin just runs

**Trust tiers.** `core` rows are required and cannot be removed. `build` rows come from packages in `xin.profile.json`; installing the build is the trust decision. `runtime` rows come from a bundle or an owner patch at run time. Third-party *code* always arrives through a build; a bundle can mount only plugins that are already compiled.

**What is not there.** No permission grants, no capability declarations, no per-call approval, no sandbox, no capability list to click through. A plugin runs with the same JavaScript access as the kernel, because it is the same isolate. This is dsh's model and the honest one for a personal agent: the boundary is what you install, not what you tick.

**What a person sees.** A plugin is on or off, with a title, a one-line description and the tools it adds. Turning it on is one action. There is nothing to approve before it works.

**Remote code.** An MCP server is the free plan's isolation story for code that runs elsewhere: the code executes in its author's host, and Xin holds only a connection. A bundle mounts live but references compiled plugins.

**The paid path, if it is ever needed.** Cloudflare's Worker Loader gives a real isolate behind the same services over RPC. It is not planned: no concrete use case requires it today. If a public plugin directory with unknown authors appears, that is the trigger, and the manifest would gain a field then. Nothing in this design depends on it.

## What a plugin may ask for

Two things, both existing agent surfaces, neither an approval:

| Kind | Asked at | The user sees | The plugin gets |
| --- | --- | --- | --- |
| config | install, settings | a form built from `Config`, with working defaults | validated values |
| question | during a run | a question with optional choices | text or a choice, durable across restarts |

Rules:

- **No approval seam.** The kernel does not prompt before a plugin acts. A plugin that wants a human decision asks a question or uses its own tool; it cannot make the product ask "allow?" on its behalf.
- **Defaults first.** `Config` has defaults, so a plugin does useful work with no setup. Configuring is optional, not a gate.
- **Credentials are config.** A plugin that needs a key names the reference and reads it with `ctx.secrets.get`; the owner sets it once with `secret.set`. There is no per-use prompt and no credential dialog owned by the plugin.
- **One surface.** A question is the existing `ask_user` path: it lands in the thread, is durable, and an answer starts the next run. A plugin does not render UI or own a socket.
- **Fail closed, quietly.** A missing credential yields `undefined`; the plugin decides whether to report that as a normal tool error. Nothing hangs waiting for a person who is not there.

## UX: the concept budget

The question is not how many features the plugin system has, but how many words a person must hold. The answer is three public words, two verbs, four states.

**Author path, three steps.**

1. Write `apply(ctx, config)` and register capabilities.
2. Add one manifest entry to `package.json`.
3. Run `bun scripts/xin.ts plugin add <spec> --enable`, then deploy.

No profile, no layer, no patch, no bundle unless the package ships more than one plugin. A plugin with no manifest still works.

**User path, three verbs.**

1. **Install** a plugin (from the market or a package).
2. **Choose a preset** for Home, a project, or a thread.
3. **Turn a plugin on or off** in that preset.

Nothing is granted, approved or configured before a plugin works.

**Four states, one action each.** On (nothing), off (turn on), incompatible (update it or the build), broken (open doctor). No fifth state and no error code in the main surface.

**Progressive disclosure.** `plugin.tree`, `plugin.catalog` and the full issue list are the "why is this broken?" path. The main surface shows a plugin, what it adds in one line, and where it applies.

**Moves that keep it small.**

- One word for the thing, one for a set, one for where. "Plugin", "preset", "scope".
- The engine is hidden: rows, bundles, layers and patches appear only in `plugin.tree`.
- Defaults that need no decision: one Home, one bundle per package, api 1, home scope, working config.
- A hard API contract instead of version exemptions: a plugin either fits this build or it does not.
- No platform declarations and no per-client plugin lists until there is a second client.
- No permissions, approvals or sandbox until a concrete use case demands one.

**What we deliberately do not expose:** profiles (one Home), layer precedence, isolate realms, version exemptions, HMR toggles, platform gates, permission grants.

## Dropped for simplicity

Designed, then cut because each added a concept or a click without buying a real outcome:

| Dropped | Why |
| --- | --- |
| **Permission grants and consent cards** (`net`, `secrets`, `files`, `schedule`, `agent`; `plugin.grant` / `plugin.revoke`) | in-process code cannot be confined by a declaration, so the grant was an audit form, not a boundary; the build is the real trust decision |
| **Per-call approvals** (dsh `user-approval`, `tools/pre-execute`) | every prompt interrupts a run; a plugin that needs a decision can ask a question, and the owner's own agent does not need a permission slip |
| **Version exemptions** (dsh `compatibility.json`) | an `api` mismatch is a code problem; granting an exception would only produce a crash later |
| **Platform declarations** | one client, one host; nothing to declare |
| **A sandbox / Worker Loader** | no concrete use case today; MCP covers code that runs elsewhere, and the build covers code that runs here |
| **A `provides` registry and capability inventory in the manifest** | `inject` already resolves services and fails a row that cannot get one; an inventory is diagnostics, not a gate, and arrives with `plugin.doctor`'s next slice |
| **A config wizard at install** | `Config` defaults make a plugin work with no setup; settings remain optional |

The `net` permission check named in M8 belonged to the pre-P5 host adapter, which no longer exists; there is no permission check in the plugin layer today.

## Rows, bundles and layers (engine)

A row is a loader `EntryOptions`: `{ id, name: "cordis:<plugin>", config?, disabled?, group?, isolate? }`. A bundle is an ordered list of rows. Layers apply to an empty list:

1. The bundles named in `xin.profile.json`, in order, then the runtime bundles ([12 Market](./12-market.md)).
2. That file's `patch`. It is build time and checked in.
3. The owner patch. It is run time, stored in `kv` key `plugins.patch`, and recomputed as the minimal departure from the lower layers.

The last write wins per row. A patch replaces each named field whole, config included, with no deep merge. An unknown id is reported and skipped.

`XinLoader.commit` stores the owner patch so it records only what the owner changed. Adding a row is a local bundle, as dsh adds rows through a bundle.

**Failure.** A failed `required` row puts Home in `boot_failed`; any other failed row is reported with its error and the rest keep running; a row whose plugin left the build is `missing` and is not mounted.

**Kernel services (seams).** Each service is a row in `xin-base`; a different row can provide the same key.

| Key | Row | Surface |
| --- | --- | --- |
| `host` | root facts, not a row | `state`, `env`, `abort` |
| `db` | `db` | SQLite plus `applySqliteMigrations` |
| `pi` | `pi` | `registry`, `install(extension)`, `models(fn)`, `env(fn)`, `open()` |
| `harness` | `pi` init | the pi-durable `Harness` |
| `ops` | `ops` | `define`, `run`, `list` |
| `http` | `http` | `route`, `handle` |
| `wire` | `wire` | sockets, `home(part, fn)`, `publishHome()` |
| `clock` | `clock` | `timer`, `arm`, `fire`; owns the single alarm |
| `secrets` | `secrets` | `get`, `set`, `values()` (kernel only), redaction |
| `plugins` | `plugins` | the manager and doctor below |
| `packages` | `packages` | installed packages, pending installs, runtime bundles |
| `system` | `system` | version, restart, update |

Feature services follow the same pattern (`models`, `files`, `memory`, `push`, `skills`, `mcp`, `workspace`, `threads`, `jobs`, `questions`, `schedules`, `watchdog`, `intake`, `presets`). A tool-only package such as `tool-web` or `tool-git` provides no service and mounts only its tool row. A feature that others call provides a key; one that only adds tools, ops or timers provides none. A feature package splits its service row (`<name>`) from its tool row (`tool-<name>`), so disabling the tools leaves the service running.

**Events** are declared on Cordis `Events` with an `@mode` tag: `ops/before` (waterfall), `intake/batch` (waterfall), `thread/settled` (emit), `wire/typing` (parallel), `plugins/changed`, `credentials/updated`, `mcp/changed` (emit; the MCP surface changed, whether tools, resources or prompts). Turn, tool and request interception stays pi-native through extension hooks.

**MCP surface.** `tool-mcp` installs one deferred tool per MCP tool. When a server declares the `resources` capability it also installs `mcp_resources` (list resources and templates) and `mcp_resource` (read one URI); when it declares `prompts` it installs `mcp_prompts` (list) and `mcp_prompt` (render with arguments). All four are read-only, carry the server name in their tool name, and sit behind `tool_search`. `mcp.list` reports the cached tool count and, when the capability is present, the resource, template and prompt counts; `mcp.resources { name }` and `mcp.prompts { name }` read the live lists. Disabling `tool-mcp` hides all of them together, and a preset that hides the row does the same. There is no sampling, elicitation or GET stream.

**`mcp-server` ships unmounted.** The plugin is in the catalog — `xin-plugin-mcp`, module `server.ts`, config `{ name, url, headers? }` — but `xin-plugin-mcp`'s bundle lists only `mcp` and `tool-mcp`, so no row of `mcp-server` is in the composed tree and `plugin.list` never shows one. The shipped profile therefore configures no MCP server: `tool-mcp` is mounted and has nothing to expose, and `mcp.list` answers empty. Mounting a server takes a row, in one of two ways: add `{ "id": "mcp-server", "plugin": "mcp-server", "config": { "name": "…", "url": "…" } }` to `plugins/mcp/package.json`'s `xin.bundle` and regenerate the catalog (`bun scripts/xin.ts plugin generate`), which is a build and a deploy; or install a runtime bundle with `bundle.put { package, rows: [...] }`, which mounts live with no deploy (12).

## Plugin manager

| Op | Effect |
| --- | --- |
| `plugin.list` | rows with id, plugin, title, state, layer, config and manifest |
| `plugin.catalog` | compiled plugins with title, description, manifest, config schema and source |
| `plugin.doctor` | `{ ok, rows }` with package, version, state, manifest and issues |
| `plugin.tree` | `{ bundles, runtime, layers, lower, owner, rows, warnings }` |
| `plugin.enable` | `{ id, enabled }`; rejected for a required row |
| `plugin.configure` | `{ id, config }`, validated against `Config`; rejected for a plugin without one |

Every mutating result carries `application: "applied" | "failed"` and the row's new state. A row whose new config or code fails to start is an outcome, not an error.

The agent tool `plugin_manager` is its own row, `tool-plugins` (not required, off by default). It reads `list`, `catalog`, `tree` and `doctor`, and can `enable` and `configure` a row like the owner can.

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

```json
{ "xin": { "plugins": { "hello": { "module": "./index.ts", "title": "Hello" } } } }
```

## Slices

| Slice | Builds | Status |
| --- | --- | --- |
| 1 | manifest v2, catalog generation, `plugin.doctor`, mount-time `api`/`requires` checks | done |
| 2 | presets as plugin sets, per-scope selection (Home, project, thread), per-conversation extension selection | done |
| 3 | the market's default index is the build's own packages; the shipped presets moved to `plugins` | **this change** |
| 4 | live inventory of what each row registered, config migrations | later |
| 5 | per-scope host-row mounting: services, ops, routes and timers inside a project or thread | only if a plugin needs it |
| 6 | a sandbox behind the same services | only if a concrete use case appears |

## Decisions (settled)

1. **Scope granularity:** Home → project → thread. The project is the middle level, so a project and its threads share one preset until a thread overrides it.
2. **Preset semantics:** one breaking change from `tools` to `plugins`. No dual model and no migration layer; a row that still says `tools` fails and is fixed by renaming the field.
3. **API stability:** `api: 1` is frozen now. A breaking kernel change is `api: 2` with a deprecation window.
4. **Naming:** the user-facing word stays "preset".

Two triggers would reopen a cut: a plugin that needs a project- or thread-scoped timer, op or route justifies per-scope host mounting; a public plugin directory with unknown authors would justify a sandbox. Neither exists today.
