export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

export const isThinkingLevel = (value: string): value is ThinkingLevel => THINKING_LEVELS.some((level) => level === value)

/** The level a model switch keeps: the same one when the model lists it, else the nearest lower one it lists, else its first. */
export function clampThinking(level: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  if (levels.includes(level)) return level
  const lower = THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level)).findLast((candidate) => levels.includes(candidate))
  return lower ?? levels[0]
}

type ModelChoice = { readonly provider: string; readonly modelId: string; readonly thinking: readonly ThinkingLevel[] }

/** One `conv.configure` for a model switch: the clamped level rides along only when the new model has reasoning to choose. */
export function modelSwitch(
  model: ModelChoice,
  current: ThinkingLevel | undefined,
): { readonly model: { readonly provider: string; readonly modelId: string }; readonly thinking?: ThinkingLevel } {
  const ref = { provider: model.provider, modelId: model.modelId }
  if (current === undefined || model.thinking.length < 2) return { model: ref }
  const thinking = clampThinking(current, model.thinking)
  return thinking === undefined ? { model: ref } : { model: ref, thinking }
}
