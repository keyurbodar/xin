#!/usr/bin/env bash
set -euo pipefail

MAX_ORBS="${MAX_ORBS:-4}"
MIN_FREE_GIB="${MIN_FREE_GIB:-6}"

free_gib() { df -Pk "$1" 2>/dev/null | awk 'NR==2{print int($4/1024/1024)}'; }
min_free_gib() {
  local m=999999 f
  for p in / /data; do
    [ -d "$p" ] || continue
    f=$(free_gib "$p")
    [ -n "$f" ] || continue
    [ "$f" -lt "$m" ] && m=$f
  done
  echo "$m"
}
to_mib() {
  local v n
  v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  n=${v%[gmk]}
  case "$v" in
    *g) awk -v x="$n" 'BEGIN{printf "%d", x*1024}' ;;
    *m) awk -v x="$n" 'BEGIN{printf "%d", x}' ;;
    *k) awk -v x="$n" 'BEGIN{printf "%d", x/1024}' ;;
    *)  awk -v x="$n" 'BEGIN{printf "%d", x/1024/1024}' ;;
  esac
}

# Resolve the requested orb type. Names match the provider's orb types in Amp;
# ORB_TYPE_<NAME>_{CPUS,MEMORY,SHM} override the defaults below.
key=$(printf '%s' "${ORB_TYPE:-default}" | tr '[:lower:]-' '[:upper:]_')
cpus_var="ORB_TYPE_${key}_CPUS"
mem_var="ORB_TYPE_${key}_MEMORY"
shm_var="ORB_TYPE_${key}_SHM"
req_cpus="${!cpus_var:-${ORB_CPUS:-2}}"
req_mem="${!mem_var:-${ORB_MEMORY:-3g}}"
req_shm="${!shm_var:-${ORB_SHM:-1g}}"

mem_total_mib=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
mem_budget="${MEM_BUDGET_MIB:-$((mem_total_mib - 1024))}"
cpu_budget="${CPU_BUDGET:-$(nproc)}"
req_mem_mib=$(to_mib "$req_mem")

MOUNTS=()
ENVS=()
if [ -d /data/pnpm-store ]; then
  MOUNTS+=(-v /data/pnpm-store:/data/pnpm-store)
  ENVS+=(-e npm_config_store_dir=/data/pnpm-store -e PNPM_STORE_DIR=/data/pnpm-store)
fi
if [ -d /data/npm-cache ]; then
  MOUNTS+=(-v /data/npm-cache:/root/.npm)
  ENVS+=(-e npm_config_cache=/data/npm-cache)
fi
if [ -d /data/ms-playwright ] && [ -n "$(ls -A /data/ms-playwright 2>/dev/null)" ]; then
  MOUNTS+=(-v /data/ms-playwright:/data/ms-playwright:ro)
  ENVS+=(-e PLAYWRIGHT_BROWSERS_PATH=/data/ms-playwright)
fi

case "$ORB_OPERATION" in
  spawn)
    if ! docker container inspect "$ORB_ID" >/dev/null 2>&1; then
      count=$(docker ps -aq --filter 'name=^amp-' | wc -l | tr -d ' ')
      if [ "$count" -ge "$MAX_ORBS" ]; then
        echo "orb limit reached: ${count}/${MAX_ORBS} containers" >&2
        exit 1
      fi
      free=$(min_free_gib)
      if [ "$free" -lt 8 ]; then
        docker builder prune -f >/dev/null 2>&1 || true
        docker image prune -f >/dev/null 2>&1 || true
        free=$(min_free_gib)
      fi
      if [ "$free" -lt "$MIN_FREE_GIB" ]; then
        echo "low disk: ${free} GiB free, need ${MIN_FREE_GIB} GiB" >&2
        exit 1
      fi
      used_cpu=$(docker ps -aq --filter 'name=^amp-' | xargs -r docker inspect -f '{{.HostConfig.NanoCpus}}' 2>/dev/null | awk '{s+=$1/1e9} END{printf "%.2f", s+0}')
      used_mem=$(docker ps -aq --filter 'name=^amp-' | xargs -r docker inspect -f '{{.HostConfig.Memory}}' 2>/dev/null | awk '{s+=$1} END{printf "%d", s/1024/1024}')
      if ! awk -v u="$used_cpu" -v r="$req_cpus" -v c="$cpu_budget" 'BEGIN{exit !(u+r<=c)}'; then
        echo "cpu budget: used ${used_cpu} + ${req_cpus} > ${cpu_budget}" >&2
        exit 1
      fi
      if ! awk -v u="$used_mem" -v r="$req_mem_mib" -v c="$mem_budget" 'BEGIN{exit !(u+r<=c)}'; then
        echo "memory budget: used ${used_mem} MiB + ${req_mem_mib} MiB > ${mem_budget} MiB" >&2
        exit 1
      fi
    fi
    image="$ORB_IMAGE"
    docker image inspect "${ORB_SNAPSHOT_ID-}" >/dev/null 2>&1 && image="$ORB_SNAPSHOT_ID"
    docker start "$ORB_ID" 2>/dev/null ||
      docker run --init --platform linux/amd64 -d --name "$ORB_ID" \
        --cpus "$req_cpus" \
        --memory "$req_mem" \
        --memory-swap "$req_mem" \
        --shm-size "$req_shm" \
        "${MOUNTS[@]}" "${ENVS[@]}" \
        "$image" sleep infinity
    env_args=(--env ORB_TOKEN)
    [ -z "${AMP_URL-}" ] || env_args+=(--env AMP_URL)
    docker exec -d "${ENVS[@]}" "${env_args[@]}" "$ORB_ID" amp orb bootstrap
    ;;
  pause)
    if docker container inspect "$ORB_ID" >/dev/null 2>&1; then
      docker stop "$ORB_ID"
    fi
    ;;
  delete)
    docker rm -f "$ORB_ID" >/dev/null 2>&1 || true
    [ -z "${ORB_SNAPSHOT_ID-}" ] || docker rmi "$ORB_SNAPSHOT_ID" >/dev/null 2>&1 || true
    ;;
esac
