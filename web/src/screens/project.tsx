import { createEffect, createMemo, createResource, createSignal, onMount, Show, type JSX } from "solid-js"
import { connect } from "../state/connection.ts"
import {
  homeLoaded,
  projectThreads,
  routeProject,
  routeThreadId,
  type ProjectSummary,
  type ThreadSummary,
} from "../state/home.ts"
import {
  agentModelOf,
  agentThinkingOf,
  createConversationView,
  entryBatchRows,
  parseHistoryPage,
  type AnsweredView,
  type EntryView,
  type RequestRow,
  type Snapshot,
  type ThinkingLevel,
} from "../state/conversation.ts"
import { cmd, uploadFile } from "../lib/api.ts"
import { recordOf, numOf } from "../lib/parse.ts"
import { openRequests, refreshRequests, respondToQuestion } from "../state/requests.ts"
import { modelName, models, searchModels, type ModelInfo, type ModelRef } from "../state/settings.ts"
import { presets as presetStore, prompts } from "../state/extensions.ts"
import { Menu } from "lucide-solid"
import {
  openThreadTab,
  paneOpen,
  projectTabs,
  pruneThreadTabs,
  sidebarHidden,
  toggleSidebar,
  wideShell,
} from "../state/tabs.ts"
import { ICON_BUTTON } from "../components/shell/menu.ts"
import { createPresence } from "../components/shell/presence.ts"
import { expandSlash } from "../lib/slash.ts"
import { mediaQuery } from "../lib/media.ts"
import { navigate, param } from "../lib/router.ts"
import { Skullet } from "../components/ui/skeleton.tsx"
import { Transcript, TranscriptSkeleton, type PendingMessage } from "../components/chat/transcript.tsx"
import { Composer } from "../components/chat/composer.tsx"
import { ThreadConversation } from "../components/chat/panel.tsx"
import { ConversationTabs } from "../components/shell/conversation-tabs.tsx"
import { ProjectPane } from "../components/pane/pane.tsx"
import { ProjectSettings } from "../components/project/settings.tsx"
import { FileScreen } from "./file.tsx"
import { RunScreen } from "./run.tsx"
import { Button, EmptyState } from "../components/chat/ui.tsx"

function ProjectChat(props: { project: ProjectSummary; snapshot: Snapshot | undefined; onOpenThread: (id: number) => void }): JSX.Element {
  const snapshot = (): Snapshot | undefined => props.snapshot
  const [optimistic, setOptimistic] = createSignal<readonly PendingMessage[]>([])
  const [answered, setAnswered] = createSignal<readonly AnsweredView[]>([])
  const [older, setOlder] = createSignal<readonly EntryView[]>([])
  const [olderBefore, setOlderBefore] = createSignal<number | undefined>(undefined)
  const [olderDone, setOlderDone] = createSignal(false)
  const projectRequests = (): readonly RequestRow[] =>
    openRequests().filter((request) => request.projectId === props.project.id)

  const answer = async (request: RequestRow, text: string): Promise<void> => {
    await respondToQuestion(request, text)
    setAnswered((current) => [
      ...current,
      {
        conversationId: request.conversationId,
        question: request.question,
        answer: text,
        answeredAt: Date.now(),
      },
    ])
  }

  createEffect(() => {
    void props.project.id
    setOptimistic([])
    setAnswered([])
    setOlder([])
    setOlderBefore(undefined)
    setOlderDone(false)
  })

  const loadOlder = async (): Promise<void> => {
    const value = snapshot()
    if (value === undefined) return
    const before = olderBefore() ?? value.before
    if (before === undefined) return
    const page = parseHistoryPage(
      await cmd<unknown>("history.page", { conversationId: props.project.coordinatorId, before, limit: 60 }),
    )
    setOlder((current) => [...page.entries, ...current])
    if (page.entries.length === 0 || page.nextBefore === undefined) setOlderDone(true)
    else setOlderBefore(page.nextBefore)
  }

  const hasOlder = (): boolean => {
    const value = snapshot()
    return value !== undefined && !olderDone() && (olderBefore() !== undefined || value.before !== undefined)
  }

  // The owner bubble is optimistic; once the intake batch appears in the transcript, the real row takes over.
  createEffect(() => {
    const value = snapshot()
    if (value === undefined) return
    const sent = value.entries.flatMap(entryBatchRows).filter((row) => row.kind === "user")
    if (sent.length === 0) return
    setOptimistic((current) => {
      const next = current.filter(
        (message) =>
          !sent.some(
            (row) =>
              row.text === message.text &&
              (row.clientTs ?? 0) >= message.at - 2_000 &&
              row.attachments.length === message.attachments.length,
          ),
      )
      return next.length === current.length ? current : next
    })
  })

  const chosenModel = (): ModelRef | undefined => agentModelOf(snapshot())
  const catalog = (): readonly ModelInfo[] => {
    const state = models.state()
    return state.kind === "ready" ? state.value.models : []
  }
  const [modelQuery, setModelQuery] = createSignal("")
  const [pickerModels] = createResource(modelQuery, searchModels)
  const choices = (): readonly ModelInfo[] => pickerModels.latest?.models ?? catalog()
  const currentInfo = (): ModelInfo | undefined => {
    const ref = chosenModel()
    if (ref === undefined) return undefined
    return choices().find((model) => model.provider === ref.provider && model.modelId === ref.modelId)
  }
  const presetRows = () => {
    const state = presetStore.state()
    return state.kind === "ready" ? state.value.presets : []
  }
  const presetId = (): string | undefined => {
    const state = presetStore.state()
    if (state.kind !== "ready") return undefined
    const found = state.value.conversations.find((entry) => entry.conversation === props.project.coordinatorId)
    return found?.preset ?? state.value.default
  }
  const started = (): boolean => {
    const value = snapshot()
    return value !== undefined && value.entries.length > 0
  }
  const modelLabel = (): string => {
    const ref = chosenModel()
    if (ref === undefined) return "Default model"
    return modelName(ref.provider, ref.modelId) ?? ref.modelId
  }
  const busy = (): boolean => {
    const value = snapshot()
    return value !== undefined && busier(value)
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-1 [&>div:first-child]:flex-col">
      <Skullet loading={snapshot() === undefined} sample={() => <TranscriptSkeleton />} label="Loading conversation">
        <Show when={snapshot()}>
          {(value) => (
            <Transcript
              snapshot={value()}
              project={props.project}
              optimistic={optimistic()}
              older={older()}
              hasOlder={hasOlder()}
              requests={projectRequests()}
              answered={answered()}
              onOpenThread={props.onOpenThread}
              onAnswer={answer}
              onRetry={async (entryId) => {
                await cmd("message.retry", { entryId })
              }}
              onLoadOlder={loadOlder}
            />
          )}
        </Show>
      </Skullet>
          <Composer
            projectName={props.project.name}
            modelLabel={modelLabel()}
            model={chosenModel()}
            models={choices()}
            omitted={pickerModels.latest?.omitted ?? 0}
            query={modelQuery()}
            onSearch={setModelQuery}
            busy={busy()}
            presets={presetRows()}
            presetId={presetId()}
            presetLocked={started()}
            effort={agentThinkingOf(snapshot())}
            reasoning={currentInfo()?.reasoning === true}
            onPickModel={async (model) => {
              await cmd("conv.configure", { conv: props.project.coordinatorId, model })
            }}
            onPickPreset={async (preset) => {
              await cmd("preset.select", { conversation: props.project.coordinatorId, preset })
              await presetStore.reload()
            }}
            onPickEffort={async (thinking: ThinkingLevel) => {
              await cmd("conv.configure", { conv: props.project.coordinatorId, thinking })
            }}
            onAttach={(file, onProgress) => uploadFile(file, `/projects/${props.project.slug}/attachments`, onProgress)}
            onSend={async (text, key, attachments) => {
              const loaded = prompts.state()
              const expanded = expandSlash(text, loaded.kind === "ready" ? loaded.value : [])
              const result = await cmd<{ readonly accepted: boolean }>(
                "message.send",
                {
                  conv: props.project.coordinatorId,
                  text: expanded,
                  clientTs: key.at,
                  ...(attachments.length === 0 ? {} : { attachments }),
                },
                { id: key.id },
              )
              if (result.accepted) {
                setOptimistic((current) => [...current, { key: key.id, text: expanded, at: key.at, attachments }])
              }
            }}
            onStop={async () => {
              await cmd("conv.stop", { conv: props.project.coordinatorId })
            }}
          />
    </div>
  )
}

function busier(snapshot: { readonly docs: Readonly<Record<string, unknown>> }): boolean {
  const live = snapshot.docs["pi.live"]
  if (typeof live !== "object" || live === null) return false
  return "run" in live && live.run !== undefined
}

/** The conversation's own spend: every model and tool bucket of its `pi.usage` ledger. */
function costOf(snapshot: Snapshot | undefined): number | undefined {
  const usage = recordOf(snapshot?.docs["pi.usage"])
  if (usage === undefined) return undefined
  const buckets = [...Object.values(recordOf(usage.models) ?? {}), ...Object.values(recordOf(usage.tools) ?? {})]
  return buckets.reduce<number>((sum, bucket) => sum + (numOf(recordOf(recordOf(bucket)?.cost)?.total) ?? 0), 0)
}

function ProjectWorkspace(props: { project: ProjectSummary }): JSX.Element {
  const streams = connect()
  const docked = mediaQuery("(min-width: 1280px)")
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const sheet = createPresence(() => paneOpen() && !docked() && !expanded(), 180)
  const threads = createMemo(() => new Map(projectThreads(props.project).map((thread) => [thread.id, thread])))
  const thread = (): ThreadSummary | undefined => {
    const id = routeThreadId()
    return id === undefined ? undefined : threads().get(id)
  }
  const tabThreads = (): readonly ThreadSummary[] =>
    projectTabs(props.project.id).threads.flatMap((id) => {
      const found = threads().get(id)
      return found === undefined ? [] : [found]
    })
  const snapshot = createConversationView(streams, () => thread()?.id ?? props.project.coordinatorId)

  createEffect(() => {
    const current = thread()
    if (current !== undefined) openThreadTab(props.project.id, current.id)
  })
  createEffect(() => pruneThreadTabs(props.project.id, new Set(threads().keys())))
  onMount(() => {
    void prompts.reload()
    void presetStore.reload()
  })
  createEffect(() => {
    void props.project.openRequests
    void refreshRequests()
  })

  const openThread = (id: number): void => {
    openThreadTab(props.project.id, id)
    navigate(`/p/${props.project.slug}/t/${id}`)
  }
  const paneShown = createMemo(() => paneOpen() || sheet.mounted())
  const pane = createMemo(() =>
    paneShown() ? (
      <ProjectPane project={props.project} expanded={expanded()} onExpand={setExpanded} onOpenThread={openThread} />
    ) : undefined,
  )
  const filePath = (): string | undefined => {
    if (param(2) !== "files" || param(3) === undefined) return undefined
    try {
      return decodeURIComponent(param(3) ?? "")
    } catch {
      return undefined
    }
  }
  const runId = (): number | undefined => {
    if (param(2) !== "run") return undefined
    const parsed = Number(param(3))
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }

  return (
    <div class="relative flex min-h-0 flex-1 gap-2">
      <Show when={!(expanded() && paneOpen())}>
        <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-panel shadow-ring">
          <ConversationTabs
            project={props.project}
            threads={tabThreads()}
            activeThreadId={thread()?.id}
            cost={costOf(snapshot())}
            onSettings={() => setSettingsOpen(true)}
          />
          <Show
            when={filePath()}
            fallback={
              <Show
                when={runId()}
                fallback={
                  <Show
                    when={thread()?.id}
                    keyed
                    fallback={<ProjectChat project={props.project} snapshot={snapshot()} onOpenThread={openThread} />}
                  >
                    {(_id) => (
                      <Show when={thread()}>
                        {(current) => (
                          <ThreadConversation
                            project={props.project}
                            thread={current()}
                            snapshot={snapshot()}
                            onOpenThread={openThread}
                          />
                        )}
                      </Show>
                    )}
                  </Show>
                }
              >
                {(id) => <RunScreen project={props.project} conversationId={id()} />}
              </Show>
            }
          >
            {(path) => <FileScreen project={props.project} path={path()} />}
          </Show>
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
      <ProjectSettings
        project={props.project}
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        onArchived={() => navigate("/")}
      />
    </div>
  )
}

export function ProjectScreen(): JSX.Element {
  onMount(() => void models.reload())
  return (
    <Show
      when={routeProject()?.id}
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
          <Skullet loading={!homeLoaded()} sample={() => <TranscriptSkeleton />} label="Loading project">
            <div class="pt-16">
              <Show
                when={param(0) === "p"}
                fallback={
                  <EmptyState
                    pictogram="folder"
                    title="No projects yet"
                    detail="A project is one coordinator chat and the threads it starts."
                    action={<Button onClick={() => navigate("/new")}>New project</Button>}
                  />
                }
              >
                <EmptyState
                  pictogram="folder"
                  title="Project not found"
                  detail={`No project at #/p/${param(1) ?? "…"}.`}
                  action={
                    <Button variant="ghost" onClick={() => navigate("/")}>
                      Open the first project
                    </Button>
                  }
                />
              </Show>
            </div>
          </Skullet>
        </section>
      }
    >
      {(_id) => <Show when={routeProject()}>{(project) => <ProjectWorkspace project={project()} />}</Show>}
    </Show>
  )
}
