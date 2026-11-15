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
| `runtime` | `host` | Full access to your Home: raw storage, keys and the file bucket |

`runtime` reaches the raw SQLite, the encryption key and the R2 bucket, so it implies all the others. Avoid it if a narrower service does the job. Services outside this table, such as `pi`, `ops`, `prompts`, `clock` and `wire`, need no permission.

## Where it is checked

1. **At mount.** If `inject` lists a guarded service the manifest doesn't permit, the row fails. `plugin.doctor` then reports `{ kind: "permission", permission, service }`.
2. **At access.** Every Cordis route to a guarded service from inside the row is checked against the row: `ctx.<name>`, a nested `ctx.inject([...])`, a child `ctx.plugin(...)`, `ctx.get` and `ctx.reflect.get` (aliased or not), and `ctx.root`, which in a plugin row stands for the root seen from that row. `secrets.get` and `secrets.set` check their caller. `ops.run` lets a row act only for an agent, never as the owner. Kernel services keep their internals out of reach.
3. **At build.** `scripts/reach.ts` refuses the routes the runtime can't see: an undeclared `ctx.get("name")` or inject list, `ctx.get` with a computed name or taken as a value, `ctx.root`, `ctx.reflect`, `ctx.fiber`, `ctx.registry` and `ctx.loader`, an `import()` of a computed name, and a `cloudflare:workers` import without `runtime`. Lint runs it over `plugins/`, and `plugin generate` runs it over every npm code package, so a package that reaches past its declaration fails the build.

`contributes` is checked the same way: a tool or op the row registers but the manifest leaves out fails the row.

## What it is not

Plugins run in your Home's own isolate, and there is no sandbox. For the plugins this build ships, the checks hold against accidental reach: every service lookup path is checked, and the rest is refused at build. They can't contain code written to escape them, such as code that imports kernel modules directly. So a code plugin you install from a market runs with your authority: its permission list describes what its code declares, not a boundary it can't cross. Installing one is a decision to trust its author. Code you don't trust belongs in an MCP server, which runs somewhere else.

## Consent at install

When you install, update or roll back from a market, or add a package by its spec, the market works out which permissions the version needs, from the version's verified tarball. If any are new, it rejects with `consent_required` and lists each permission's title and the reason it's needed. Extensions then shows the prompt and retries with your grant. An update asks only for what the installed version didn't already have. Auto-update never grants anything: it leaves a version that asks for more for you to approve. See [publishing.md](publishing.md) for how the market reads a package's permissions.
