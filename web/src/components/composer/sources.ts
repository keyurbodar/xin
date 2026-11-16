import { createEffect, createSignal, on, type Accessor } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { listOf, recordOf, strOf } from "../../lib/parse.ts"
import { prompts, skills, type Remote } from "../../state/extensions.ts"
import { projectThreads, type ProjectSummary } from "../../state/home.ts"
import type { ComposerToken, TokenKind } from "./tokens.ts"

/** One row a menu offers: the chip it inserts and a detail line to tell rows apart. */
export type Suggestion = { readonly token: ComposerToken; readonly detail: string }

export type Sources = {
  readonly list: (kind: TokenKind) => readonly Suggestion[]
  readonly load: () => void
}

function parseFiles(value: unknown, root: string): readonly Suggestion[] {
  return listOf(value).flatMap((entry) => {
    const path = strOf(recordOf(entry)?.path)
    if (path === undefined) return []
    const relative = path.startsWith(root) ? path.slice(root.length) : path
    const cut = relative.lastIndexOf("/")
    const folder = cut === -1 ? "" : relative.slice(0, cut)
    if (folder === "attachments" || folder.startsWith("attachments/")) return []
    return [{ token: { kind: "file", value: path, label: relative.slice(cut + 1) }, detail: folder }]
  })
}

/** What the + menu and the @ and / menus offer for a project: its threads, files, skills and prompts. */
export function createSources(project: Accessor<ProjectSummary>): Sources {
  const [files, setFiles] = createSignal<readonly Suggestion[]>([])
  createEffect(on(() => project().slug, () => setFiles([])))

  const ready = <T>(state: Remote<readonly T[]>): readonly T[] => (state.kind === "ready" ? state.value : [])

  const list = (kind: TokenKind): readonly Suggestion[] => {
    switch (kind) {
      case "thread":
        return projectThreads(project()).map((thread) => ({
          token: { kind, value: String(thread.id), label: thread.title },
          detail: thread.status,
        }))
      case "file":
        return files()
      case "skill":
        return ready(skills.state()).map((skill) => ({
          token: { kind, value: skill.name, label: skill.name },
          detail: skill.description,
        }))
      case "prompt":
        return ready(prompts.state()).map((prompt) => ({
          token: { kind, value: prompt.name, label: prompt.name },
          detail: prompt.description ?? "",
        }))
      default: {
        const _exhaustive: never = kind
        return _exhaustive
      }
    }
  }

  const load = (): void => {
    void skills.reload()
    void prompts.reload()
    const slug = project().slug
    cmd<unknown>("file.list", { prefix: `/projects/${slug}` })
      .then((value) => {
        if (project().slug === slug) setFiles(parseFiles(value, `/projects/${slug}/`))
      })
      .catch(() => {
        if (project().slug === slug) setFiles([])
      })
  }

  return { list, load }
}
