import type { JSX } from "solid-js"
import { projectGlyph, PROJECT_GLYPHS, type ProjectGlyphName } from "../../lib/project-glyphs.ts"
import type { VisualState } from "../../lib/status.ts"

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

/** The sidebar's tile: the glyph, with the project's state on the corner. */
export function ProjectGlyph(props: {
  slug: string
  name?: string | undefined
  goal?: string | undefined
  state?: VisualState | undefined
  size?: number | undefined
  class?: string | undefined
}): JSX.Element {
  const size = (): number => props.size ?? 24
  return (
    <span
      class={`relative grid shrink-0 place-items-center rounded-[8px] border border-line-inner bg-raised text-fg-2 ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <ProjectMark slug={props.slug} name={props.name} goal={props.goal} size={Math.round(size() * 0.62)} />
      <Corner state={props.state} />
    </span>
  )
}

export function Corner(props: { state: VisualState | undefined }): JSX.Element {
  return (
    <span
      class="absolute -top-[3px] -right-[3px] h-1.5 w-1.5 rounded-[4px] border border-page"
      classList={{
        "bg-fg breath": props.state === "working",
        "bg-waiting pulse": props.state === "waiting",
        "bg-bad": props.state === "failed",
        hidden: props.state === undefined || !["working", "waiting", "failed"].includes(props.state),
      }}
    />
  )
}

/** The one state a project's tile shows: someone waits, then something failed, then work is running. */
export function projectState(project: {
  readonly openRequests: number
  readonly threads: {
    readonly working: readonly unknown[]
    readonly waiting: readonly unknown[]
    readonly failed: readonly unknown[]
  }
}): VisualState | undefined {
  if (project.openRequests > 0 || project.threads.waiting.length > 0) return "waiting"
  if (project.threads.failed.length > 0) return "failed"
  if (project.threads.working.length > 0) return "working"
  return undefined
}
