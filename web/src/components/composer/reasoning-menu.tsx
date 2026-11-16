import "@ui-sdk/web/menu"
import { Check, ChevronDown, Layers } from "lucide-solid"
import { For, Show, createSignal, type JSX } from "solid-js"
import { isThinkingLevel, type ThinkingLevel } from "../../lib/thinking.ts"
import type { PresetRow } from "../../state/extensions.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM, POPUP_LABEL, POPUP_SEPARATOR } from "../ui/surface.ts"
import { TOOL } from "./styles.ts"

const LEVEL_LABEL: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

function Indicator(): JSX.Element {
  return (
    <ui-menu-item-indicator class="ml-auto grid w-4 place-items-center text-ink">
      <Check size={14} stroke-width={1.5} />
    </ui-menu-item-indicator>
  )
}

/** Reasoning effort for a reasoning model, and the conversation's preset as its one real mode, as menu radio groups. */
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
  const [open, setOpen] = createSignal(false)
  const { mounted, settle } = createOverlayMount(open)
  const reasoning = (): boolean => props.levels.length > 1
  const presetName = (): string =>
    props.presets.find((preset) => preset.id === props.presetId)?.name ?? props.presetId ?? "Preset"
  const label = (): string => (reasoning() ? (props.level === undefined ? "Default" : LEVEL_LABEL[props.level]) : presetName())
  const showModes = (): boolean => props.presets.length > 1

  return (
    <Show when={reasoning() || showModes()}>
      <ui-menu
        prop:open={open()}
        on:openchange={(event) => {
          event.preventDefault()
          const next = event.detail.value
          queueMicrotask(() => setOpen(next))
        }}
        on:openchangecomplete={settle}
      >
        <ui-menu-trigger>
          <button type="button" class={TOOL}>
            <span>{label()}</span>
            <ChevronDown size={14} stroke-width={1.5} class="text-icon" />
          </button>
        </ui-menu-trigger>
        <ui-menu-content side="top" align="start" side-offset="8" class={`${POPUP} w-[240px]`}>
          <Show when={mounted()}>
            <Show when={reasoning()}>
              <ui-menu-radio-group
                prop:value={props.level ?? null}
                on:valuechange={(event) => {
                  const value = event.detail.value
                  if (typeof value === "string" && isThinkingLevel(value)) props.onLevel(value)
                }}
              >
                <ui-menu-group-label class={POPUP_LABEL}>Reasoning</ui-menu-group-label>
                <For each={props.levels}>
                  {(level) => (
                    <ui-menu-radio-item value={level} class={POPUP_ITEM}>
                      <span class="flex-1">{LEVEL_LABEL[level]}</span>
                      <Indicator />
                    </ui-menu-radio-item>
                  )}
                </For>
              </ui-menu-radio-group>
              <Show when={props.level === undefined}>
                <div class="px-2 pb-1 text-mini text-ink-3">Using the model's own default</div>
              </Show>
            </Show>
            <Show when={showModes()}>
              <Show when={reasoning()}>
                <ui-menu-separator class={POPUP_SEPARATOR} />
              </Show>
              <ui-menu-radio-group prop:value={props.presetId ?? null} on:valuechange={(event) => {
                const value = event.detail.value
                if (typeof value === "string") props.onPreset(value)
              }}>
                <ui-menu-group-label class={POPUP_LABEL}>Modes</ui-menu-group-label>
                <For each={props.presets}>
                  {(preset) => (
                    <ui-menu-radio-item value={preset.id} disabled={props.presetLocked ? "" : undefined} class={POPUP_ITEM}>
                      <Layers size={16} stroke-width={1.5} class="shrink-0 text-icon" />
                      <span class="min-w-0 flex-1 truncate">{preset.name}</span>
                      <Indicator />
                    </ui-menu-radio-item>
                  )}
                </For>
              </ui-menu-radio-group>
              <Show when={props.presetLocked}>
                <div class="px-2 pb-1 pt-0.5 text-mini text-ink-3">The conversation has started, so its mode is fixed.</div>
              </Show>
            </Show>
          </Show>
        </ui-menu-content>
      </ui-menu>
    </Show>
  )
}
