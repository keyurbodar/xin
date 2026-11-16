/** Refuses two discovered packages with one name, so no package can stand in for a first-party one by its name alone. */
export function assertUniquePackages(found: readonly { readonly pkg: string; readonly at: string }[]): void {
  const packages = new Map<string, string>()
  for (const entry of found) {
    const other = packages.get(entry.pkg)
    if (other !== undefined)
      throw new Error(`package ${entry.pkg} is found at both ${other} and ${entry.at}; package names must be unique`)
    packages.set(entry.pkg, entry.at)
  }
}
