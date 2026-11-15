import type { JSX } from "solid-js"
import { projectGlyph, PROJECT_GLYPHS, type ProjectGlyphName } from "../../lib/project-glyphs.ts"
import type { SignalState } from "../../lib/status.ts"

/** I3: a compass-and-ruler glyph on a 24 grid, one stroke weight, at most one solid part. */
export function ProjectMark(props: {
  glyph?: ProjectGlyphName | undefined
  slug?: string | undefined
  name?: string | undefined
  goal?: string | undefined
  size?: number | undefined
  class?: string | undefined
}): JSX.Element {
  const glyph = (): ProjectGlyphName =>
    props.glyph ?? projectGlyph(props.slug ?? "", props.name ?? "", props.goal ?? "")
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={`project-mark ${props.class ?? ""}`}
      aria-hidden="true"
      innerHTML={PROJECT_GLYPHS[glyph()]}
    />
  )
}

/** The project's tile: its glyph on a card. */
export function ProjectGlyph(props: {
  slug: string
  name?: string | undefined
  goal?: string | undefined
  size?: number | undefined
  class?: string | undefined
}): JSX.Element {
  const size = (): number => props.size ?? 24
  return (
    <span
      class={`grid shrink-0 place-items-center rounded-sm border border-line-2 bg-card text-ink-2 ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <ProjectMark slug={props.slug} name={props.name} goal={props.goal} size={Math.round(size() * 0.62)} />
    </span>
  )
}

/** The one Signal a project row shows: someone waits, then something failed, then work is running. */
export function projectState(project: {
  readonly openRequests: number
  readonly threads: {
    readonly working: readonly unknown[]
    readonly waiting: readonly unknown[]
    readonly failed: readonly unknown[]
  }
}): SignalState | undefined {
  if (project.openRequests > 0 || project.threads.waiting.length > 0) return "needs"
  if (project.threads.failed.length > 0) return "failed"
  if (project.threads.working.length > 0) return "working"
  return undefined
}
