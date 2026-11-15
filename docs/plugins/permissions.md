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
2. **At access.** Any other route to a guarded service from inside the row is refused: a nested `ctx.inject([...])` or a child `ctx.plugin(...)`. `secrets.get` checks its caller. `ops.run` lets a row act only for an agent, never as the owner.
3. **In lint.** `scripts/boundaries.ts` refuses the reads the runtime can't see. These are an undeclared `ctx.get("name")` or inject list, a `ctx.get` with a computed name, and a `cloudflare:workers` import without `runtime`.

`contributes` is checked the same way: a tool or op the row registers but the manifest leaves out fails the row.

## What it is not

Plugins run in your Home's own isolate, and there is no sandbox. The checks keep honest code to its declaration and surface mistakes early. They can't contain code written to escape them, such as code that imports kernel modules directly. Installing a code plugin is still a decision to trust its author. Code you don't trust belongs in an MCP server, which runs somewhere else.

## Consent at install

When you install, update or roll back from a market, the market works out which permissions the version needs. If any are new, it rejects with `consent_required` and lists each permission's title and the reason it's needed. Extensions then shows the prompt and retries with your grant. An update asks only for what the installed version didn't already have. Auto-update never grants anything: it leaves a version that asks for more for you to approve. See [publishing.md](publishing.md) for how the market reads a package's permissions.
