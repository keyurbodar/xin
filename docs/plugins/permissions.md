# Permissions

A plugin declares the guarded services it uses in its manifest's `permissions`. The owner sees each one's title before installing from a market, and the kernel holds the plugin to what it declared.

| Permission | Guards | Shown to the owner as |
| --- | --- | --- |
| `secrets` | `secrets` | Read your stored credentials |
| `files` | `files` | Read and change your files |
| `storage` | `db` | Keep its own tables in your Home |
| `routes` | `http` | Answer HTTP requests to your Home |
| `models` | `models` | Call models, which spends tokens |
| `conversations` | `harness` | Read and write your conversations |
| `plugins` | `kernel`, `packages`, `plugins` | Install, enable and configure plugins |
| `network` | nothing it can enforce | Connect to the internet |
| `owner` | none: `ops.run` with you as the actor; only first-party Automations may declare it | Act as you: run any op you can, such as starting threads |
| `runtime` | `host` | Full access to your Home: raw storage, keys and the file bucket |

`runtime` reaches the raw SQLite, the encryption key and the R2 bucket, so it implies all the others but `owner`, and the checks below treat it that way. `owner` is never implied: only the first-party Automations package may declare it, the build refuses it from any other package, and a market refuses to install one that asks for it. Avoid `runtime` if a narrower service does the job: Drive, for one, reads and shares blobs through the `files` service and holds no `runtime`. The kernel services outside this table, such as `pi`, `ops`, `clock` and `wire`, need no permission.

## Services other plugins provide

A service another plugin provides is refused by default. A row in the same package reads it freely, and `runtime` covers all of them. Otherwise:

| Service | Needs |
| --- | --- |
| `drive` | `files` |
| `intake`, `threads`, `watchdog`, `questions`, `memory` | `conversations` |
| any other, such as `prompts`, `jobs`, `push` or `skills` | `requires` naming the providing plugin, such as `"requires": ["presets"]` for `prompts` |

A row that reads one without that fails at the read with a message naming what is missing. What your row holds is a frozen object of the service's methods alone, with no data members and no prototype, so it can't read the service's state or replace a method other rows call.

## Where it is checked

1. **At mount.** If `inject` lists a guarded service the manifest doesn't permit, the row fails. `plugin.doctor` then reports `{ kind: "permission", permission, service }`.
2. **At access.** A guarded service resolves only for a row that declares its permission, so every Cordis route to it is checked: `ctx.<name>`, a nested `ctx.inject([...])`, a child `ctx.plugin(...)`, `ctx.get` and `ctx.reflect.get` (aliased or not), `ctx.root`, and any context that belongs to no row, such as the one `ctx.fiber.parent` leads to, which gets none. Every service your row reads comes back as a facade with no `ctx` and no `cordis.original`, so it leads nowhere else. A facade is an allowlist: it has only the methods shipped plugins use, such as `ops.define` and `run`, `wire.home`, `pi.install` and `clock.arm`, and every other member is absent. Values that would carry credentials come back as views: `pi.currentModels()` needs `models` and answers only `getModel` and `getAvailable`, and `pi.registry` answers only `snapshot`. A row may not listen to `internal/*` events. `ops.run` lets a row act for an agent, and as the owner only with `owner`. An op your row defines gets a usable `api.harness` only with `conversations`. `ops/before` listeners see credential args (a secret's value, an API key, MCP headers, a bundle row's config) redacted at any depth.
3. **At build.** `scripts/reach.ts` refuses the routes the runtime can't see: an undeclared `ctx.get("name")` or inject list, `ctx.get` with a computed name or taken as a value, `ctx` aliased, destructured or read with a computed key, `cordis.original`, `ctx.root`, `ctx.reflect`, `ctx.fiber`, `ctx.registry` and `ctx.loader`, an `import()` of a computed name, and a `cloudflare:workers` import without `runtime`. Lint runs it over `plugins/`, client modules included, and `plugin generate` runs it over every npm code package, so a package that reaches past its declaration fails the build.

`contributes` is checked the same way: a tool or op the row registers but the manifest leaves out fails the row.

## What it is not

Plugins run in your Home's own isolate, and there is no sandbox. For the plugins this build ships, the checks hold against accidental reach: every service lookup path is checked, and the rest is refused at build. They can't contain code written to escape them, such as code that walks Cordis's own registry or imports kernel modules directly. So a code plugin you install from a market runs with your authority: its permission list describes what its code declares, not a boundary it can't cross. Installing one is a decision to trust its author. Code you don't trust belongs in an MCP server, which runs somewhere else.

## Consent at install

When you install, update or roll back from a market, or add a package by its spec, the market works out which permissions the version needs, from the version's verified tarball. If any are new, it rejects with `consent_required` and lists each permission's title and the reason it's needed. Extensions then shows the prompt and retries with your grant. An update asks only for what the installed version didn't already have. Auto-update never grants anything: it leaves a version that asks for more for you to approve. See [publishing.md](publishing.md) for how the market reads a package's permissions.
