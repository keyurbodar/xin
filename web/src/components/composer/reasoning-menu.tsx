import { Menu } from "@ark-ui/solid/menu"
import { Check, ChevronDown, Layers } from "lucide-solid"
import { For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { THINKING_LEVELS, type ThinkingLevel } from "../../state/conversation.ts"
import type { PresetRow } from "../../state/extensions.ts"
import { GROUP_LABEL, ITEM, ITEM_ICON, SEPARATOR, SURFACE, TOOL } from "./styles.ts"

const LEVEL_LABEL: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

const isLevel = (value: string): value is ThinkingLevel => THINKING_LEVELS.some((level) => level === value)

/** Reasoning effort for a reasoning model, and the conversation's preset as its one real mode. */
export function ReasoningMenu(props: {
  /** The levels the current model accepts; one or none means it has no reasoning to choose. */
  levels: readonly ThinkingLevel[]
  level: ThinkingLevel | undefined
  presets: readonly PresetRow[]
  presetId: string | undefined
  presetLocked: boolean
  onLevel: (level: ThinkingLevel) => void
  onPreset: (id: string) => void
}): JSX.Element {
  const reasoning = (): boolean => props.levels.length > 1
  const presetName = (): string =>
    props.presets.find((preset) => preset.id === props.presetId)?.name ?? props.presetId ?? "Preset"
  const label = (): string => (reasoning() ? (props.level === undefined ? "Default" : LEVEL_LABEL[props.level]) : presetName())
  const showModes = (): boolean => props.presets.length > 1

  return (
    <Show when={reasoning() || showModes()}>
      <Menu.Root positioning={{ placement: "top-start", gutter: 8 }} lazyMount unmountOnExit>
        <Menu.Trigger class={TOOL}>
          <span>{label()}</span>
          <ChevronDown size={14} stroke-width={1.5} class="text-icon" />
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class={`${SURFACE} w-[240px] p-1`}>
              <Show when={reasoning()}>
                <Menu.RadioItemGroup
                  value={props.level ?? ""}
                  onValueChange={(details) => {
                    if (isLevel(details.value)) props.onLevel(details.value)
                  }}
                >
                  <Menu.ItemGroupLabel class={GROUP_LABEL}>Reasoning</Menu.ItemGroupLabel>
                  <For each={props.levels}>
                    {(level) => (
                      <Menu.RadioItem value={level} class={ITEM}>
                        <Menu.ItemText class="flex-1">{LEVEL_LABEL[level]}</Menu.ItemText>
                        <Menu.ItemIndicator>
                          <Check size={14} stroke-width={1.5} />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    )}
                  </For>
                </Menu.RadioItemGroup>
                <Show when={props.level === undefined}>
                  <div class="px-2 pb-1 text-xs text-ink-3">Using the model's own default</div>
                </Show>
              </Show>
              <Show when={showModes()}>
                <Show when={reasoning()}>
                  <Menu.Separator class={SEPARATOR} />
                </Show>
                <Menu.RadioItemGroup
                  value={props.presetId ?? ""}
                  onValueChange={(details) => props.onPreset(details.value)}
                >
                  <Menu.ItemGroupLabel class={GROUP_LABEL}>Modes</Menu.ItemGroupLabel>
                  <For each={props.presets}>
                    {(preset) => (
                      <Menu.RadioItem value={preset.id} disabled={props.presetLocked} class={ITEM}>
                        <Layers size={16} stroke-width={1.5} class={ITEM_ICON} />
                        <Menu.ItemText class="min-w-0 flex-1 truncate">{preset.name}</Menu.ItemText>
                        <Menu.ItemIndicator>
                          <Check size={14} stroke-width={1.5} />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    )}
                  </For>
                </Menu.RadioItemGroup>
                <Show when={props.presetLocked}>
                  <div class="px-2 pb-1 pt-0.5 text-xs leading-snug text-ink-3">
                    The conversation has started, so its mode is fixed.
                  </div>
                </Show>
              </Show>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Show>
  )
}
