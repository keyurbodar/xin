# 12 · Market, runtime bundles and updates (free plan)

This section decides how an owner finds, installs and updates other people's plugins while Xin runs on the Cloudflare free plan, which has no Worker Loader. Every mechanism here mirrors a dsh package, named in each heading. Xin builds nothing dsh lacks (owner rule 2026-11-07); the free plan only changes where code comes from.

> **Code needs a build. Rows don't.**

dsh separates a plugin's code from its *bundle*, the ordered list of rows that mount that code. Xin keeps that split and turns it into two install paths.

| Package kind | How Xin tells | Install and update | Time |
| --- | --- | --- | --- |
| **bundle** | its `package.json` `xin` field declares `bundle` and no `plugins` | fetched by the Worker, verified, stored, mounted live | seconds, no deploy |
| **code** | its `xin` field declares `plugins` | recorded as pending, applied by the build pipeline (§15 Installing from the client) | one build and deploy |

A bundle row may name any compiled plugin, so a bundle can carry MCP servers, presets and configuration for code that is already built. A bundle can also `require` code packages. Those go to the pending build list, and their rows report `missing` until the build lands, then mount on their own.

Remote code still needs no deploy when it runs somewhere else. An MCP server is code in its author's own Worker or host, and an `mcp-server` row connects to it. That is the free plan's isolation story for third-party code.

Read with: [09 Plugins](./09-plugins.md) for rows, layers, the plugin manager and the build pipeline.

## Layers (dsh `app-boot`)

The composed tree is built as in dsh: a profile is a list of bundles plus a patch, and an installed bundle joins the end of the bundle list.

1. The bundles: the compiled ones named in `xin.profile.json`, then the **runtime bundles** in install order (the `kv` key `plugins.bundles`).
2. That file's `patch`.
3. The owner patch (`plugins.patch`), computed as the minimal departure from layers 1 and 2.

The last write wins per row. An owner's edit to a runtime bundle's row (config, disabled) lives in the owner patch, so it survives an update of that bundle. Because a patch replaces a field whole, an override of `config` keeps replacing the new version's config. Writing the inherited value back drops the override (dsh `config-editor`).

## Runtime bundles (`packages` row, dsh `plugin-manager`)

```ts
type BundleSource =
  | { readonly kind: "registry"; readonly version: string; readonly integrity: string }
  | { readonly kind: "local" }

type BundleRow = { readonly id: string; readonly plugin: string; readonly config?: JsonValue; readonly disabled?: boolean }
type BundlePatch = { readonly id: string; readonly config?: JsonValue; readonly disabled?: boolean }

type RuntimeBundle = {
  readonly package: string            // npm name, or a local name matching the npm name grammar
  readonly source: BundleSource
  readonly rows: readonly BundleRow[]
  readonly patch: readonly BundlePatch[]
  readonly requires: readonly string[] // code package specs
}
```

- **Row ids** are the bundle's own ids, as in dsh. A bundle whose row id is already in the composed tree is rejected.
- **Validation**, done before anything is stored. Each violation rejects the whole bundle with `bad_args`.
  - Every row's plugin is in the catalog, or the bundle `requires` at least one code package (then an unknown plugin is allowed and shows `missing`).
  - No row names a `required` plugin, and no patch entry targets a `required` row.
  - Row ids are unique and match `[A-Za-z0-9][A-Za-z0-9._-]*`.
  - Each row's `config`, and each patched row's resulting config, passes that plugin's `Config` schema.
  - At most 64 rows, and the stored bundle is at most 512 KiB of JSON (Durable Object value limit).
- **Patch entries** target any row by id and replace the named fields, as a profile patch does. An unknown target is reported in `bundle.list` and kept until the row exists.
- **Apply.** `put` stores the bundle and recomposes the live tree through the loader. A fresh install keeps its rows even when one fails to start; the failed rows report `failed` with their error, as in dsh, where activation failure after installation keeps the selection. Replacing an installed bundle (an update) restores the replaced bundle when any of the new version's rows ends `failed`, and returns `{ application: "failed", rows }` (dsh `updateBundle` restore). Otherwise `{ application: "applied" }`.
- **Requires.** Each `requires` spec is recorded with `plugin.install` semantics.
- **Crash safety.** `plugins.bundles` is the source of truth and the tree is rebuilt from it at boot, so a crash between the write and the recompose converges on the next boot. An update that crashed before its restore stays on the new version, with its rows reported `failed`.

| Op | Effect |
| --- | --- |
| `bundle.list` | each runtime bundle with package, source, requires, unknown patch targets, and each row's id and state |
| `bundle.put` | `{ package, rows, patch?, requires? }` installs or replaces a **local** bundle. The market installs registry bundles through the service |
| `bundle.remove` | `{ package }` unmounts and deletes it. Does not uninstall its `requires` |

The service (`ctx.packages`) has `bundles()`, `put(bundle)` and `remove(package)`. `plugin.packages` also lists runtime bundles.

A package name is installed either as a runtime bundle or as compiled code. Installing a bundle whose name the build already provides is refused.

## Contribution rows

| Plugin | Package | Config | Mirrors |
| --- | --- | --- | --- |
| `mcp-server` | `xin-plugin-mcp` | `{ name, url, headers?: { [name]: string } }` | dsh `mcp-client`. `url` and header values may contain `${credential:REF}`, resolved from `ctx.secrets` at connect time; a missing credential leaves the row active and logging `waiting-credentials`, and it connects when `secret.set` writes the value |
| `preset` | `xin-plugin-presets` | `{ id, name?, description?, order?, plugins }` | dsh `agent-preset` (§9 Presets) |

Any plugin may have several rows. A second row of a plugin that registers fixed names fails to start and reports `failed`, as a duplicate does in dsh.

## Market (`market` row, `xin-plugin-market`, dsh `plugin-market`)

The market is a feature plugin, not kernel. It reads market indexes and the npm registry over `fetch`, and installs through `ctx.packages`.

**The default index is the build.** With `indexes: []`, the default, `market.search` still lists every feature package this build compiles, grouped from `plugin.catalog`, with status `provided` and category `first-party`. It needs no setup and sends no request. `market.entry` for a provided package reads the package's rows from the composed tree instead of the npm registry, so a package's presets and row config are visible offline. Configured indexes are appended after it, and a name in both keeps the build's entry. Installing or updating a provided package is refused, because the build already has it.

**Config.**

```json
{ "registry": "https://registry.npmjs.org", "indexes": [], "cacheTtlMs": 600000 }
```

`indexes` holds at most 8 https URLs; it is the *additional* set. A successfully read index is cached for `cacheTtlMs` in the market's own table, and `market.refresh` bypasses the cache (dsh `plugin-market`). There is no background timer.

**Indexes** are dsh market index format 1 (`packages/util/plugin-market-index`), parsed by a port of dsh's `parseMarketIndex`, rule for rule:

```ts
type MarketIndex = {
  format: 1
  title: LocalizedText                     // string or { [locale]: string }
  description?: LocalizedText
  metadata: { categories: ...; labels: ...; sortKeys: ... }
  plugins: Array<{
    name: string                           // npm package name, unique in the index
    title?: LocalizedText; description?: LocalizedText
    icon?: string; author?: string; homepage?: string
    repository?: { url: string; directory?: string }
    metadata: { category?: string; keywords: string[]; labels: ...; sortKeys: ... }
    versions: Array<{                      // non-empty, sorted newest first
      version: string                      // exact semver
      publishTimestamp: number             // unix seconds
      source: { type: "npm"; registry?: string } | { type: "git"; url: string; commit: string; path?: string }
      engines: { xin?: string }            // dsh reads engines.dsh
    }>
  }>
}
```

An invalid index is reported with dsh's error path (`$.plugins[3].versions`) and skipped; the other indexes still serve. The same package in two indexes takes the first index's entry.

**Compatibility.** A version is compatible when its `engines.xin` is absent or satisfied by the running Xin version (`ctx.packages.version`). The version offered is the newest compatible one, else the newest.

**Status**, as dsh's market shows it:

| Status | Meaning |
| --- | --- |
| `not-installed` | not installed |
| `installed` | installed at the offered version |
| `update-available` | the offered version is greater than the installed one |
| `different-version` | the installed version is unknown, not valid semver, or greater than the offered one |
| `provided` | compiled into this build; never installed or updated from the market |

**Ops.**

| Op | Effect |
| --- | --- |
| `market.search` | `{ query?, category? }` entries from the build index and every configured index, with status, title, description and category |
| `market.entry` | `{ name }` the entry's versions with compatibility, kind and readme of the offered version, the rows a bundle would add, `requires`, and status |
| `market.install` | `{ name, version? }` newest compatible version by default. Refused when the package is already installed or `provided` |
| `market.update` | `{ name, version }` an exact newer version of an installed package; an older version is refused (dsh `updateBundle`) |
| `market.refresh` | refetches every index now, bypassing the cache; while auto-update is on it also installs each installed package's offered patch version (same major and minor) and answers them under `applied` |
| `market.policy` / `market.policy.set` | `{ autoUpdate }`, off by default, in kv `market.policy` |
| `market.skip` / `market.unskip` / `market.skipped` | kv `market.skipped`, one version per package: a skipped version is marked in `market.search` and `market.entry`, and `market.update` to it answers `{ application: "skipped" }` without touching the install |
| `market.rollback` | reinstalls the newest `market_history` version other than the installed one; refuses when there is none, when it is no longer in an index, or when it is incompatible, and never moves forward |

**Installing a version.** An `npm` source reads the version document from `source.registry`, else the configured `registry`, for the `xin` field and `dist`. A `git` source cannot be fetched by the Worker, so it is always recorded as a pending code install `git+<url>#<commit>` (with `&path:/<path>`), as dsh's `marketInstallTarget` builds it. For an npm package:

- A code package is recorded pending as `name@version`. `market.install` and `market.update` do not deploy; the client calls `system.update` after them, so one build can carry several changes.
- A bundle is fetched from `dist.tarball` over https with redirects refused, at most 8 MiB compressed. The bytes must match `dist.integrity` (`sha512-<base64>`, checked with `crypto.subtle`). The tarball is gunzipped with `DecompressionStream` and read as ustar, at most 4 MiB unpacked, and only `package/package.json` is read. The rows, patch and `requires` that get mounted come from that verified file, not from the version document; a tarball whose kind differs from the document is refused. The result is validated by the `packages` row like any bundle.

Every applied install writes a `market_history { package, version, at }` row, which is what `market.rollback` walks backwards. Every op spends at most 40 requests, inside the free plan's 50 subrequests. Each fetch has a 10 s deadline that is cleared when the request settles.

## Trust on the free plan

- Bundle rows are data. They run only code that is already compiled into the build, and their config is checked against that code's schema.
- A bundle's rows can still steer the model (an MCP server's tools, a preset), so the client shows a bundle's rows before install.
- Code packages are trusted by installing them, as in §15. Third-party code that should not run in the Home isolate should be an MCP server.
- dsh has no capability manifest or plugin sandbox, so Xin has none either. Approval for risky tool calls follows dsh: a `tools/pre-execute` gate and a swappable `user-approval` service (P10).
