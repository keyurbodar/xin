import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { ArrowUpRight, UserMinus, UserPlus } from "lucide-solid"
import { ago } from "../../lib/format.ts"
import { STATE_WORD, visualState } from "../../lib/status.ts"
import { addToCrew, captainDetail, homeCaptains, removeFromCrew } from "../../state/captains.ts"
import { crewOf } from "../../lib/captains.ts"
import type { CaptainProfile, CrewMember } from "../../lib/captains.ts"
import { homeProjects, projectThreads, type ProjectSummary, type ThreadSummary } from "../../state/home.ts"
import { showPaneView } from "../../state/tabs.ts"
import { Signal } from "../ui/signal.tsx"
import { createPaneAction, EmptyState } from "../chat/ui.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { loadOnIntent } from "../../lib/ui-sdk-lazy.ts"
import { POPUP, POPUP_ITEM, POPUP_LABEL } from "../ui/surface.ts"
import { PANE_ROW } from "./bodies.tsx"
import { Section } from "./overview.tsx"

const OVERVIEW_ROWS = 6

type CrewContext = { readonly project: ProjectSummary; readonly captain: CaptainProfile; readonly onOpenThread: (id: number) => void }

type CrewRead = { readonly crew: readonly CrewMember[]; readonly at: number }

/** The crew comes from the home stream's space threads, so no update costs a command. */
function createCrew(context: () => CrewContext): () => CrewRead {
  return createMemo(() => {
    const at = Date.now()
    return { crew: crewOf(context().project.threads, at), at }
  })
}

function CrewRow(props: { member: CrewMember; at: number; onOpen: (id: number) => void; onRemove?: (() => void) | undefined; busy?: boolean; model?: string | undefined }): JSX.Element {
  const state = () => visualState(props.member.status)
  return (
    <div class="group relative">
      <button type="button" onClick={() => props.onOpen(props.member.threadId)} class={PANE_ROW}>
        <Signal state={state()} size={16} class="mt-0.5 shrink-0" />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex items-baseline gap-1.5">
            <span class="truncate text-sm text-ink">{props.member.title}</span>
            <Show when={props.member.run > 1}>
              <span class="shrink-0 font-mono text-2xs text-icon">run {props.member.run}</span>
            </Show>
            <Show when={props.model}>
              {(model) => (
                <span class="ml-auto shrink-0 truncate font-mono text-2xs text-ink-3" title="Model and thinking level">
                  {model()}
                </span>
              )}
            </Show>
          </span>
          <span class="truncate text-xs text-ink-3" classList={{ "im-shimmer": state() === "working" }}>
            {props.member.statusLine ?? STATE_WORD[state()]}
          </span>
          <Show when={props.member.report}>
            {(text) => <span class="line-clamp-2 text-xs text-ink-2">{text()}</span>}
          </Show>
        </span>
        <span class="shrink-0 font-mono text-2xs text-ink-3" title="Idle since the last heartbeat">
          {ago(props.at - props.member.idleMs)}
        </span>
      </button>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            aria-label={`Remove ${props.member.title} from the crew`}
            title="Remove from the crew"
            disabled={props.busy === true}
            onClick={() => remove()()}
            class={`${ICON_BUTTON} absolute right-1 top-1 bg-panel opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50`}
          >
            <UserMinus size={14} stroke-width={1.5} />
          </button>
        )}
      </Show>
    </div>
  )
}

export function CrewSection(props: CrewContext & { label: string }): JSX.Element {
  const crew = createCrew(() => props)
  const rows = (): readonly CrewMember[] => crew().crew
  return (
    <Section
      label={props.label}
      count={rows().length}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="Open Crew" onClick={() => showPaneView(props.project.id, "crew")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For
        each={rows().slice(0, OVERVIEW_ROWS)}
        fallback={<span class="px-2 py-1.5 text-sm text-ink-3">No crew yet</span>}
      >
        {(member) => <CrewRow member={member} at={crew().at} onOpen={props.onOpenThread} />}
      </For>
    </Section>
  )
}

export function CrewView(props: CrewContext): JSX.Element {
  const crew = createCrew(() => props)
  const action = createPaneAction()
  const crewKey = () => `${props.captain.id}:${crew().crew.map((member) => `${member.threadId}.${member.run}`).join(",")}`
  const [detail] = createResource(crewKey, () => captainDetail(props.captain.id))
  const candidates = createMemo((): readonly ThreadSummary[] => {
    const captainSpaces = new Set(homeCaptains().map((captain) => captain.spaceId))
    const project = homeProjects().find((entry) => entry.id === props.captain.projectId)
    return (project?.spaces ?? [])
      .filter((space) => !captainSpaces.has(space.id))
      .flatMap((space) => projectThreads(space))
  })

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2 px-2 pb-1">
        <span class="flex-1 text-xs text-ink-3">Threads {props.captain.name} runs. Their reports reach its chat in batches.</span>
        <AddToCrew candidates={candidates()} busy={action.busy() !== undefined} onAdd={(id) => void action.run("add", () => addToCrew(props.captain.id, id))} />
      </div>
      <Show when={action.failed()}>
        {(text) => <span class="px-2 pb-1 text-xs text-failed">{text()}</span>}
      </Show>
      <Show
        when={crew().crew.length > 0}
        fallback={
          <EmptyState
            pictogram="threads"
            title="No crew yet"
            detail={`Threads ${props.captain.name} starts join its crew. You can also add one from this project.`}
          />
        }
      >
        <For each={crew().crew}>
          {(member) => (
            <CrewRow
              member={member}
              at={crew().at}
              onOpen={props.onOpenThread}
              busy={action.busy() === member.threadId}
              model={detail.latest?.crewModels[member.threadId]}
              onRemove={() => void action.run(member.threadId, () => removeFromCrew(props.captain.id, member.threadId))}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

/** The trigger stays focusable while an add is in flight, so focus returns to it, but the menu won't open. */
function AddToCrew(props: { candidates: readonly ThreadSummary[]; busy: boolean; onAdd: (id: number) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const content = createOverlayMount(open)
  return (
    <ui-menu
      on:openchange={(event) => {
        if (event.detail.value && props.busy) {
          event.preventDefault()
          return
        }
        setOpen(event.detail.value)
      }}
      on:openchangecomplete={content.settle}
      on:action={(event) => props.onAdd(Number(event.detail.value))}
    >
      <ui-menu-trigger>
        <button
          type="button"
          class={`${ICON_BUTTON} aria-expanded:bg-hover aria-expanded:text-ink aria-disabled:opacity-50`}
          aria-label="Add a thread to the crew"
          title="Add a thread to the crew"
          aria-disabled={props.busy ? "true" : undefined}
          {...loadOnIntent("menu")}
        >
          <UserPlus size={14} stroke-width={1.5} />
        </button>
      </ui-menu-trigger>
      <ui-menu-content side="bottom" align="end" side-offset="6" class={`${POPUP} max-h-[360px] w-[280px]`}>
        <Show when={content.mounted()}>
          <ui-menu-group>
            <ui-menu-group-label class={POPUP_LABEL}>Add from this project</ui-menu-group-label>
            <For each={props.candidates} fallback={<span class="block px-2 py-1.5 text-small text-ink-3">No other threads</span>}>
              {(thread) => (
                <ui-menu-item value={String(thread.id)} label={thread.title} class={POPUP_ITEM}>
                  <Signal state={visualState(thread.status)} size={14} class="shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{thread.title}</span>
                </ui-menu-item>
              )}
            </For>
          </ui-menu-group>
        </Show>
      </ui-menu-content>
    </ui-menu>
  )
}
