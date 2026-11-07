# 12 · Market, runtime bundles and updates (free plan)

This section decides how an owner finds, installs and updates other people's plugins while Xin runs on the Cloudflare free plan, which has no Worker Loader. The rule that shapes everything:

> **Code needs a build. Rows don't.**

dsh already separates a plugin's code from its *bundle*, the ordered list of rows that mount that code. Xin keeps that split and turns it into two install paths.

| Package kind | How Xin tells | Install and update | Time |
| --- | --- | --- | --- |
| **bundle** | its `package.json` `xin` field declares `bundle` and no `plugins` | fetched by the Worker, verified, stored, mounted live as a runtime layer | seconds, no deploy |
| **code** | its `xin` field declares `plugins` | recorded as pending, applied by the build pipeline (§15 Installing from the client) | one build and deploy |

A bundle row may name any compiled plugin, so a bundle can carry skills, prompt sections, MCP servers, presets and configuration for code that is already built. A bundle can also `require` code packages. Those go to the pending build list, and their rows report `missing` until the build lands, then mount on their own.

Remote code still needs no deploy when it runs somewhere else. An MCP server is code in its author's own Worker or host, and an `mcp-server` row connects to it. That is the free plan's isolation story for third-party code.

Read with: [09 Plugins](./09-plugins.md) for rows, layers, the plugin manager and the build pipeline.

## Layers

The composed tree is built from four layers, in order. The last write wins per row, as in §15.

1. Compiled bundles named in `xin.profile.json`.
2. That file's `patch`.
3. **Runtime bundles**, in install order. Stored in the `kv` key `plugins.bundles`.
4. The owner patch (`plugins.patch`), computed as the minimal departure from layers 1 to 3.

An owner's edit to a runtime bundle's row (config, disabled) lives in the owner patch, so it survives an update of that bundle. Because a patch replaces a field whole, an override of `config` keeps replacing the new version's config; `plugin.reset` drops it.

## Runtime bundles (`packages` row)

```ts
type BundleSource =
  | { readonly kind: "registry"; readonly version: string; readonly integrity: string }
  | { readonly kind: "local" }

type BundleRow = { readonly id: string; readonly plugin: string; readonly config?: JsonValue; readonly disabled?: boolean }

type RuntimeBundle = {
  readonly package: string            // npm name, or a local name matching the npm name grammar
  readonly source: BundleSource
  readonly rows: readonly BundleRow[]
  readonly requires: readonly string[] // code package specs
}
```

- **Row ids.** A bundle row `x` of package `p` mounts with the loader id `p#x`. A runtime row can therefore never collide with a compiled row or another bundle's row.
- **Validation**, done before anything is stored. Each violation rejects the whole bundle with `bad_args`.
  - Every row's plugin is in the catalog, or the bundle `requires` at least one code package (then an unknown plugin is allowed and shows `missing`).
  - No row names a `required` plugin.
  - A plugin without `multiple: true` appears at most once in the whole composed tree.
  - Row ids are unique in the bundle and match `[A-Za-z0-9][A-Za-z0-9._-]*`.
  - Each row's `config` passes that plugin's `Config` schema, as in `plugin.insert`.
  - At most 64 rows, and the stored bundle is at most 512 KiB of JSON.
- **Apply.** `put` stores the bundle (replacing a stored version of the same package and keeping the replaced one as `previous`), recomposes the live tree (create, update and remove rows through the loader), and waits for the loader. If any row of this bundle ends `failed`, it restores `previous` (or removes the bundle if there was none), recomposes again, and returns `{ application: "failed", rows }` with each failed row's error. Otherwise `{ application: "applied" }`.
- **Requires.** Each `requires` spec is recorded with `plugin.install` semantics. The pending list settles on a later build as before.
- **Crash safety.** `plugins.bundles` is the source of truth and the tree is rebuilt from it at boot, so a crash between the write and the recompose converges on the next boot. A failed apply that crashed before rolling back stays installed and reports its rows `failed`; the owner rolls back by hand.

| Op | Effect |
| --- | --- |
| `bundle.list` | each runtime bundle with package, source, requires, `previous` version if any, and each row's id and state |
| `bundle.put` | `{ package, rows, requires? }` installs or replaces a **local** bundle. Used by the owner and the client to save a setup, and by the market for registry bundles through the service |
| `bundle.remove` | `{ package }` unmounts and deletes it. Does not uninstall its `requires` |
| `bundle.rollback` | `{ package }` swaps the stored bundle with `previous` and recomposes. Rejected when there is no `previous` |

The service (`ctx.packages`) gains `bundles()`, `put(bundle)`, `remove(package)` and `rollback(package)`. `plugin.packages` also lists runtime bundles.

## Contribution rows

Small compiled plugins that exist so a bundle has something to configure. Each sets `multiple: true`, lives in the package that owns the service it contributes to, and contributes through an effect, so disabling or removing the row takes its contribution away. None is mounted by default; the owner inserts them with `plugin.insert`, or a bundle carries them.

| Plugin | Package | Config | Effect |
| --- | --- | --- | --- |
| `prompt` | `xin-plugin-prompts` | `{ title?, text }`, text at most 16 KiB | installs the extension `prompt-<row id>` with one prompt section |
| `skill` | `xin-plugin-skills` | `{ markdown }` in the skill file format, at most 64 KiB | adds the skill to `skills.list()` with `source: <row id>`. A stored skill of the same name wins, and the row reports the clash in its status |
| `mcp-server` | `xin-plugin-mcp` | `{ name, url, headers?: string[] }` | connects the server like `mcp.add`, but held by the row, not stored in the mcp table. Each header named in `headers` takes its value from the row secret of that name (`plugin.secret.set`) |
| `preset` | `xin-plugin-presets` | `{ id?, title, description, tools }` | adds a preset (`id` defaults to the row id). A preset of the same id in the `presets` row config wins |

## Market (`market` row, `xin-plugin-market`)

The market is a feature plugin, not kernel. It talks to npm and to index files over `fetch`, and installs through `ctx.packages`.

**Config.**

```json
{ "registry": "https://registry.npmjs.org", "indexes": [], "search": true, "checkHours": 24 }
```

**Discovery** merges two sources.

1. **Indexes.** Each URL in `indexes` serves static JSON in dsh's market index shape, `format: 1`: `{ format, packages: [{ name, title?, description?, icon?, author?, repository?, metadata?: { categories?, labels? } }] }`. Xin reads only these fields and ignores the rest. An entry's versions always come from the registry.
2. **npm search.** With `search: true`, the registry's search endpoint for the keyword `xin-plugin` (`/-/v1/search?text=keywords:xin-plugin`). A plugin author publishes with that keyword and is discoverable with no index at all.

An index entry wins over a search hit of the same name.

**Package facts** come from the registry: the abbreviated document (`Accept: application/vnd.npm.install-v1+json`) for `dist-tags`, `versions`, `deprecated` and `engines`, and the full version document (`/<name>/<version>`) for the `xin` field, `readme` and `dist`. A version is **compatible** when its `engines.xin` is absent or satisfied by the running Xin version (the root `package.json` version, compiled in as `XIN_VERSION` and read as `ctx.packages.version`). The version offered is the `latest` dist-tag when it is compatible and not deprecated, otherwise the newest compatible stable version, otherwise the newest compatible prerelease.

**One install path per package.** A package name is installed either as a runtime bundle or as compiled code, never both. Installing a bundle cancels a pending code add or remove of that name; recording a code install removes a runtime bundle of that name after the build lands. At boot, a runtime bundle whose package is now compiled into the build is not mounted and reports `superseded`; the rule that a non-`multiple` plugin appears once is checked over the whole composed tree at every boot, and offending runtime rows report `failed`.

**Status** of an entry, computed against the build and the runtime bundles:

| Status | Meaning |
| --- | --- |
| `available` | not installed |
| `installed` | installed at the newest compatible version |
| `update` | installed, and a newer compatible version exists |
| `pending` | a code install or update is waiting for a build |
| `local` | provided by this repository (`local: true`); never updated from the market |
| `incompatible` | no version satisfies `engines.xin`, or the package declares no `xin` field (`kind: null`) |

**Ops.**

| Op | Effect |
| --- | --- |
| `market.search` | `{ query?, category? }` merged entries with status, title, description, kind (`bundle` or `code`, from the newest version) |
| `market.entry` | `{ name }` versions (newest first, with compatibility and publish time), readme, kind, `requires`, the rows a bundle would add, and status. It describes the offered version only and never fails because another version is malformed. A row config value `{ "$file": "path" }` is returned as is; the client shows it as a file reference |
| `market.install` | `{ name, version? }` newest compatible version by default. A bundle is fetched, verified and `put`; a code package is recorded pending as `name@version` |
| `market.update` | `{ name, version? }` the same as install, for an installed package. The previous version stays available through `bundle.rollback` (bundles) or `market.install` with the old version (code) |
| `market.refresh` | runs the update check now |
| `market.updates` | installed packages with a newer compatible version, from the last check |

`market.install` and `market.update` on a code package do not deploy. The client calls `system.update` after it, so one build can carry several changes.

**Fetching a bundle.** The tarball URL comes from `dist.tarball` and must be on the configured registry's host, over https, with redirects refused. The download stops at 8 MiB compressed. The bytes must match `dist.integrity` (`sha512-<base64>`, checked with `crypto.subtle`). The tarball is gunzipped with `DecompressionStream` and read as ustar, at most 4 MiB unpacked, and only `package/package.json` and files a row references are read. A row's config may reference a file in the package as `{ "$file": "skills/research.md" }`; the market replaces it with the file's text (at most 64 KiB each) before `put`. The rows and `requires` that get mounted come from the verified tarball's `package/package.json`, not from the version document; a tarball whose kind differs from the document is refused. The result is validated by the `packages` row like any bundle.

**Update check.** A clock timer fires every `checkHours` (and `market.refresh` runs it now). It fetches the abbreviated document of every installed non-local package (code packages from the catalog's `source`, bundles from `plugins.bundles`), stores the newest compatible version per package in the market's own table, and publishes the home part `market: { updates, checkedAt }`. A failed fetch keeps the last known answer for that package. Each fetch has a 10 s deadline that is cleared when the request settles. The check makes at most 40 requests per run, taking the least recently checked packages first, so it stays inside the free plan's 50 subrequests. The first check is due `checkHours` after the market row first starts, not at boot, and every attempt records its time, so a failing check never re-arms at once. Every op shares the same ceiling: `market.search` fetches indexes and the npm search concurrently and spends at most 40 requests in total, and `indexes` holds at most 8 URLs, all https.

**The update flow**, for a bundle Lahn published as 1.1:

```mermaid
sequenceDiagram
  participant C as client
  participant M as market row
  participant N as npm registry
  participant P as packages row
  M->>N: daily check (abbreviated doc)
  N-->>M: 1.1.0 latest, engines ok
  M-->>C: home part market.updates = 1
  C->>M: market.update {name}
  M->>N: version doc + tarball
  M->>M: verify sha512, unpack, inline $file
  M->>P: put(bundle 1.1.0)
  P->>P: recompose, wait; rollback to 1.0 on failure
  P-->>C: application applied
```

For a code package the same click records `name@1.1.0` pending, and the next `system.update` builds and deploys it.

## Trust on the free plan

- Bundle rows are data. They run only code that is already compiled into the build, and their config is checked against that code's schema.
- A bundle's prompts and skills can still steer the model, so the client shows a bundle's rows before install.
- Code packages are trusted by installing them, as in §15. Third-party code that should not run in the Home isolate should be an MCP server.
- A capability manifest (`xin.capabilities`) and owner approval for risky actions come in P9.

## Setups: bundle patches, profiles and export (P8)

dsh lets a user keep several named profiles and share a whole setup. On the free plan a setup is data, so it is a bundle.

**Bundle patches.** A bundle may carry `patch: [{ id, config?, disabled? }]` next to `rows`. Each entry targets a compiled row by its plain id and replaces those fields, as a profile patch does. It may not target a `required` row, a row another bundle owns, or a runtime row. Patches apply in the runtime layer, in install order, so a later bundle's patch wins, and the owner patch still wins over all of them. An unknown target is reported in `bundle.list` and kept until the row exists, as the owner patch does today. Validation runs the target plugin's `Config` schema over the patched config.

**Profiles.** A profile is a named, stored set of runtime bundles plus an owner patch. The compiled layer is shared, because there is one build.

| Op | Effect |
| --- | --- |
| `profile.list` | profile names, the active one, and each profile's bundle packages |
| `profile.save` | `{ name }` stores the current runtime bundles and owner patch under `name` (replacing it) |
| `profile.switch` | `{ name }` replaces the runtime bundles and the owner patch with the profile's, recomposes, and makes it active. If a required row ends not active, it restores the previous state and answers `application: "failed"` |
| `profile.delete` | `{ name }` deletes a profile that is not active |
| `profile.export` | `{ name?, package, version }` returns a publishable `package.json` object (`name`, `version`, `keywords: ["xin-plugin"]`, `xin: { bundle, patch, requires }`) built from the named profile or the current setup: every runtime bundle's rows (re-homed under the new package), every owner-inserted row of a `multiple` plugin, and as `patch` each bundle's own patch in bundle order followed by the owner patch on compiled rows (the owner's entry wins; `disabled: false` is kept). Secrets are never exported |

Profiles live in the `kv` key `plugins.profiles` as `{ active, bundles, patch, profiles: { <name>: { bundles, patch } } }`. The top-level `bundles` and `patch` are the active setup, written in the same put as `active`, and it is the source of truth: at boot, when `plugins.bundles` or `plugins.patch` disagree with it, they are rewritten from it before composing, so a crash anywhere in a switch converges on the named profile. Switching and every bundle write run through one queue, and a switch validates each bundle like `bundle.put`. Only a missing key creates `default` from the current state; an unreadable value is kept, reported as a warning, and replaced only when the owner saves. The ops live in a kernel row `profiles`, which is not required.

An exported setup installs anywhere through `market.install` or `bundle.put`, because it is an ordinary bundle.

## Presets beyond tools (P8)

A preset may also select prompt rows. `prompts` is `"all"` (default), `"none"`, or a list of `prompt` row ids; the removed extensions are the `prompt-*` extensions the selection excludes, computed and applied the same way as `tools`. `preset.assign` also accepts `{ conversation, preset }` for one conversation (a thread or a coordinator) and `{ conversation, preset: null }` to clear it; a conversation assignment wins over its project's. Thread conversations inherit their coordinator's effective preset when created, as today.
