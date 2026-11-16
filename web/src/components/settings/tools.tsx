import "@ui-sdk/web/segmented-control"
import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { activeProjects } from "../../state/home.ts"
import { errorMessage, setToolPolicy, TOOL_MODES, toolPolicy, type ToolMode, type ToolPolicy } from "../../state/settings.ts"
import { Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Card, Group, Row, SelectField } from "./parts.tsx"

type Choice = ToolMode | "inherit"

const LABEL: Readonly<Record<Choice, string>> = { allow: "Allow", ask: "Ask", off: "Off", inherit: "Inherit" }

const PROJECT_CHOICES: readonly Choice[] = [...TOOL_MODES, "inherit"]

type Pick = { readonly tool: string; readonly choice: Choice }

export function Tools(): JSX.Element {
  const [scope, setScope] = createSignal<string | undefined>(undefined)
  const scopeName = (): string => activeProjects().find((project) => project.id === scope())?.name ?? "this project"

  return (
    <>
      <Group title="Scope" detail="A project's choice wins over Home's">
        <Card>
          <Row
            title="Applies to"
            detail={scope() === undefined ? "Every conversation, unless its project overrides it" : `Only conversations in ${scopeName()}`}
          >
            <SelectField
              ariaLabel="Applies to"
              placeholder="Home"
              value={scope() ?? ""}
              choices={activeProjects().map((project) => ({ value: project.id, label: project.name, group: "Projects" }))}
              onChange={(next) => setScope(next === "" ? undefined : next)}
            />
          </Row>
        </Card>
      </Group>
      <ToolModes projectId={scope()} />
    </>
  )
}

/** Every tool's mode for Home (`projectId` undefined) or one project, grouped by the plugin that adds it. */
export function ToolModes(props: { projectId: string | undefined }): JSX.Element {
  const [saving, setSaving] = createSignal<Pick | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const policy = () => toolPolicy(props.projectId)
  const inProject = (): boolean => props.projectId !== undefined

  createEffect(() => void policy().reload())

  const groups = (): readonly { readonly plugin: string; readonly tools: readonly ToolPolicy[] }[] => {
    const state = policy().state()
    if (state.kind !== "ready") return []
    const byPlugin = new Map<string, ToolPolicy[]>()
    for (const tool of state.value) byPlugin.set(tool.plugin, [...(byPlugin.get(tool.plugin) ?? []), tool])
    return [...byPlugin]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([plugin, tools]) => ({ plugin, tools }))
  }

  const chosen = (tool: ToolPolicy): Choice => {
    const pick = saving()
    if (pick?.tool === tool.name) return pick.choice
    return inProject() ? (tool.project ?? "inherit") : tool.home
  }

  const choose = async (tool: ToolPolicy, choice: Choice): Promise<void> => {
    setSaving({ tool: tool.name, choice })
    setError(undefined)
    try {
      await setToolPolicy(tool.name, choice, props.projectId)
    } catch (failure) {
      setError(`${tool.title}: ${errorMessage(failure)}`)
    } finally {
      setSaving(undefined)
    }
  }

  return (
    <>
      <Show when={error()}>{(message) => <Failure message={message()} />}</Show>
      <Show when={policy().state().kind === "loading"}>
        <Pending label="Reading tools" />
      </Show>
      <Show when={failureOf(policy().state())}>
        {(message) => <Failure message={message()} onRetry={() => void policy().reload()} />}
      </Show>
      <Show when={policy().state().kind === "ready" && groups().length === 0}>
        <p class="py-6 text-center text-small text-ink-3">No plugin adds a tool yet.</p>
      </Show>

      <For each={groups()}>
        {(group) => (
          <Group title={group.plugin}>
            <Card>
              <For each={group.tools}>
                {(tool) => (
                  <ToolLine
                    tool={tool}
                    project={inProject()}
                    choice={chosen(tool)}
                    saving={saving()?.tool === tool.name}
                    busy={saving() !== undefined}
                    onChoose={(choice) => void choose(tool, choice)}
                  />
                )}
              </For>
            </Card>
          </Group>
        )}
      </For>

      <Note>
        Ask stops each call until you pick Approve, Always allow or Deny in the conversation. Off takes the tool away from
        the agent. Inherit drops the project's choice, so Home's applies again.
      </Note>
    </>
  )
}

function ToolLine(props: {
  tool: ToolPolicy
  project: boolean
  choice: Choice
  saving: boolean
  busy: boolean
  onChoose: (choice: Choice) => void
}): JSX.Element {
  const inherited = (choice: Choice): boolean => props.choice === "inherit" && choice === props.tool.home
  const detail = (): string => {
    if (!props.project) return props.tool.name
    const home = LABEL[props.tool.home]
    return props.choice === "inherit"
      ? `${props.tool.name} · Inherits ${home} from Home`
      : `${props.tool.name} · Home is ${home}`
  }
  const choices = (): readonly Choice[] => (props.project ? PROJECT_CHOICES : TOOL_MODES)

  return (
    <Row title={props.tool.title} detail={detail()}>
      <div class="flex items-center gap-2.5">
        <Show when={props.saving}>
          <span class="text-mini text-ink-3">Saving</span>
        </Show>
        <ui-segmented-control
          aria-label={`${props.tool.title} mode`}
          attr:data-tool={props.tool.name}
          prop:value={props.choice}
          disabled={props.busy ? "" : undefined}
          on:valuechange={(event: CustomEvent<{ value: unknown }>) => {
            const next = choices().find((choice) => choice === event.detail.value)
            if (next !== undefined && next !== props.choice) props.onChoose(next)
          }}
          class="flex h-[var(--h-control-sm)] items-center gap-0.5 rounded-sm bg-secondary p-0.5 shadow-ring"
        >
          <For each={choices()}>
            {(choice) => (
              <ui-segmented-control-item
                value={choice}
                attr:data-inherited={inherited(choice) ? "" : undefined}
                title={inherited(choice) ? `${LABEL[choice]}, inherited from Home` : undefined}
                class="flex h-full min-w-11 cursor-default items-center justify-center rounded-xs px-2 text-small text-ink-3 outline-none transition-colors duration-100 hover:text-ink focus-visible:shadow-[0_0_0_2px_var(--color-primary-soft)] data-[checked]:bg-card data-[checked]:text-ink data-[checked]:shadow-ring data-[disabled]:opacity-50 data-[inherited]:text-ink-2 data-[inherited]:outline data-[inherited]:outline-1 data-[inherited]:-outline-offset-1 data-[inherited]:outline-dashed data-[inherited]:outline-line-3 [&[value=inherit]]:ml-1.5"
              >
                {LABEL[choice]}
              </ui-segmented-control-item>
            )}
          </For>
        </ui-segmented-control>
      </div>
    </Row>
  )
}
