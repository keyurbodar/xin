import { createEffect, createMemo, on, createSignal, onMount, Show, type JSX } from "solid-js"
import { GitFork, Menu, Settings } from "lucide-solid"
import { navigate } from "../lib/router.ts"
import { mediaQuery } from "../lib/media.ts"
import { connect } from "../state/connection.ts"
import { agentModelOf, createConversationView, type Snapshot } from "../state/conversation.ts"
import { homeLoaded, homeRequests, projectThreads, type ProjectSummary, type ThreadSummary } from "../state/home.ts"
import { captainSpace, routeCaptain, routeCrewThreadId } from "../state/captains.ts"
import { offersSideThread, type CaptainRow } from "../lib/captains.ts"
import { models } from "../state/settings.ts"
import { presets, prompts } from "../state/extensions.ts"
import { requestsKey } from "../lib/requests.ts"
import { refreshRequests } from "../state/requests.ts"
import { openThreadTab, openThreadTabs, paneOpen, pruneThreadTabs, sidebarHidden, toggleSidebar, wideShell } from "../state/tabs.ts"
import { ICON_BUTTON } from "../components/shell/menu.ts"
import { createPresence } from "../components/shell/presence.ts"
import { ConversationTabs, type ConversationAction } from "../components/shell/conversation-tabs.tsx"
import { SideThreadDialog } from "../components/shell/side-thread.tsx"
import { ThreadConversation } from "../components/chat/panel.tsx"
import { ProjectPane } from "../components/pane/pane.tsx"
import { CaptainAvatar } from "../components/captain/avatar.tsx"
import { CaptainSettings } from "../components/captain/captain-dialog.tsx"
import { Loading, ThreadSkeleton } from "../components/ui/skeleton.tsx"
import { Button, EmptyState } from "../components/chat/ui.tsx"
import { costOf, ProjectChat } from "./project.tsx"

const SETTINGS_ACTION: ConversationAction = { value: "settings", label: "Captain settings", icon: Settings }
const SIDE_ACTION: ConversationAction = { value: "side", label: "Side thread…", icon: GitFork }

/** A Captain is a coordinator with a space of its own, so its screen is the project workspace over that space. */
function CaptainWorkspace(props: { captain: CaptainRow; space: ProjectSummary }): JSX.Element {
  const streams = connect()
  const docked = mediaQuery("(min-width: 1280px)")
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [sideOpen, setSideOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const sheet = createPresence(() => paneOpen() && !docked() && !expanded(), 180)
  const base = (): string => `/c/${props.captain.alias}`
  const threads = createMemo(() => new Map(projectThreads(props.space).map((thread) => [thread.id, thread])))
  const thread = (): ThreadSummary | undefined => {
    const id = routeCrewThreadId()
    return id === undefined ? undefined : threads().get(id)
  }
  const tabThreads = (): readonly ThreadSummary[] =>
    openThreadTabs(props.space.id).flatMap((id) => {
      const found = threads().get(id)
      return found === undefined ? [] : [found]
    })
  const snapshot = createConversationView(streams, () => thread()?.id ?? props.captain.coordinatorId)
  const onCoordinator = (): boolean => thread() === undefined
  const coordinatorSnapshot = createMemo<Snapshot | undefined>((last) => (thread() === undefined ? snapshot() : last))

  createEffect(() => {
    const current = thread()
    if (current !== undefined) openThreadTab(props.space.id, current.id)
  })
  createEffect(() => pruneThreadTabs(props.space.id, new Set(threads().keys())))
  const requestsDependOn = createMemo(() => requestsKey(props.space, homeRequests()))
  createEffect(on(requestsDependOn, () => void refreshRequests()))

  const openThread = (id: number): void => {
    openThreadTab(props.space.id, id)
    navigate(`${base()}/t/${id}`)
  }
  const paneShown = createMemo(() => paneOpen() || sheet.mounted())
  const pane = createMemo(() =>
    paneShown() ? (
      <ProjectPane
        project={props.space}
        captain={props.captain}
        conversationId={thread()?.id ?? props.captain.coordinatorId}
        expanded={expanded()}
        onExpand={setExpanded}
        onOpenThread={openThread}
      />
    ) : undefined,
  )
  return (
    <div class="relative flex min-h-0 flex-1 gap-2">
      <Show when={!(expanded() && paneOpen())}>
        <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-panel shadow-ring">
          <ConversationTabs
            project={props.space}
            base={base()}
            mark={<CaptainAvatar name={props.captain.name} size={16} />}
            threads={tabThreads()}
            activeThreadId={thread()?.id}
            cost={costOf(snapshot())}
            actions={offersSideThread(agentModelOf(coordinatorSnapshot())) ? [SETTINGS_ACTION, SIDE_ACTION] : [SETTINGS_ACTION]}
            onAction={(value) => (value === "side" ? setSideOpen(true) : setSettingsOpen(true))}
          />
          <Show when={thread()?.id} keyed>
            {(_id) => (
              <Show when={thread()}>
                {(current) => (
                  <ThreadConversation project={props.space} thread={current()} snapshot={snapshot()} onOpenThread={openThread} />
                )}
              </Show>
            )}
          </Show>
          <div class="flex min-h-0 flex-1 flex-col" classList={{ hidden: !onCoordinator() }}>
            <ProjectChat project={props.space} snapshot={coordinatorSnapshot()} active={onCoordinator()} onOpenThread={openThread} />
          </div>
        </section>
      </Show>
      <Show when={paneOpen() && (docked() || expanded())}>
        <div
          class="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg bg-panel shadow-ring"
          classList={{ "w-[var(--w-pane)]": !expanded(), "flex-1": expanded() }}
        >
          {pane()}
        </div>
      </Show>
      <Show when={sheet.mounted()}>
        <div
          class="im-sheet absolute inset-y-0 right-0 z-40 flex w-[min(var(--w-pane),100%)] flex-col overflow-hidden rounded-lg bg-panel shadow-overlay"
          classList={{ "pointer-events-none": sheet.leaving() }}
          data-state={sheet.leaving() ? "closed" : "open"}
        >
          {pane()}
        </div>
      </Show>
      <CaptainSettings captain={props.captain} open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <SideThreadDialog
        open={sideOpen()}
        conv={props.captain.coordinatorId}
        name={props.captain.name}
        onClose={() => setSideOpen(false)}
        onCreated={openThread}
      />
    </div>
  )
}

/** The catalog, prompts and presets load once for the screen, so switching Captains reads none of them again. */
export function CaptainScreen(): JSX.Element {
  onMount(() => {
    void models.reload()
    void prompts.reload()
    void presets.reload()
  })
  return (
    <Show
      when={routeCaptain()?.id}
      keyed
      fallback={
        <section class="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg bg-panel shadow-ring">
          <Show when={!wideShell() || sidebarHidden()}>
            <div class="flex h-[var(--h-topbar)] shrink-0 items-center border-b border-line-1 px-2">
              <button type="button" class={ICON_BUTTON} aria-label="Open the sidebar" onClick={toggleSidebar}>
                <Menu size={16} stroke-width={1.5} />
              </button>
            </div>
          </Show>
          <Loading when={!homeLoaded()} skeleton={<ThreadSkeleton />} label="Loading Captain">
            <div class="pt-16">
              <EmptyState
                pictogram="threads"
                title="Captain not found"
                detail="No live Captain has this alias. It may have been archived or renamed."
                action={
                  <Button variant="ghost" onClick={() => navigate("/")}>
                    Open the first project
                  </Button>
                }
              />
            </div>
          </Loading>
        </section>
      }
    >
      {(_id) => (
        <Show when={routeCaptain()}>
          {(captain) => (
            <Show when={captainSpace(captain())}>{(space) => <CaptainWorkspace captain={captain()} space={space()} />}</Show>
          )}
        </Show>
      )}
    </Show>
  )
}
