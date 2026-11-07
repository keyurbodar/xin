# Market, runtime bundles and contribution rows

On the free plan, code needs a build and rows don't. A package whose `xin` field declares only `bundle` installs live as a runtime bundle: its rows mount after the compiled bundles and before the `xin.profile.json` patch, and the row ids are the bundle's own ids. A package that declares `plugins` is code and goes to the pending build list. Spec: `docs/plan/architecture/12-market.md`.

## Sub-features

- Runtime bundles (P6/P9), owned by the `packages` kernel row: `bundle.put {package, rows, patch?, requires?}` (local bundles), `bundle.list`, `bundle.remove`. `ctx.packages` exposes `bundles()`, `put(bundle)` and `remove(package)` for the market.
- Apply: a fresh install keeps its rows even when one fails to start; the failed rows report `failed` and the result is `{ application: "failed", rows }`. Replacing an installed bundle restores the replaced version when any new row fails and answers `{ application: "failed", rows }`. Otherwise `{ application: "applied" }`.
- Validation, before anything is stored, each violation `bad_args`: the package name must be a valid npm name and must not be compiled into this build; every row's plugin is in the catalog, or the bundle `requires` at least one code package (then an unknown plugin is allowed and shows `missing`); no row names a `required` plugin and no patch entry targets a required row; row ids match `[A-Za-z0-9][A-Za-z0-9._-]*`, are unique, and are not already in the composed tree; each row's `config` and each patched row's resulting config passes that plugin's `Config` schema; at most 64 rows and 512 KiB of JSON.
- Patches: `patch: [{id, config?, disabled?}]` targets any row by id and replaces the named fields. An unknown target reports `unknown` in `bundle.list` and is kept until the row exists. The owner patch still wins over a bundle patch, and writing the inherited value back drops the owner override.
- Contribution rows: `mcp-server {name, url, headers?}` (values may use `${credential:REF}`) and `preset {id, name?, description?, order?, tools}`. `prompt` and `skill` rows are gone.
- Any plugin may have several rows. A second row of a plugin that registers a fixed extension name fails to start and reports `failed`.
- Market (P7/P9), the `market` row: `market.search {query?, category?}`, `market.entry {name}`, `market.install {name, version?}`, `market.update {name, version}`, `market.refresh`. Indexes are dsh market format 1; statuses are `not-installed`, `installed`, `update-available`, `different-version` and `provided`. A bundle is fetched only from the registry, integrity-checked (sha512), and mounted from the tarball's own manifest; a code package becomes `name@version` pending; a git source becomes a pending `git+` spec. Refused: installing what is compiled, an older version on update, and a wrong integrity.

## How to get to it (user POV)

An Extensions page searches the market, shows a package's README, versions and the rows it adds, and offers Install and Update. A package is marked Instant (bundle) or Needs a build (code). There is no background update check and no updates badge; the page refreshes on demand.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"b1","op":"bundle.put","args":{"package":"lahn-notes","rows":[{"id":"notes","plugin":"mcp-server","config":{"name":"notes","url":"https://notes.example.test/mcp","headers":{"authorization":"Bearer ${credential:NOTES_TOKEN}"}}}],"patch":[{"id":"time","config":{"timezone":"Asia/Kolkata"}}]}}'   # applied; the row is failed with waiting-credentials until the secret exists
$S call POST /v1/cmd '{"id":"b2","op":"bundle.list","args":{}}'          # rows "notes" active or failed, patch "time" applied
$S call POST /v1/cmd '{"id":"b9","op":"secret.set","args":{"ref":"NOTES_TOKEN","value":"probe"}}'   # the failed row is retried
$S call POST /v1/cmd '{"id":"b4","op":"bundle.put","args":{"package":"lahn-notes","rows":[{"id":"notes","plugin":"prompt","config":{}}]}}'   # bad_args: plugin prompt is not in this build
$S call POST /v1/cmd '{"id":"b5","op":"bundle.put","args":{"package":"lahn-bad","rows":[{"id":"core","plugin":"pi"}]}}'   # bad_args: required plugin
$S call POST /v1/cmd '{"id":"b6","op":"bundle.put","args":{"package":"xin-plugin-time","rows":[{"id":"extra","plugin":"time"}]}}'   # bad_args: compiled into this build
$S call POST /v1/cmd '{"id":"b7","op":"bundle.remove","args":{"package":"lahn-notes"}}'
$S call POST /v1/cmd '{"id":"m1","op":"market.search","args":{}}'        # entries from the configured indexes
$S call POST /v1/cmd '{"id":"m3","op":"market.entry","args":{"name":"left-pad"}}'   # status not-installed, kind null
$S call POST /v1/cmd '{"id":"m5","op":"market.refresh","args":{}}'       # refetches every index, bypassing the cache
$S call POST /v1/cmd '{"id":"m7","op":"market.update","args":{"name":"xin-plugin-time","version":"2.0.0"}}'   # bad_args: provided by this build
```

The registry install, update and restore path (Lahn publishes 1.1.0) needs a published package, so it is proven in the gate against a fake registry: `plugins/market/market.test.ts`. Evidence from the live drive: `.verify/evidence/P6-bundles.txt`, `.verify/evidence/P7-market.txt`.

## Gotchas

- `market.search` talks to the real npm registry under `wrangler dev`. An empty result is correct until packages publish a Xin market index.
- A package that is not a Xin package reports `kind: null`.
- Runtime row ids are the bundle's own ids, so a second bundle cannot reuse one; `bundle.put` answers `bad_args` when the id is already in the tree.
- The free plan allows 50 subrequests per invocation; every market op stays at or under 40.
