# 15 · Plugins: one model, three scopes

Ingle's plugin layer is the one deepseek-harness (dsh) uses: Cordis contexts, services, typed events and reversible effects, composed from a tree of loader rows. There is no privileged core. The kernel services, pi-durable itself and every feature are rows that a patch can configure, disable or replace.

This section adds the one thing dsh leaves implicit and Ingle makes a first-class word: **a plugin is mounted at a scope**. A plugin can apply to the whole Home, to one project, or to one thread, and the composition of a scope is resolved by inheritance. That is what makes a personal agent feel configurable without a settings maze: the same plugin can be on everywhere and off in one project, with no second mechanism.

A plugin is **trusted code that runs in the Home's isolate**, so a manifest cannot confine it. What the manifest does is make it honest: a plugin declares the **permissions** it needs and the **tools and ops it contributes**, and the kernel refuses a row whose code reaches past either declaration, at mount, at the service access, or at build (see [Permissions and contributions](#permissions-and-contributions)). The checks keep honest code to its declaration; they cannot confine hostile code, because there is no sandbox. There are still no per-call approvals.

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
| **Manifest** | author | the `ingle.plugins.<name>` declaration in `package.json` | `dsh` field, `engines.dsh` |

| Internal word | What it is | Why it stays internal |
| --- | --- | --- |
| row | one mounted instance of a plugin with its config | ids are an implementation detail; the UI groups by plugin |
| bundle | the ordered rows a package ships | a package with one plugin needs no second word |
| layer, patch | how rows compose from build, profile and owner edits | only `plugin.tree` needs them |
| catalog | the plugins compiled into this build | "what is in this build" is enough |
| isolate realm | a service scope inside Cordis | a scope is a place, not a realm |
| loader | Cordis' row tree | engine |

dsh asks a user to hold profile, bundle, patch, row, preset, isolate, plugin, market index, version exemption, platform and approval: eleven. Ingle keeps dsh's engine and reduces the public set to five by giving three of those words a default that needs no decision (one Home, one bundle per package, one trust decision per build) and by dropping approvals and exemptions entirely.

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

**Integration** — the seams that connect Ingle to the outside:

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

Ingle does not reimplement the agent loop. pi-durable's **extension** is the unit the registry installs; Ingle's **plugin** is the unit the owner installs. One plugin may install several extensions (a service row and a `tool-*` row), and an extension may come from a plugin with no host surface at all.

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
  "name": "ingle-plugin-weather",
  "version": "1.2.0",
  "ingle": {
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
| `permissions` | `[]` | what it may ask the owner for, from the closed set below |
| `contributes` | unchecked | `{ tools, ops }` it registers; a trailing `*` covers a prefix |
| `client` | none | a web module (`client.tsx`) compiled into the web build |
| `slots` | `[]` | the client slots that module fills; required with `client` |

### Permissions and contributions

| Permission | Guards the services | Shown to the owner as |
| --- | --- | --- |
| `secrets` | `secrets` | Read your stored credentials |
| `files` | `files` | Read and change your files |
| `storage` | `db` | Keep its own tables in your Home |
| `routes` | `http` | Answer HTTP requests to your Home |
| `models` | `models` | Call models, which spends tokens |
| `conversations` | `harness` | Read and write your conversations |
| `plugins` | `kernel`, `packages`, `plugins` | Install, enable and configure plugins |
| `network` | none (no sandbox to enforce it) | Connect to the internet |
| `owner` | none: `ops.run` with the owner as actor; only first-party `ingle-plugin-automations` at `plugins/automations` may declare it, `readManifest` refuses it from any other package or path, and discovery refuses two packages with one name | Act as you: run any op you can, such as starting threads |
| `runtime` | `host` (raw Durable Object storage, environment and bindings) | Full access to your Home: raw storage, keys and the file bucket |

`runtime` implies every other permission but `owner`, since `host` reaches the raw SQLite, `KEK` and the R2 bucket; the checks grant it the rest, and `owner` must be declared on its own. Ten shipped plugins inject `host` today and declare it; narrowing them to guarded services is the way to shrink that list, as Drive did by reading and sharing blobs through the `files` service (`textOf`, `share`, `reshare`, `unshare`). The files service mints each share id and records the row that made it and its path; a plugin row gets a files service bound to its own row (the loader calls the service's `FOR_ROW` hook, `src/contracts/rowbound.ts`), so only that row can repoint or end its shares, and kernel code acts for the owner.

- **Mount check.** A plugin whose `inject` lists a guarded service without its permission is not mounted; the row reports `failed` and `plugin.doctor` carries `{ kind: "permission", permission, service }`. Kernel rows (no manifest) are exempt from every check here.
- **Access check.** A guarded service resolves for a kernel row (no manifest), for a plugin row whose manifest grants its permission (`runtime` grants all of them but `owner`), and for the one context the kernel trusts, the Durable Object host's own (`Home.services`); any other context gets none. So the root, the loader's context and an entry's context, which is what `ctx.fiber.parent` and `ctx.fiber.entry` lead to, resolve no guarded service, and `host` and `kernel` are provided from a kernel fiber rather than the root, so a walk up a row's ancestors finds neither. The check runs on every Cordis lookup: the loader's `internal/get` hook covers `ctx.<name>`, a nested `ctx.inject` and a child `ctx.plugin`, and the loader wraps `reflect.get`, so `ctx.get`, `ctx.reflect.get` and an aliased `ctx.get` are checked against the context they read through. `ctx.root` in a plugin row is the root re-attributed to that row's fiber. A plugin row may not listen to any `internal/*` event, so no row sees another row's `internal/get` or the values it resolves. Each lookup is one fiber walk and one map read: the row-to-permissions map is built at mount and on every recompose, and each new row is indexed as it is created. A service another plugin provides is checked as well, against the providing row found in Cordis's service store: a row in the same package reads it freely, and so does a row that holds `runtime`. Otherwise the first-party services that reach owner data need the permission they amount to (`PROVIDED` in `src/kernel/manifest.ts`: `drive` needs `files`; `intake`, `threads`, `watchdog`, `questions` and `memory` need `conversations`), and any other plugin service needs the reader's manifest to `requires` the providing plugin. So a service no permission covers is refused by default. A plugin row holds a plugin-provided service as a frozen object with no prototype that forwards the service's methods and carries none of its data, so no row can read another's state or replace a method other rows call.
- **Facades.** A plugin row never holds a Cordis service object. Every service it reads comes back as a frozen facade (`src/kernel/facade.ts`) with no `ctx`, no `cordis.original` and no prototype. A facade is an allowlist: it carries only the members shipped rows use (`ops.define`, `list`, `run`; `wire.home`, `publishHome`, `announce`; `pi.install`, `env` under `runtime`, `compaction` under `conversations`, `extensions`, `extensionsNamed` and `toolsNamed` under `plugins`, `conversations` under `conversations`, `models`, `currentModels`, `registry` under `plugins`; `clock.arm`, `timer`; `http.route`; `secrets.get`, `set`; `loader.locate`, plus `composition`, `permissionsOf`, `pluginOfRow`, `rows` and `state` under `plugins`), and every other member, data members included, is absent. Values that would carry credentials come back as views: `pi.currentModels()` needs `models` and answers only `getModel` and `getAvailable`, with no `getAuth`, `login` or `logout`, and `pi.registry` needs `plugins` and answers only `snapshot`, whose every read answers a fresh deep frozen copy of names and metadata with no function in it (no hook, handler, wrap or `execute`), so a row can neither plant keys the next reader sees nor change what runs. `pi.extensionsNamed` and `pi.toolsNamed`, both under `plugins`, answer handles that carry a name and nothing that runs, because `configure` keeps only names; presets removes extensions and the orchestrator removes and loads tools through them. `pi.extensions()` answers frozen `{ name, row, kind }` records, never another row's extension or tool objects; presets turns the names it removes into objects through `pi.extensionsNamed`. Manifests are frozen when read, the loader checks access against its own frozen copy of each row's permissions, and the kernel facade hands out frozen plain-data copies of `composition`, `permissionsOf`, `rows` and `state`, so a row that changes what it reads changes nothing the kernel holds. The caller checks live in the facade and know the row from it: `ops.run` refuses an owner actor unless the row grants `owner`, and refuses a plugin actor. A kernel service keeps its internals (the credential store, the op table, the sockets) in module-private state (`src/kernel/hidden.ts`), because Cordis calls service methods through proxies and neither TypeScript `private` nor `#fields` hide anything there.
- **Op handlers.** An op defined by a row that does not grant `conversations` gets a harness that throws on any use, so `api.harness` is not a way around the permission. `ops/before` listeners see each command with its credential args redacted: an op names the field names in `credentials`, and every field with that name is redacted at any depth (`secret.set`'s `value`, `credential.set`'s `key` and `custom`, `mcp.add`'s `headers`, `push.subscribe`'s `keys`, `plugin.configure`'s and `bundle.put`'s `config`). The op itself still receives the real args.
- **Proof.** The `k-reach` probe (`src/kernel/doctor.test.ts`, `test/plugins/reach.ts`) runs from a row with no permissions and tries 40 routes: the service names through `ctx`, `ctx.get`, an alias, `ctx.reflect`, `ctx.inject` and `ctx.root`; the parent, entry and loader contexts; `cordis.original` and `.ctx` on `ops`, `wire`, `pi`, `clock`, on `ctx.get` and `ctx.root` results and on `ctx` itself; the owner actor; socket delivery; `api.harness`; `internal/get` and `internal/listener` listeners; `pi.currentModels().getAuth`, `pi.installed`, `pi.modelSources`, `pi.registry.install` and `clock.timers`; and an `ops/before` listener while the owner sets a secret and puts a bundle with credential headers. It also tries `pi.extensions()` for an extension object, `pi.extensionsNamed` and `pi.env`. A second row, `k-reach-wide`, holds `runtime` and `models` and is still refused the owner actor, `getAuth`, and unsharing or repointing Drive's share. A third, `k-reach-plugins`, holds `plugins`, pushes `secrets` onto the permission arrays it can read, and is still refused `secrets`. `k-reach` is also refused `drive.write` on the user's `AGENTS.md` and `push`, a plugin service no permission covers that it does not require; `k-reach-wide` may write through `drive` but cannot replace its `write`. `k-reach` is refused `pi.registry`, and `k-reach-plugins` finds no function in anything a registry snapshot answers and can write into none of it, hooks and tools included; a real turn after that attack runs its tool unchanged. Every route is refused or finds nothing.
- **Build check.** `scripts/reach.ts` refuses what reads past the access check, in plugin source: an `inject` list or `ctx.get("name")` of a guarded service the `package.json` does not permit; `ctx.get` with a computed name or taken as a value; `ctx` aliased to another name, destructured, or read with a computed key; `cordis.original` or `symbols.original`; `ctx.root`, `ctx.reflect`, `ctx.fiber`, `ctx.registry` and `ctx.loader`; an `import()` of a computed name; and a `cloudflare:workers` import without `runtime`. `scripts/boundaries.ts` (in `lint`) runs it over `plugins/`, and `plugin generate` runs it over every npm code package, so a third-party package that reaches past its declaration fails the build.
- **What the checks promise.** For shipped and built-in rows, every service lookup path is checked at run time, and every service a row holds is a facade. What the runtime does not police is a deliberate walk through Cordis's own bookkeeping, such as `ctx.registry`, `ctx.reflect.store` or listener lists, which hold other fibers' contexts; the build check refuses those spellings in shipped and npm source. The checks do not confine code written to escape them, because plugins share one isolate and there is no sandbox. A market code install therefore runs with owner trust: its permission list describes what its code declares, and the consent prompt says so.
- **Registration check.** When a manifest declares `contributes`, `ops.define` and `pi.install` refuse a name it leaves out, so the row fails at mount with the name in the error. Every shipped plugin declares it.
- **Inventory.** `plugin.doctor` rows carry `registered: { tools, ops }`, read from the live services.
- **Cost.** All of these run in memory: 0 rows and 0 requests per user action. The access check is one fiber walk and one map read per service read, and a facade is built once per service and context.

`bun scripts/ingle.ts plugin generate` parses and validates every manifest and writes it into `src/catalog.gen.ts`. A bad manifest fails the build, not boot. The running Worker never reads `package.json`; the catalog is the single source at run time.

The two fields earn their place:

- `api` is the only hard compatibility axis for in-process code. Semver of the package is for distribution; the API version is the contract.
- `requires` catches the common failure of a plugin that calls a service another plugin provides.

`scopes` joins the manifest with per-scope host mounting (slice 4). The agent surface is scoped today by presets, which need no declaration from the plugin.

### Client plugins

A plugin may ship a web module beside its server row. It declares `client: "./client.tsx"` and the `slots` it fills, and the module default-exports `definePlugin({ name, slots })` from `@ingle/sdk` (`web/src/plugins/sdk.ts`). `plugin generate` writes `web/src/plugins.gen.ts`: one lazy `import()` loader per module, so Vite splits each into its own chunk in `web/dist`. Nothing is loaded from outside the build, and lint runs `plugin generate --check`, so a stale generated file fails the gate. The shell loads every module at start, each on its own: one that throws at import is logged and left out while the rest load. Each slot component, the settings page included, renders inside its own error boundary (`web/src/plugins/isolate.ts`), so one that throws while rendering, throws on a later update or reads a rejected resource shows a line in its place instead of blanking the screen. Plugin themes appear in the owner menu and Appearance beside the built-in ones; a theme with a missing id, label or scheme, or tokens that are not an object, is logged and left out. `host.toast` shows a notice on the shell's toast stack, the same `aria-live` stack as undo toasts, and a notice never pushes an undo toast out: it drops the oldest notice, or itself when three undo toasts show.

| Slot | Where the shell renders it |
| --- | --- |
| `sidebar.section` | a sidebar section below the first-party ones |
| `pane.tab` | a tab in a conversation's right pane |
| `composer.action` | a button in the composer toolbar |
| `message.renderer` | the transcript card for one tool's result |
| `palette.command` | a command palette row |
| `settings.page` | a page under Settings, Plugins |
| `theme` | an Appearance theme: a base scheme and colour tokens, data only |

A registration shows while one of its package's rows is `active` in the home snapshot's `plugins` part, so the existing `plugin.enable` switch governs the server and client halves together, and `plugin.enable` republishes the home snapshot so the shell updates at once. A client module is meant to reach the backend through `host.cmd(op, args)`, the same ops any client uses, and its manifest's `permissions` describe what its server rows may do. Nothing confines the client half: it runs in the shell's own page with the shell's session, so it can call any op the owner can, and its permissions are advisory there. A client module is trusted code, like a market code package. Cost: the modules are static assets and their state rides in the snapshot already sent, so 0 Worker requests and 0 rows per user action; a toggle is the one `plugin.enable` op it always was, plus one home frame to open sockets: the snapshot it publishes stands in for the batch's `changed` frame, since a home snapshot already tells a tab to drop its cached reads.

## Discovery

Three questions, three surfaces:

| Question | Surface | Answers |
| --- | --- | --- |
| What can I install? | `market.search` / `market.entry` | the build's own packages plus any configured index: package, version, `engines.ingle`, code or bundle, install spec |
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
| Plugin API | `ingle.plugins.*.api` | equality with `PLUGIN_API` (1) | row `failed`, doctor explains |
| Package | `version` | semver; the market reads `engines.ingle` | the market hides or marks it |
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

**A preset chooses tools.** It removes only the tool extensions (`tool-*`, the name every tool-bearing extension must carry) of plugins it does not name. Hook, task and section extensions (`xin.guard`, `xin.compact`, `xin.instructions`, `xin.orchestrator` with its reporter and cache hook, `clock-*`, `fast-mode`) stay under every preset, so Minimal keeps the guard, compaction, the project instructions and thread reporting.

**Lean threads.** The `presets` row's `threadOmits` lists plugins a delegated thread leaves out, on top of its inherited preset. The shipped value is `["tool-automations","tool-goals"]`: a thread's first request carries about 5 KB fewer tool declarations, while the coordinator and the root chat keep every tool. It applies only to a thread with no selection of its own, so a thread whose owner ran `preset.select` gets exactly that preset (`full` restores the automation and goal tools). The orchestrator asks `presets.threadRemovals(coordinator)` and removes those extensions in the commit that creates the thread, so even the first request is lean; the next apply finds nothing to change. Presets are read live, so existing threads follow at the next apply. A thread can only be given a preset of its own before its first turn, and a thread starts with its brief, so in practice every thread follows the lean default.

**What a scope changes.** The conversation's tool extensions. Every installed extension is attributed to the plugin row that installed it, and the selected preset keeps the `tool-*` extensions of the plugins it names; `"all"` keeps everything. Every other extension (prompt sections, hooks, wraps and tasks) stays under every preset, so a preset that names `tool-memory` keeps memory's tools, and the time section is present under any preset. A hook that now runs under every preset must stay cheap per turn: `goal-rounds` checks the in-memory armed set and the goals service's in-memory goal cache, so a turn reads no `goal.<id>` row.

Plugin-contributed prompts and skills follow a different rule: they follow their plugin's presence in the preset, not the tool-only rule extensions use. A contributed prompt appears in `prompt.list { conversation }` only while its plugin is in the conversation's preset, and a contributed skill appears in the skills section and the `skill` tool only under the same condition, with the contributing row as the source. They stay plugin-scoped because, like tools, they are things a preset chooses to offer. So a Minimal conversation keeps every hook and section, but the prompt the `hello` plugin contributes (today's only `prompts.contribute`) is listed only under a preset that names `hello`.

**What a scope does not change yet.** Host rows: services, ops, routes, timers and SQL migrations stay at Home. Per-scope mounting would need a child Cordis context and service isolation, and no plugin needs it today. A project-scoped timer is the first use case that would justify it; until then a preset filters the agent surface, not the host surface.

**Presets.** A preset is `{ id, name?, description?, order?, plugins }`, where `plugins` is `"all"` or plugin names. Definitions are read live: editing a preset changes every scope that uses it on the next apply, and `plugins/changed` triggers that apply. `preset.select` only works while the conversation has no turns, as before; `project.update` works at any time and takes effect on the next turn.

**The breaking change.** `tools` is gone. A preset row that still declares `tools` fails validation and its row reports `failed`; the fix is to rename the field to `plugins`. A `tools` list maps one-to-one when its names are `tool-*`, which is what the shipped presets use.

**Lifecycle.** A Home restart rebuilds the scope maps from `WorkspaceDoc` and the `presets` table, so a crash converges. A new thread resolves its project's current preset. Archiving a project does not dispose anything, because nothing is mounted per project yet.

## Trust: a plugin just runs

**Trust tiers.** `core` rows are required and cannot be removed. `build` rows come from packages in `ingle.profile.json`; installing the build is the trust decision. `runtime` rows come from a bundle or an owner patch at run time. Third-party *code* always arrives through a build; a bundle can mount only plugins that are already compiled.

**What is not there.** No per-call approval and no sandbox. A plugin runs in the same isolate as the kernel, so its permissions are checked declarations, not confinement: the boundary is still what you install.

**What a person sees.** A plugin is on or off, with a title, a one-line description and the tools it adds. Turning it on is one action. There is nothing to approve before it works.

**Remote code.** An MCP server is the free plan's isolation story for code that runs elsewhere: the code executes in its author's host, and Ingle holds only a connection. A bundle mounts live but references compiled plugins.

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
3. Add the package to the build and deploy: `bun scripts/ingle.ts plugin new <name>` does all three for a plugin written in this checkout, and `bun scripts/ingle.ts plugin add <spec> --enable` does it for a published one.

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
- No approvals or sandbox until a concrete use case demands one.

**What we deliberately do not expose:** profiles (one Home), layer precedence, isolate realms, version exemptions, HMR toggles, platform gates, permission grants.

## Dropped for simplicity

Designed, then cut because each added a concept or a click without buying a real outcome:

| Dropped | Why |
| --- | --- |
| **Per-call approvals** (dsh `user-approval`, `tools/pre-execute`) | every prompt interrupts a run; a plugin that needs a decision can ask a question, and the owner's own agent does not need a permission slip |
| **Version exemptions** (dsh `compatibility.json`) | an `api` mismatch is a code problem; granting an exception would only produce a crash later |
| **Platform declarations** | one client, one host; nothing to declare |
| **A sandbox / Worker Loader** | no concrete use case today; MCP covers code that runs elsewhere, and the build covers code that runs here |
| **A `provides` registry** | `inject` already resolves services and fails a row that cannot get one |
| **A config wizard at install** | `Config` defaults make a plugin work with no setup; settings remain optional |

The `net` permission check named in M8 belonged to the pre-P5 host adapter, which no longer exists; `network` is declared and shown but not enforced.

## Rows, bundles and layers (engine)

A row is a loader `EntryOptions`: `{ id, name: "cordis:<plugin>", config?, disabled?, group?, isolate? }`. A bundle is an ordered list of rows. Layers apply to an empty list:

1. The bundles named in `ingle.profile.json`, in order, then the runtime bundles ([12 Market](./12-market.md)).
2. That file's `patch`. It is build time and checked in.
3. The owner patch. It is run time, stored in `kv` key `plugins.patch`, and recomputed as the minimal departure from the lower layers.

The last write wins per row. A patch replaces each named field whole, config included, with no deep merge. An unknown id is reported and skipped.

`IngleLoader.commit` stores the owner patch so it records only what the owner changed. Adding a row is a local bundle, as dsh adds rows through a bundle.

**Failure.** A failed `required` row puts Home in `boot_failed`; any other failed row is reported with its error and the rest keep running; a row whose plugin left the build is `missing` and is not mounted.

**Kernel services (seams).** Each service is a row in `ingle-base`; a different row can provide the same key.

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

**MCP surface.** `tool-mcp` installs one deferred tool per MCP tool. When a server declares the `resources` capability it also installs `mcp_resources` (list resources and templates) and `mcp_resource` (read one URI); when it declares `prompts` it installs `mcp_prompts` (list) and `mcp_prompt` (render with arguments). The text of an MCP tool result is capped at 8,000 characters in what the model sees, followed by one note giving the cut and total lengths (images pass through); when it is cut, the full content is kept in the result's `details`. All four are read-only, carry the server name in their tool name, and sit behind `tool_search`. `tool_search` itself is offered only while the row has at least one deferred tool to find: with no server connected it could answer nothing but "no match", so it is not in the prompt at all, and it appears on the first `mcp/changed` that adds a tool. `mcp.list` reports the cached tool count and, when the capability is present, the resource, template and prompt counts; `mcp.resources { name }` and `mcp.prompts { name }` read the live lists. Disabling `tool-mcp` hides all of them together, and a preset that hides the row does the same. There is no sampling, elicitation or GET stream.

**`mcp-server` ships unmounted.** The plugin is in the catalog — `ingle-plugin-mcp`, module `server.ts`, config `{ name, url, headers? }` — but `ingle-plugin-mcp`'s bundle lists only `mcp` and `tool-mcp`, so no row of `mcp-server` is in the composed tree and `plugin.list` never shows one. The shipped profile therefore configures no MCP server: `tool-mcp` is mounted and has nothing to expose, and `mcp.list` answers empty. Mounting a server takes a row, in one of two ways: add `{ "id": "mcp-server", "plugin": "mcp-server", "config": { "name": "…", "url": "…" } }` to `plugins/mcp/package.json`'s `ingle.bundle` and regenerate the catalog (`bun scripts/ingle.ts plugin generate`), which is a build and a deploy; or install a runtime bundle with `bundle.put { package, rows: [...] }`, which mounts live with no deploy (12).

## Plugin manager

| Op | Effect |
| --- | --- |
| `plugin.list` | rows with id, plugin, title, state, layer, config and manifest |
| `plugin.catalog` | compiled plugins with title, description, source, version, manifest, permission titles, config schema and `form` (settings fields derived from `Config`) |
| `plugin.doctor` | `{ ok, rows }` with package, version, state, manifest, `registered` and issues |
| `plugin.tree` | `{ bundles, runtime, layers, lower, owner, rows, warnings }` |
| `plugin.enable` | `{ id, enabled }`; rejected for a required row |
| `plugin.configure` | `{ id, config }`, validated against `Config`; rejected for a plugin without one |

Every mutating result carries `application: "applied" | "failed"` and the row's new state. A row whose new config or code fails to start is an outcome, not an error.

The agent tool `plugin_manager` is its own row, `tool-plugins` (not required, off by default). It reads `list`, `catalog`, `tree` and `doctor`, and can `enable` and `configure` a row like the owner can.

## Authoring a plugin

The starter is `plugins/hello`: one tool and one prompt, and the package `bun scripts/ingle.ts plugin new <name>` copies under a new name, regenerates the catalog and adds to the build. `docs/plugin-authoring.md` is the one-page path from nothing to a deployed plugin, and `test/authoring.test.ts` proves it end to end — scaffold, mount, tool call, `prompt.list` — so the template, the scaffold and the mount cannot drift apart.

A plugin is one module:

```ts
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "hello"
export const inject = ["pi", "ops"]
export const Config = Schema.object({ greeting: Schema.string().default("hi") })

export function apply(ctx: Context, config: { greeting: string }) {
  ctx.pi.install(
    defineExtension({
      name: `tool-${name}`,
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
{ "ingle": { "plugins": { "hello": { "module": "./index.ts", "title": "Hello" } } } }
```

An extension that carries tools is named `tool-*`; the registry refuses one that is not, because a preset tells a tool row from a service row by that prefix.

## Model-written code: the `visual` plugin

`plugins/visual` ports zeron's `show_visual`. The model writes a Lua 5.3 script (fengari, pure JS), the DO checks it with the same runtime the browser runs, and the web app draws it in a sandboxed `srcdoc` iframe (no `allow-same-origin`, CSP with no network). It ships disabled. The script is hostile by assumption, so the runtime bounds every resource for each call (setup, render, handler, draw), in both the DO check and the frame:

| Resource | Bound | Where |
| --- | --- | --- |
| Instructions | 5M per call, 1.5M per draw, counted by a hook every 1000 | `runtime/lua.ts` |
| Escaping the budget | the failure is sticky: the hook raises it again until the call returns, `pcall`/`xpcall` re-raise it, and an `xpcall` message handler is skipped once it is set | `runtime/lua.ts` |
| One allocation | 1 MB (strings and string buffers) | `runtime/limits.ts`, called by fengari through `patches/fengari@0.1.5.patch` |
| Bytes and table entries | 32 MB and 100k per call in the frame; 48 MB and 300k for the whole DO check, since its calls share one state | same |
| Shader loops | 1024 condition checks per pixel across all loops, injected into every `for`/`while` after comments are blanked; `#define` bodies with a loop, `##` and line continuations are refused | `runtime/shader-check.ts` |
| Frame height | 0 to 10,000 px | `web/src/components/chat/visual-block.tsx` |

fengari has no allocator hook, so a four-line `bun patch` adds one: before it allocates a string buffer (`luaL_prepbuffsize`, `luaV_concat`), makes a string (`TString`) or adds a table entry, it calls the meter stored on the state's `l_G`. The meter lives on the state rather than on a module object because test pools and bundlers do not always share fengari's module instances. In the frame the bounds are per call, so state that grows a little on every frame of an animation is limited only by how long the visual stays open, and since a `srcdoc` frame shares the page's renderer process, the page is the blast radius. Moving the frame to its own origin would put it in its own process. The DO check counts all its calls together, so it stays inside the isolate's memory. No I/O library is opened, but fengari's `lualib` still bundles `liolib`, `loslib` and `loadlib`, which costs the Worker about 122 KB gzipped.

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
