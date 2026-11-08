import { For, onMount, Show, createEffect, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { connect } from "../state/connection.ts"
import { homeLoaded, homeProjects, type ProjectSummary, type ThreadSummary } from "../state/home.ts"
import {
  agentModelOf,
  agentThinkingOf,
  createConversationView,
  entryBatchRows,
  parseHistoryPage,
  type AnsweredView,
  type EntryView,
  type RequestRow,
  type ThinkingLevel,
} from "../state/conversation.ts"
import { cmd, uploadFile } from "../lib/api.ts"
import { loadRequests, openRequests, refreshRequests, respondToQuestion } from "../state/requests.ts"
import { modelName, models, searchModels, type ModelInfo, type ModelRef } from "../state/settings.ts"
import { presets as presetStore, prompts } from "../state/extensions.ts"
import { expandSlash } from "../lib/slash.ts"
import { mediaQuery } from "../lib/media.ts"
import { navigate, param } from "../lib/router.ts"
import { TopBar } from "../components/shell/topbar.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { Skullet } from "../components/ui/skeleton.tsx"
import { ProjectGlyph, projectState } from "../components/chat/project-glyph.tsx"
import { Transcript, TranscriptSkeleton, type PendingMessage } from "../components/chat/transcript.tsx"
import { Composer } from "../components/chat/composer.tsx"
import { ProjectPanel } from "../components/chat/panel.tsx"
import { ProjectSettings } from "../components/project/settings.tsx"
import { BottomSheet, RightDrawer } from "../components/shell/sheet.tsx"
import { FileScreen } from "./file.tsx"
import { RunScreen } from "./run.tsx"
import { Button, EmptyState } from "../components/chat/ui.tsx"

function ProjectChat(props: { project: ProjectSummary }): JSX.Element {
  const streams = connect()
  const snapshot = createConversationView(streams, () => props.project.coordinatorId)
  const [threadId, setThreadId] = createSignal<number | undefined>()
  const [sheetOpen, setSheetOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const docked = mediaQuery("(min-width: 1280px)")
  const overlay = mediaQuery("(min-width: 1024px)")
  const [panelOpen, setPanelOpen] = createSignal(true)
  const [optimistic, setOptimistic] = createSignal<readonly PendingMessage[]>([])
  const [answered, setAnswered] = createSignal<readonly AnsweredView[]>([])
  const [older, setOlder] = createSignal<readonly EntryView[]>([])
  const [olderBefore, setOlderBefore] = createSignal<number | undefined>(undefined)
  const [olderDone, setOlderDone] = createSignal(false)
  onMount(() => {
    loadRequests()
    void prompts.reload()
    void presetStore.reload()
  })
  createEffect(() => {
    void props.project.openRequests
    void refreshRequests()
  })

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
    setThreadId(undefined)
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
  const thread = createMemo<ThreadSummary | undefined>(() => {
    const id = threadId()
    if (id === undefined) return undefined
    const groups = props.project.threads
    const all = [...groups.working, ...groups.waiting, ...groups.completed, ...groups.failed, ...groups.cancelled]
    return all.find((candidate) => candidate.id === id)
  })

  const openThread = (id: number): void => {
    setThreadId(id)
    if (docked()) setPanelOpen(true)
    else setSheetOpen(true)
  }
  const togglePanel = (): void => {
    if (docked()) setPanelOpen((open) => !open)
    else setSheetOpen(true)
  }

  return (
    <>
      <TopBar
        leading={<ProjectGlyph slug={props.project.slug} name={props.project.name} goal={props.project.goal} state={projectState(props.project)} />}
        title={props.project.name}
        subtitle={props.project.goal === undefined || props.project.goal === "" ? "" : `· ${props.project.goal}`}
        actions={
          <>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Project settings"
              class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
            >
              <Icon name="more" size={15} />
            </button>
            <button
              type="button"
              onClick={togglePanel}
              aria-label={docked() && panelOpen() ? "Hide the panel" : "Open the project panel"}
              class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
              classList={{ "bg-selected text-fg": docked() && panelOpen() }}
            >
              <Icon name="panel" size={15} />
            </button>
          </>
        }
      />
      <div class="flex min-h-0 flex-1">
        <div class="flex min-w-0 flex-1 flex-col [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-1 [&>div:first-child]:flex-col">
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
                  onOpenThread={openThread}
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
        <Show when={docked() && panelOpen()}>
          <ProjectPanel
            project={props.project}
            streams={streams}
            open
            thread={thread()}
            requests={projectRequests()}
            answered={answered()}
            onAnswer={answer}
            onOpenThread={openThread}
            onCloseThread={() => setThreadId(undefined)}
          />
        </Show>
      </div>
      <Show when={overlay() && !docked()}>
        <RightDrawer open={sheetOpen()} onClose={() => setSheetOpen(false)} label="Project panel">
          <ProjectPanel
            variant="drawer"
            project={props.project}
            streams={streams}
            open
            onClose={() => setSheetOpen(false)}
            thread={thread()}
            requests={projectRequests()}
            answered={answered()}
            onAnswer={answer}
            onOpenThread={openThread}
            onCloseThread={() => setThreadId(undefined)}
          />
        </RightDrawer>
      </Show>
      <Show when={!overlay()}>
        <BottomSheet open={sheetOpen()} onClose={() => setSheetOpen(false)} label="Project panel">
          <ProjectPanel
            variant="sheet"
            project={props.project}
            streams={streams}
            open
            onClose={() => setSheetOpen(false)}
            thread={thread()}
            requests={projectRequests()}
            answered={answered()}
            onAnswer={answer}
            onOpenThread={openThread}
            onCloseThread={() => setThreadId(undefined)}
          />
        </BottomSheet>
      </Show>
      <ProjectSettings
        project={props.project}
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        onArchived={() => navigate("/")}
      />
    </>
  )
}

function busier(snapshot: { readonly docs: Readonly<Record<string, unknown>> }): boolean {
  const live = snapshot.docs["pi.live"]
  if (typeof live !== "object" || live === null) return false
  return "run" in live && live.run !== undefined
}

export function ProjectScreen(): JSX.Element {
  onMount(() => void models.reload())
  const slug = (): string | undefined => param(1)
  const project = createMemo<ProjectSummary | undefined>(() => {
    const wanted = slug()
    return wanted === undefined ? undefined : homeProjects().find((candidate) => candidate.slug === wanted)
  })
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
    <Show
      when={project()}
      fallback={
        <>
          <TopBar title="Project" />
          <div class="min-h-0 flex-1 overflow-y-auto">
            <Skullet loading={!homeLoaded()} sample={() => <ProjectSkeleton />} label="Loading project">
              <div class="pt-16">
                <EmptyState
                  pictogram="folder"
                  title="Project not found"
                  detail={`No project at #/p/${slug() ?? "…"}.`}
                  action={
                    <Button variant="ghost" onClick={() => navigate("/")}>
                      Back home
                    </Button>
                  }
                />
              </div>
            </Skullet>
          </div>
        </>
      }
    >
      {(resolved) => (
        <Show
          when={filePath()}
          fallback={
            <Show when={runId()} fallback={<ProjectChat project={resolved()} />}>
              {(id) => <RunScreen project={resolved()} conversationId={id()} />}
            </Show>
          }
        >
          {(path) => <FileScreen project={resolved()} path={path()} />}
        </Show>
      )}
    </Show>
  )
}

function ProjectSkeleton(): JSX.Element {
  return (
    <div class="flex min-h-full flex-col">
      <div class="flex h-12 items-center gap-2.5 border-b border-line px-4">
        <span class="h-6 w-6 rounded-[2px] border border-line-inner bg-raised" />
        <span class="h-3 w-32 rounded-[1px] bg-hover" />
        <span class="ml-2 h-2.5 w-56 rounded-[1px] bg-hover" />
        <span class="ml-auto h-7 w-28 rounded-[2px] border border-line-inner bg-raised" />
      </div>
      <div class="flex min-h-0 flex-1">
        <div class="min-w-0 flex-1">
          <TranscriptSkeleton />
        </div>
        <div class="hidden w-[400px] border-l border-line bg-surface min-[1280px]:block min-[1440px]:w-[440px]">
          <div class="flex h-12 items-center gap-3 border-b border-line px-3">
            <For each={["Threads", "Files", "Memory", "Schedules", "Jobs"]}>
              {(label) => <span class="text-[12.5px] text-fg-4">{label}</span>}
            </For>
          </div>
          <div class="px-3 pt-3">
            <div class="h-2.5 w-24 rounded-[1px] bg-hover" />
          </div>
        </div>
      </div>
    </div>
  )
}
