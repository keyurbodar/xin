import { compareVersions, satisfies } from "../../src/semver.ts"
import { isSemver } from "./marketindex.ts"

export type PackageKind = "bundle" | "code"

export type MarketStatus = "not-installed" | "installed" | "update-available" | "different-version" | "provided"

export type InstalledFact = { readonly kind: "provided" } | { readonly kind: "installed"; readonly version?: string }

export type VersionFact = { readonly version: string; readonly engines?: { readonly xin?: string } }

export function kindOf(xin: unknown): PackageKind | undefined {
  if (!isRecord(xin)) return undefined
  if (xin["plugins"] !== undefined) return "code"
  if (xin["bundle"] !== undefined) return "bundle"
  return undefined
}

export function compatible(version: VersionFact, xinVersion: string): boolean {
  const range = version.engines?.xin
  return range === undefined || satisfies(xinVersion, range)
}

export function offeredVersion<T extends VersionFact>(versions: readonly T[], xinVersion: string): T | undefined {
  const newest = versions.toSorted((left, right) => compareVersions(right.version, left.version))
  return newest.find((version) => compatible(version, xinVersion)) ?? newest[0]
}

export function installationOf(offered: string, fact: InstalledFact | undefined): MarketStatus {
  if (fact === undefined) return "not-installed"
  if (fact.kind === "provided") return "provided"
  const installed = fact.version
  if (installed === undefined) return "different-version"
  if (installed === offered) return "installed"
  const newer = isSemver(installed) && compareVersions(offered, installed) > 0
  return newer ? "update-available" : "different-version"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
