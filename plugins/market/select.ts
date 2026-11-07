import { compareVersions, isPrerelease, satisfies } from "../../src/semver.ts"

export type PackageKind = "bundle" | "code"

export type SelectableVersion = {
  readonly version: string
  readonly deprecated?: string
  readonly engines?: { readonly xin?: string }
}

export type MarketStatus = "available" | "installed" | "update" | "pending" | "local" | "incompatible"

export type StatusInput = {
  readonly local?: boolean
  readonly installed?: { readonly version: string }
  readonly pending?: string
  readonly versions: readonly SelectableVersion[]
  readonly distTags?: Readonly<Record<string, string>>
  readonly xinVersion: string
}

export function kindOf(xin: unknown): PackageKind | undefined {
  if (!isRecord(xin)) return undefined
  if (xin["plugins"] !== undefined) return "code"
  if (xin["bundle"] !== undefined) return "bundle"
  return undefined
}

export function compatible(version: SelectableVersion, xinVersion: string): boolean {
  const range = version.engines?.xin
  return range === undefined || satisfies(xinVersion, range)
}

export function newestCompatible<T extends SelectableVersion>(
  versions: readonly T[],
  xinVersion: string,
): T | undefined {
  const allowed = versions.filter((version) => version.deprecated === undefined && compatible(version, xinVersion))
  const stable = allowed.filter((version) => !isPrerelease(version.version))
  return newest(stable.length === 0 ? allowed : stable)
}

export function offeredVersion<T extends SelectableVersion>(
  versions: readonly T[],
  distTags: Readonly<Record<string, string>>,
  xinVersion: string,
): T | undefined {
  const tag = distTags["latest"]
  if (tag !== undefined) {
    const tagged = versions.find((version) => version.version === tag)
    if (tagged !== undefined && tagged.deprecated === undefined && compatible(tagged, xinVersion)) return tagged
  }
  return newestCompatible(versions, xinVersion)
}

export function status(input: StatusInput): MarketStatus {
  if (input.local === true) return "local"
  if (input.pending !== undefined) return "pending"
  const latest = offeredVersion(input.versions, input.distTags ?? {}, input.xinVersion)
  if (latest === undefined) return "incompatible"
  const installed = input.installed
  if (installed === undefined) return "available"
  return compareVersions(latest.version, installed.version) > 0 ? "update" : "installed"
}

function newest<T extends SelectableVersion>(versions: readonly T[]): T | undefined {
  let found: T | undefined
  for (const version of versions) {
    if (found === undefined || compareVersions(version.version, found.version) > 0) found = version
  }
  return found
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
