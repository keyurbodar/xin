import type { IconName } from "../components/ui/icon.tsx"

const PROJECT_ICONS: readonly IconName[] = ["users", "file", "folder", "layers", "grid", "brain"]

/** A project's mark, chosen from its slug so the sidebar and the card always agree. */
export function projectIcon(slug: string): IconName {
  let hash = 0
  for (const char of slug) hash = (hash + char.charCodeAt(0)) % PROJECT_ICONS.length
  return PROJECT_ICONS[hash] ?? "folder"
}
