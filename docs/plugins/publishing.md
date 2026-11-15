# Publishing to a market

A Home finds plugins through **market indexes**. These are static JSON files in dsh's market index format 1, which the owner adds under the market plugin's `indexes` setting (at most 8 https URLs). The build's own packages are always listed first and need no index.

## Two kinds of package

- **Code package.** Its `ingle` field declares `plugins`, so it has its own modules. Installing one records it as pending, and it arrives with the next build, when `system.update` asks your deploy pipeline (`docs/deploy/install-pipeline.md`) to run `plugin sync` and deploy.
- **Bundle package.** Its `ingle` field declares only a `bundle`, made of rows that mount plugins this build already compiles, with their config. Installing one mounts it live with no build. Its rows are data, but they can still steer the model, so the owner sees them before installing. A bundle's `patch` may turn on or reconfigure rows that are already there, and it asks for those rows' permissions too. A patch on a kernel row is refused, and so is a `requires` this build doesn't already have.

## The index entry

```json
{
  "format": 1,
  "title": "Acme plugins",
  "metadata": { "categories": {}, "labels": {}, "sortKeys": {} },
  "plugins": [
    {
      "name": "@acme/ingle-weather",
      "title": "Weather",
      "description": "Forecasts in a pane tab.",
      "metadata": { "keywords": ["weather"], "labels": [], "sortKeys": {} },
      "versions": [
        {
          "version": "1.2.0",
          "publishTimestamp": 1767225600,
          "source": { "type": "npm" },
          "engines": { "ingle": ">=0.1.0" }
        }
      ]
    }
  ]
}
```

List versions newest first, each with an exact semver. A version whose `engines.ingle` the running Ingle doesn't satisfy is shown but not offered. `source` is either `{ "type": "npm", "registry"? }` or `{ "type": "git", "url", "commit", "path"? }`, where `commit` must be a full 40-character SHA.

## What the market checks

- **Permissions.** The market reads them before anything is stored, from your tarball's own `package.json` after checking its hash, never from the registry's version document. For a code package they are the `permissions` its plugins declare. For a bundle they come from the compiled plugins its rows mount and the rows its patch turns on. A git source can't be read before the build, so it always asks for `runtime`. Declare `permissions` honestly: a missing one fails your plugin at mount in every Home that installs it.
- **Integrity.** An npm version must have a sha512 `dist.integrity`; versions without one, or with another algorithm, are refused. A code install is recorded with a pin: the integrity, the tarball URL and the permissions the owner approved. Before `bun add`, `plugin sync` fetches the tarball and refuses other bytes. After it, sync refuses a `bun.lock` that resolves to another SRI and an installed `package.json` that declares a permission outside the pin. So the code that builds is the code the owner consented to, with the permissions they saw. Don't republish under an existing version.
- **Rollback.** Every applied install is recorded. `market.rollback` reinstalls the version that ran before the current one, as long as the index still lists it. If that version needs permissions you hadn't granted, it asks for consent like an update does.

## Adding by spec

Extensions → Add from URL calls `market.add` with an exact `name@x.y.z`, which gets the same consent and pin as an index entry, or a git spec, which asks for `runtime`. A version range is refused, so the build installs the version the owner saw.

## Before you publish

1. Run the whole gate, `bun scripts/gate.ts`, in a checkout that includes your package.
2. Make sure `plugin.doctor` reports your rows `active` with no issues under `plugin dev`.
3. `npm publish`, then add the version to your index, newest first.
