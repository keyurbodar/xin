import { createMemo, createResource, For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
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
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_LABEL } from "../shell/menu.ts"
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
            <span class="min-w-0 truncate text-sm text-ink">{props.member.title}</span>
            <Show when={props.member.run > 1}>
              <span class="shrink-0 font-mono text-2xs text-icon">run {props.member.run}</span>
            </Show>
            <Show when={props.model}>
              {(model) => (
                <span class="ml-auto min-w-0 max-w-[45%] truncate font-mono text-2xs text-ink-3" title={model()}>
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
        <Menu.Root
          lazyMount
          unmountOnExit
          positioning={{ placement: "bottom-end", gutter: 6 }}
          onSelect={(details) => void action.run("add", () => addToCrew(props.captain.id, Number(details.value)))}
        >
          <Menu.Trigger class={ICON_BUTTON} aria-label="Add a thread to the crew" disabled={action.busy() !== undefined}>
            <UserPlus size={14} stroke-width={1.5} />
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content class={`${MENU_CONTENT} max-h-[360px] w-[280px] overflow-y-auto`}>
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel class={MENU_LABEL}>Add from this project</Menu.ItemGroupLabel>
                  <For each={candidates()} fallback={<span class="block px-2 py-1.5 text-sm text-ink-3">No other threads</span>}>
                    {(thread) => (
                      <Menu.Item value={String(thread.id)} class={MENU_ITEM}>
                        <Signal state={visualState(thread.status)} size={14} class="shrink-0" />
                        <Menu.ItemText class="flex-1 truncate">{thread.title}</Menu.ItemText>
                      </Menu.Item>
                    )}
                  </For>
                </Menu.ItemGroup>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
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
