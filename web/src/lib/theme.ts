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
