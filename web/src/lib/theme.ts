import { createSignal } from "solid-js"

export type Scheme = "dark" | "light" | "rose"

export type ThemeChoice = {
  readonly id: string
  readonly label: string
  readonly scheme: Scheme
  readonly tokens: Readonly<Record<string, string>>
}

export const DEFAULT_THEME: ThemeChoice = { id: "dark", label: "Dark", scheme: "dark", tokens: {} }

export const BUILT_IN_THEMES: readonly ThemeChoice[] = [
  DEFAULT_THEME,
  { id: "light", label: "Light", scheme: "light", tokens: {} },
  { id: "rose", label: "Rose", scheme: "rose", tokens: {} },
]

const KEY = "ingle.theme"
const SCHEME_KEY = "ingle.theme.scheme"

const [theme_, setTheme_] = createSignal(localStorage.getItem(KEY) ?? "dark")

export const theme = theme_

let painted: readonly string[] = []

export function paintTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  for (const property of painted) root.style.removeProperty(property)
  const next: string[] = []
  for (const [token, value] of Object.entries(choice.tokens)) {
    root.style.setProperty(`--color-${token}`, value)
    next.push(`--color-${token}`)
  }
  painted = next
  root.dataset.theme = choice.scheme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", getComputedStyle(root).getPropertyValue("--color-bg").trim())
}

export function setTheme(choice: ThemeChoice): void {
  localStorage.setItem(KEY, choice.id)
  localStorage.setItem(SCHEME_KEY, choice.scheme)
  setTheme_(choice.id)
  paintTheme(choice)
}

export type MotionChoice = "system" | "reduce"

const MOTION_KEY = "ingle.motion"

export function motionOf(value: string | undefined | null): MotionChoice {
  return value === "reduce" ? "reduce" : "system"
}

const [motion_, setMotion_] = createSignal<MotionChoice>(motionOf(document.documentElement.dataset.motion))

export const motionChoice = motion_

/** System leaves the attribute off, so the motion file's own prefers-reduced-motion query decides. */
export function setMotionChoice(next: MotionChoice): void {
  if (next === "reduce") {
    document.documentElement.dataset.motion = "reduce"
    localStorage.setItem(MOTION_KEY, next)
  } else {
    delete document.documentElement.dataset.motion
    localStorage.removeItem(MOTION_KEY)
  }
  setMotion_(next)
}
