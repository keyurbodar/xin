# Orb fleet hosts

Machine-readable fleet state for the local agent and Puck. Update the table and
`Last verified` whenever a host is migrated, capped, or drained.

| provider | hostname | ram | /data free | cap tiny/small/big | migrated | notes |
|---|---|---|---:|---|---|---|
| dof-live | dof | 8 GiB | 4.8 GiB | 3/2/1 | yes | 4 containers; cooling until 2026-11-09 10:58 UTC |
| xin-b2-live | xin-b2 | 8 GiB | unknown | 3/2/1 | no | cooling until 2026-11-09 10:15 UTC; also runs Amp runner `xin-b2` |
| xin-b3-orbs | xin-b3 | 8 GiB | 5.2 GiB | 3/2/1 | yes | cooling until 2026-11-09 11:32 UTC |
| host-4 | host-4 | 8 GiB | 9.6 GiB | 3/2/1 | yes | default provider; empty |
| host-5 | host-5 | 8 GiB | 16 GiB | 3/2/1 | yes | empty |
| host-6 | host-6 | 8 GiB | 16 GiB | 3/2/1 | yes | empty |
| host-7 | host-7 | 8 GiB | 16 GiB | 3/2/1 | yes | empty |
| vm14 | vm14 | unknown | unknown | none | no | no SSH; old dispatch with pause snapshots |
| vm20 | vm20 | unknown | unknown | none | no | no SSH; old dispatch with pause snapshots |

Last verified: 2026-11-09T09:42Z

## Capacity model

All reachable hosts are 4 vCPU / 8 GiB RAM / 20 GiB `/data`. Admission is by
budget, not container count:

- CPU: sum of existing container CPU limits + request ≤ `nproc` (4)
- RAM: sum of existing container memory limits + request ≤ host RAM − 1 GiB
- disk: free on `/` or `/data`, whichever is lower, ≥ 4 GiB
- absolute cap: 4 containers

Per-host caps are therefore:

| type | CPU | RAM | /dev/shm | fits |
|---|---:|---:|---:|---:|
| tiny | 1 | 2 GiB | 512 MiB | 3 |
| small | 2 | 3 GiB | 1 GiB | 2 |
| big | 3 | 5 GiB | 1 GiB | 1 |

`big` is 5 GiB, not 12 GiB: these are 8 GiB hosts, so a 12 GiB orb cannot run.
A thread's type is fixed at creation.

## Disk layout

- containerd root: `/data/containerd`
- Docker data root: `/data/docker`
- root filesystem stays near 4.7 GiB used (32%)
- snapshots on pause are disabled; `delete` removes the container and snapshot
- janitor timer every 30 minutes prunes build cache and dangling images

## Pending

- Register `tiny`, `small`, `big` on each provider in Settings → Orbs; until
  then `ORB_TYPE` is unset and dispatch uses `small` (2 CPU / 3 GiB).
- Apply the budget dispatch to `dof`, `xin-b3`, `xin-b2` after their cooldowns.
- `vm14` / `vm20`: grant SSH and update, or drain and remove.
- `dof-live` holds 4 containers; new spawns are refused until threads are deleted.
