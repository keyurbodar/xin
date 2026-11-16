# CI on Instabox

CI for keyurbodar/xin runs on Instabox VMs. GitHub Actions' `gate.yml` is disabled through the API but stays in the repo, so turning it back on is one call (see below).

## How it works

- **Dispatcher.** One always-on Instabox VM named `xin-ci` (2 vCPU / 4 GiB, Debian, `universal` template) runs `scripts/ci/dispatcher.ts` under systemd (`xin-ci.service`). Its public port 8080 receives the repo webhook (`push` to main, `pull_request` opened, synchronize and reopened) and serves the logs.
- **Runner pool.** Ten persistent 8 vCPU / 16 GiB VMs (`xin-ci-runner-*`, metadata `xin-ci=runner`) are created from the `xin-runner` snapshot. That snapshot holds bun 1.4.4, a clone of the repo, `node_modules` for root and `web/`, and Playwright's Chromium. A runner pauses itself after 5 idle minutes, and the next exec wakes it in about 3 s. Creating a VM from a snapshot takes 40 to 175 s when several start at once, so runners are reused rather than created per job.
- **A run.** Each head SHA leases 5 runners. Each runner kills leftover processes from the last run, fetches the SHA, runs `git checkout -f` and `git clean -ffdx -e node_modules`, and reinstalls only when `bun.lock` or `web/bun.lock` changed. Then it runs its jobs at the same time:
  - **checks runner:** `fmt`, `lint`, `types` (`bunx tsgo --noEmit -p tsconfig.json`), `bundle`, `bench` (`INGLE_LOAD=1 bun run test`), `web-types`, `web-test` (web's `bun test src`, the old `prebuild`) and `web-build` (`vite build`).
  - **test runners 1-4:** `bun run test` on a set of test files with `VITEST_MAX_WORKERS=6`. That is 6 workers on 8 vCPU, which leaves room for import work, so the default 5 s test timeout behaves as it does on Actions (2 workers on 4 vCPU).
- **Sharding.** Test files are split across runners by recorded duration (largest first, each to the lightest runner). Every passing shard records each file's time, scaled so it includes import overhead, and the next run plans from those times. A shard fails if any file it was given did not run. The run errors if the `include` in `vitest.config.ts` stops matching `VITEST_INCLUDE` in `scripts/ci/plan.ts`, so new test locations can't slip out of CI unnoticed.
- **Statuses.** Every job posts `instabox/<job>`, and `instabox/ci` is the rollup. **Green means `instabox/ci` is success.** Every context a run opens goes final: the run's `finally` block errors anything still open, a watchdog errors pending contexts older than 10 min every minute, and startup errors whatever a crashed process left open.
- **Same tree, no rerun.** When a SHA's git tree already passed, for example a squash merge of an up-to-date PR, the run posts `instabox/ci` success at once with "same tree passed on <sha>".
- **Cancellation and limits.** A new push to the same PR, or to main, cancels the older run, whose contexts read "cancelled: superseded". Each job can run for at most 300 s and each run for at most 8 min. Runs wait for free runners, so at most 2 run at once.
- **Trust.** Only PRs from this repo, or by an owner, member or collaborator, run. Fork PRs from anyone else don't.

## Read logs

The `instabox/<job>` status links to `<CI_URL>/logs/<sha>/<job>`, the full job log, which is live while the job runs. `instabox/ci` links to `<CI_URL>/runs/<sha>`, which lists each run of that SHA with its wall time and cost, and each job's outcome and time. Other pages:

- `<CI_URL>/runs.json`: the last 200 runs.
- `<CI_URL>/health`: idle and busy runners, and the active runs.
- `<CI_URL>/logs/image`: the last image build.
- `<CI_URL>/logs/<sha>/checkout-<n>`: runner n's checkout and install.
- `<CI_URL>/logs/<sha>/run`: errors from planning the run.

Logs live on the dispatcher's `/data` disk, so they outlive every runner.

## Operate (from build)

`CI_URL`, the webhook secret and the hook id are in `~/.capy/work/secrets/instabox-ci.env` (mode 600). The Instabox key is in `~/.capy/work/secrets/instabox.env`.

```bash
set -a; . ~/.capy/work/secrets/instabox.env; set +a; export GH_TOKEN=$(gh auth token)
bun scripts/ci/ctl.ts rerun <sha>            # run a SHA again (a cached tree answers at once)
bun scripts/ci/ctl.ts rerun <sha> --fresh    # forget the tree cache for that SHA and run it for real
bun scripts/ci/ctl.ts runs                   # recent runs as JSON
bun scripts/ci/ctl.ts image <sha>            # rebuild the xin-runner snapshot from <sha>
bun scripts/ci/ctl.ts deploy                 # create or update the dispatcher, its secrets and the webhook
bun scripts/ci/ctl.ts hook on|off            # turn the repo webhook on or off
```

- **Change the dispatcher:** edit `scripts/ci/*.ts`, then run `deploy`. Deploying restarts the service, and the restart errors any run in flight, so deploy between runs.
- **New lockfile:** runners reinstall on their own the first time they see it, which costs a few seconds per runner. To bake it in, run `image <main sha>`, then delete the runners (`instabox rm` each `xin-ci-runner-*`). The pool refills from the new snapshot within 5 minutes.
- **A broken runner:** a failed checkout marks the runner broken. The dispatcher deletes it and creates a replacement.

## Rotate keys

- **Instabox key:** make a new key in the Instabox dashboard (API keys) and write it to `~/.capy/work/secrets/instabox.env`. Run `deploy`, then revoke the old key.
- **GitHub token:** the dispatcher uses `GH_TOKEN` to post statuses and read the git tree and `vitest.config.ts`. A fine-grained token with Commit statuses (write) and Contents (read) on keyurbodar/xin is enough. Export it as `GH_TOKEN`, then run `deploy`.
- **Webhook secret:** remove `CI_WEBHOOK_SECRET` from `~/.capy/work/secrets/instabox-ci.env` and run `deploy`. Deploy generates a new secret and updates both the dispatcher and the GitHub hook.

## If Instabox is down

1. Turn Actions back on: `gh api -X PUT repos/keyurbodar/xin/actions/workflows/gate.yml/enable`. `gate` and `web` run on the next push.
2. Turn the webhook off so no `instabox/*` statuses go pending: `bun scripts/ci/ctl.ts hook off`.
3. Until Instabox is back, the merge bar is Actions' `gate` and `web`.

When Instabox is back, run `deploy` and `hook on`, then disable Actions again with `gh api -X PUT repos/keyurbodar/xin/actions/workflows/gate.yml/disable`.

## Cost

A run costs about $0.003 to $0.004 of runner compute: 5 runners for about 40 s at $0.068 per runner-hour. A runner also costs up to 5 idle minutes before it pauses, about $0.006 each. The always-on dispatcher costs about $0.017 an hour, roughly $12 a month. Each VM's `/data` is 20 GiB: 11 VMs make 220 GiB, 20 GiB over the Pro plan's 200 GiB included, which is about $1.60 a month.
