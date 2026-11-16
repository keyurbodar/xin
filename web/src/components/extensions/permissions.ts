import type { MarketDetail } from "../../state/extensions.ts"

const SENTENCES: ReadonlyMap<string, string> = new Map(Object.entries({
  secrets: "Reads and changes the keys and passwords you have saved",
  files: "Reads and changes your files, including those in your Drive",
  storage: "Keeps its own data in your Home",
  routes: "Answers web requests sent to your Home",
  models: "Uses AI models, which spends your tokens",
  conversations: "Reads and writes your conversations",
  plugins: "Installs, switches on and sets up other plugins",
  network: "Says it connects to websites and services on the internet (Ingle can’t stop this)",
  runtime: "Has full access to your Home, including its data, keys and files",
  owner: "Acts as you, such as starting threads on your behalf",
}))

export const permissionSentence = (id: string): string =>
  SENTENCES.get(id) ?? `Uses a permission this app does not describe yet: “${id}”`

export function packageLines(detail: Pick<MarketDetail, "kind" | "rows" | "requires">): readonly string[] {
  const lines: string[] = []
  if (detail.kind === "code") lines.push("Runs its own code in your Home, with your authority")
  else lines.push("Configures plugins already in this build; adds no code")
  lines.push(
    detail.rows.length === 0
      ? "Mounts no plugin rows of its own"
      : `Mounts ${detail.rows.length} plugin ${detail.rows.length === 1 ? "row" : "rows"}, which you can switch off`,
  )
  if (detail.requires.length > 0) lines.push(`Also records ${detail.requires.join(", ")}`)
  lines.push("Asks before it uses anything that needs your consent")
  return lines
}
