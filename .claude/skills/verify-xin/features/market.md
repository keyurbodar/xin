# Market, runtime bundles and contribution rows

On the free plan, code needs a build and rows don't. A package whose `xin` field declares only `bundle` installs live as a runtime bundle: its rows mount between the profile patch and the owner patch, with ids `package#row`. A package that declares `plugins` is code and goes to the pending build list. Spec: `docs/plan/architecture/12-market.md`.

## Sub-features

- Runtime bundles (P6), owned by the `packages` kernel row: `bundle.put {package, rows, requires?}` (local bundles), `bundle.list`, `bundle.remove`, `bundle.rollback`. A put that leaves a row `failed` restores the previous version and answers `application: "failed"`. An invalid bundle (required plugin, bad config, duplicate single-instance plugin, bad id, more than 64 rows, over 512 KiB) is `bad_args` and nothing is stored. A retried identical put changes nothing. Rows report `superseded` when the build now compiles the same package.
- Contribution rows (P6), all `multiple: true` and off by default: `prompt {title?, text}`, `skill {markdown}`, `mcp-server {name, url, headers?}` with header values from row secrets, `preset {id?, title, description, tools}`. A stored skill, stored MCP server or config preset of the same name wins and the row fails with a clear error.
- Setups (P8): a bundle may carry `patch: [{id, config?, disabled?}]` on compiled, non-required rows (state `applied` or `unknown` in `bundle.list`; the owner patch still wins). The `profiles` kernel row: `profile.list`, `profile.save {name}`, `profile.switch {name}` (live, rolls back if a required row breaks), `profile.delete {name}` (not the active one), `profile.export {name?, package, version}` returns a publishable package.json (`keywords: ["xin-plugin"]`, `xin: {bundle, patch, requires}`, never secrets) that installs elsewhere with `bundle.put` or `market.install`.
- Presets (P8): `prompts: "all" | "none" | [row ids]` alongside `tools`; `preset.assign {conversation, preset}` overrides the project's, `preset: null` clears it.
- `plugin.secret.set`, `plugin.configure`, `plugin.enable`, `plugin.reset` and `plugin.remove` accept runtime ids `package#row`. `plugin.insert` does not.
- Market (P7), the `market` row: `market.search {query?, category?}` (configured indexes plus npm keyword `xin-plugin`, at most 40 requests), `market.entry {name}`, `market.install {name, version?}`, `market.update {name, version?}`, `market.refresh`, `market.updates`, and the home part `market: {updates, checkedAt}`. The first update check runs `checkHours` after the row starts. Bundles are fetched from the registry host only (no redirects, 8 MiB compressed, 4 MiB unpacked), integrity-checked (sha512), and mounted from the tarball's own manifest. Code packages become `name@version` pending entries. Local packages and incompatible versions are `bad_args`.

## How to get to it (user POV)

An Extensions page searches the market, shows a package's README, versions and the rows it adds, and offers Install, Update and Roll back. A package is marked Instant (bundle) or Needs a build (code). An updates badge reads the `market` home part.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"p2","op":"bundle.put","args":{"package":"work-setup","rows":[{"id":"tone","plugin":"prompt","config":{"text":"Be formal."}}],"patch":[{"id":"time","config":{"timezone":"Asia/Kolkata"}}]}}'   # patch state applied
$S call POST /v1/cmd '{"id":"p4","op":"profile.save","args":{"name":"work"}}'
$S call POST /v1/cmd '{"id":"p8","op":"profile.switch","args":{"name":"work"}}'
$S call POST /v1/cmd '{"id":"p11","op":"profile.export","args":{"name":"work","package":"@keyur/xin-work","version":"1.0.0"}}'   # package.json; bundle.put its xin elsewhere to reproduce
$S call POST /v1/cmd '{"id":"p12","op":"profile.delete","args":{"name":"work"}}'   # bad_args while active
$S call POST /v1/cmd '{"id":"b1","op":"bundle.put","args":{"package":"lahn-notes","rows":[{"id":"style","plugin":"prompt","config":{"text":"Always answer in short sentences."}},{"id":"notes","plugin":"skill","config":{"markdown":"---\nname: notes\ndescription: Keep tidy notes.\n---\nWrite short notes."}}]}}'   # applied
$S call POST /v1/cmd '{"id":"b2","op":"bundle.list","args":{}}'          # rows lahn-notes#style and #notes active
$S call POST /v1/cmd '{"id":"b3","op":"skill.list","args":{}}'           # notes listed
$S call POST /v1/cmd '{"id":"b5","op":"bundle.put","args":{"package":"lahn-notes","rows":[{"id":"style","plugin":"prompt","config":{}}]}}'   # bad_args: missing text
$S call POST /v1/cmd '{"id":"b6","op":"bundle.put","args":{"package":"lahn-bad","rows":[{"id":"core","plugin":"pi"}]}}'   # bad_args: required plugin
$S call POST /v1/cmd '{"id":"b7","op":"bundle.rollback","args":{"package":"lahn-notes"}}'
$S call POST /v1/cmd '{"id":"b9","op":"plugin.secret.set","args":{"id":"lahn-notes#style","key":"probe","value":"x"}}'
$S call POST /v1/cmd '{"id":"b10","op":"bundle.remove","args":{"package":"lahn-notes"}}'
$S call POST /v1/cmd '{"id":"m1","op":"market.search","args":{}}'        # real npm; empty until someone publishes with keyword xin-plugin
$S call POST /v1/cmd '{"id":"m3","op":"market.entry","args":{"name":"left-pad"}}'   # kind null, status incompatible: not a Xin package
$S call POST /v1/cmd '{"id":"m5","op":"market.refresh","args":{}}'       # checkedAt, updates
$S call POST /v1/cmd '{"id":"m7","op":"market.update","args":{"name":"xin-plugin-time"}}'   # bad_args: local package
```

The registry install, update and rollback path (Lahn publishes 1.1.0) needs a published package, so it is proven in the gate against a fake registry: `plugins/market/market.test.ts`. Evidence from the live drive: `.verify/evidence/P6-bundles.txt`, `.verify/evidence/P7-market.txt`, `.verify/evidence/P8-setups.txt`.

## Gotchas

- `market.search` talks to the real npm registry under `wrangler dev`. No package uses the `xin-plugin` keyword yet, so an empty result is correct.
- A package that is not a Xin package reports `kind: null` and `status: "incompatible"`.
- Runtime row ids contain `#` and `@`; quote them in shell.
- The free plan allows 50 subrequests per invocation; every market op stays at or under 40.
