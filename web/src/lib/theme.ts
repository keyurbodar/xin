import { createSignal } from "solid-js"

export type Theme = "dark" | "light" | "rose"

const KEY = "ingle.theme"

export function themeOf(value: string | undefined | null): Theme {
  return value === "light" || value === "rose" ? value : "dark"
}

const [theme_, setTheme_] = createSignal<Theme>(themeOf(document.documentElement.dataset.theme))

export const theme = theme_

export function setTheme(next: Theme): void {
  document.documentElement.dataset.theme = next
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim(),
  )
  localStorage.setItem(KEY, next)
  setTheme_(next)
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
