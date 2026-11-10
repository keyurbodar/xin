# Orb provider hosts

Self-hosted Amp orb providers. One Instabox sandbox per account. Each provider
runs `amp orb provider` as a systemd service and spawns one Docker container per thread.

> **Stopped 2026-11-10.** All seven reachable providers and janitors were
> disabled, the `xin-b2` runner was disabled, and the `amp-orb-keepalive`
> Worker was deleted. dof woke, had its services disabled, and was paused again;
> all seven hosts are now stopped and disabled. The sandboxes themselves still
> exist. No new orb threads will run until these services are re-enabled.

## Fleet state

| provider | hostname | ram | /data free | cap tiny/small/big | migrated | notes |
|---|---|---|---:|---|---|---|
| `dof-live` | dof | 8 GiB | 7.5 GiB | 3/2/1 | yes | fresh containerd store after metadata corruption; 0 containers; recovered workspaces at `/var/tmp/dof-recovered` |
| `xin-b2-live` | xin-b2 | 8 GiB | 8 GiB | 3/2/1 | yes | 0 containers; also runs runner `xin-b2` |
| `xin-b3-orbs` | xin-b3 | 8 GiB | 8 GiB | 3/2/1 | yes | 0 containers; back above the 6 GiB spawn threshold |
| `host-4` | host-4 | 8 GiB | 9 GiB | 3/2/1 | yes | default provider; empty |
| `host-5` | host-5 | 8 GiB | 15 GiB | 3/2/1 | yes | empty |
| `host-6` | host-6 | 8 GiB | 15 GiB | 3/2/1 | yes | empty |
| `host-7` | host-7 | 8 GiB | 15 GiB | 3/2/1 | yes | empty |
| `vm14` | vm14 | unknown | unknown | none | no | no SSH; old dispatch ignores the registered `tiny`/`small`/`big`; 0 threads, orphaned snapshot may remain |
| `vm20` | vm20 | unknown | unknown | none | no | no SSH; old dispatch ignores the registered `tiny`/`small`/`big` |

Last verified: 2026-11-09T12:22Z

## Accounts

| Provider | Instabox host | Account |
|---|---|---|
| `dof-live` | dof | chiranaibase@gmail.com |
| `xin-b2-live` | xin-b2 | meroailabs@gmail.com |
| `xin-b3-orbs` | xin-b3 | mirairesearchcollective@gmail.com |
| `host-4` | host-4 | keyurbodar16@gmail.com |
| `host-5` | host-5 | keyur.bodar18@gmail.com |
| `host-6` | host-6 | keyur.bodar19@gmail.com |
| `host-7` | host-7 | keyurbodar8@gmail.com |

Each reachable host is 4 vCPU / 8 GiB / 20 GiB `/data`.

## Disk layout and guardrails

Docker 29 uses the containerd snapshotter. `data-root` alone is not enough:
images and container layers live under containerd's root. On every reachable host:

- containerd root: `/data/containerd`
- Docker data root: `/data/docker`
- root filesystem stays around 4.7 GiB used (32%) instead of filling to 100%

`dispatch.sh` now enforces, for **new** containers only:

- `MAX_ORBS=4` — absolute cap on `amp-*` containers
- `MIN_FREE_GIB=6` — minimum free space on `/` or `/data`, whichever is lower
- CPU budget: sum of existing container CPU limits + request ≤ `nproc`
- memory budget: sum of existing container memory limits + request ≤ host RAM − 1 GiB

Resuming an existing paused orb is always allowed. Spawns are refused with a log
line when a budget is exhausted. Snapshots on pause are disabled; `delete` removes
the container and any snapshot image.

### Orb types

Dispatch reads `ORB_TYPE` and sizes the container from the matching
`ORB_TYPE_<NAME>_{CPUS,MEMORY,SHM}` variables. Defaults installed on each host:

| Type | CPU | RAM | `/dev/shm` | Fits per 4c/8g host |
|---|---:|---:|---:|---:|
| `tiny` | 1 | 2 GiB | 512 MiB | 3 |
| `small` | 2 | 3 GiB | 1 GiB | 2 |
| `big` | 3 | 5 GiB | 1 GiB | 1 |

The names must also be registered on each provider in **Settings → Orbs → Orb
types**; Amp passes the chosen name as `ORB_TYPE`. Without registered types,
`ORB_TYPE` is unset and dispatch uses `small` (2 CPU / 3 GiB).

A 2 GiB × 6 promise does not fit 8 GiB of RAM. Three tiny orbs (6 GiB) is the
real limit on these hosts; a fourth would be 8 GiB and is refused. `big` is
5 GiB, not 12 GiB, because these hosts have 8 GiB.

Dispatch also mounts shared caches when present:

- `/data/pnpm-store` → `/data/pnpm-store`, with `npm_config_store_dir` and `PNPM_STORE_DIR`
- `/data/npm-cache` → `/root/.npm`, with `npm_config_cache`
- `/data/ms-playwright` → read-only, only when the directory is non-empty

`orb-janitor.timer` runs every 30 minutes on all Instabox hosts and prunes build
cache and dangling images. It does not delete running or paused orbs.

The default provider is now `host-4` (it was `dof-live`, which now has zero
containers after the store rebuild).

## Applied 2026-11-09

- `dof` and `xin-b3`: containerd moved to `/data/containerd`; root disk dropped
  from 100% / 96% to 32%. Orphan `snap-*` images removed. Janitor installed.
- `host-4` … `host-7`: containerd on `/data/containerd`; janitor installed.
- `host-4` … `host-7`: budget-based dispatch with `ORB_TYPE` sizing.
- `dof`, `xin-b3`, `xin-b2`: cooling down; apply `update-dispatch-budget.sh`
  when they wake.
- `vm14`, `vm20`: no SSH access from here; still run the old dispatch.
- Deleted archived threads `Intake queue rewrite` and `Kiko Durable Objects
  study`; their containers were removed. All seven Instabox hosts now hold zero
  containers and sit above the 6 GiB threshold.
- Orb types still need to be registered in **Settings → Orbs** before threads
  can choose them.

### dof containerd incident

Migrating dof's containerd store to `/data` copied a BoltDB that was already
inconsistent from the first interrupted copy. containerd then crash-looped with
`freepages: failed to get all reachable pages`. `bbolt` check, compact, freelist
rebuild, freelist abandon, and meta-page revert all failed. The store was rebuilt
fresh; the four stale containers were removed. Their workspaces were copied to
`/var/tmp/dof-recovered/snap-*` before the reset, then deleted once all four
branches were confirmed pushed. dof is healthy and took a test orb end-to-end
after the rebuild.

Those four threads will cold-start if woken: their containers are gone and
snapshots are disabled, so they re-clone the repo and rerun `.agents/setup`.
Snapshots stay disabled because the 20 GiB disks cannot hold a per-orb commit
alongside the image; `docker start` already resumes a paused container, so a
snapshot only helps if the container itself is lost.

`bbolt check` against a copy of `meta.db` returned `OK` on all seven Instabox
hosts on 2026-11-09T12:15Z.

Capacity: nine providers total — seven managed Instabox hosts plus `vm14` and
`vm20`. Only the seven honor `ORB_TYPE`; the two VPS only show the labels until
their dispatch is updated. The seven are **14 `small` or 21 `tiny`**, all above
the 6 GiB spawn threshold with zero containers on every host.

### How that compares to one boat `small`

A boat `small` sandbox is **2 vCPU / 4 GB** (`boat new --type small`). An
Instabox free machine is **4 vCPU / 8 GiB**, and free accounts cannot select the
2/4 shape — that is Pro-only. The provider makes up for it by slicing each
machine into containers:

| Shape | Per host | Across 7 hosts | vCPU | RAM |
|---|---:|---:|---:|---:|
| boat `small` | — | 7 | 14 | 28 GiB |
| orb `tiny` (1c/2g) | 3 | 21 | 21 | 42 GiB alloc |
| orb `small` (2c/3g) | 2 | 14 | 28 | 42 GiB alloc |
| orb at boat-small (2c/4g) | 1 | 7 | 14 | 28 GiB |

Two 2c/4g orbs per host would need 8 GiB; the budget is host RAM − 1 GiB = 7 GiB,
so only one fits. `small` at 3 GiB is the practical compromise: same CPU as boat
`small`, 75% of the RAM, twice the count.

Ceilings, in the order they bind:

1. **Disk.** 20 GiB per host, ~5 GiB image, 0.5–2 GiB per orb, plus build cache.
   Three orbs per host is the edge; `MIN_FREE_GIB=6` refuses past it.
2. **RAM.** `tiny` at 2 GiB OOMs browser work — dof has 5 OOM kills, xin-b3 has 1.
   Chrome/Playwright needs ~4 GiB, i.e. one large orb per host.
3. **`maxRunMinutes: 480`.** Each machine stops after 8 h and needs a wake.
4. **30-min idle suspend.** Without the keepalive Worker a quiet machine suspends
   and its orbs pause.

More capacity means more free accounts (one machine each, +2 `small` orbs) or
restoring the disabled Pro workspace, which already carries `maxMachines: 500`,
`maxRunning: 100`, `alwaysOn: true`, the 2/4 shape, and the suspended `t3dev`
(8c/16g) machine.

## New-host setup (host-4 … host-7)

Installed by `install-provider-on-host.sh`:

- Docker data root moved to `/data/docker` (20 GiB persistent disk).
- Amp CLI copied to `/usr/local/bin/amp`.
- `/opt/orbs/dispatch.sh` — spawn/pause/delete with Docker.
- `/etc/amp-orb-provider.env` — provider token, budget caps, and `ORB_TYPE_*` sizing (root-only).
- `amp-orb-provider.service` — systemd, enabled at boot, runs as root.
- `orb-janitor.timer` — every 30 minutes, prunes build cache and dangling images, logs disk use.

Provider tokens were created with `amp orb provider create <name>` and written to
each host's env file. Do not copy one host's env file to another; each token is unique.

## Keepalive

The `amp-orb-keepalive` Cloudflare Worker (account `d4ac696abb45fe4276d9974c3ceaf774`,
cron `*/9 * * * *`) renews activity leases so the free-plan sandboxes do not
suspend after 30 minutes idle. Secrets `INSTABOX_API_KEY` through
`INSTABOX_API_KEY_7` cover all seven accounts.

Check the log:

```bash
cd cf-worker
npx wrangler kv key get log --namespace-id 6c43d7d61df04506a3351694287b0d6a --remote | tail -c 2000
```

## Verify a provider

```bash
amp -ox "echo hello" --executor orb --orb-provider host-4
```

Then delete the test thread so its container is removed.

## Disk rule

Each host has 20 GiB. The orb image is several GiB unpacked; each thread adds
0.5–2 GiB. Snapshots on pause are disabled and `delete` removes the container and
its snapshot, so disk is returned when the thread is deleted. Keep the janitor
installed; it prunes build cache and dangling images.
