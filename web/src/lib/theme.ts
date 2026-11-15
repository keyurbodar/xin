import { createSignal } from "solid-js"

export type Theme = "dark" | "light"

const KEY = "ingle.theme"

const [theme_, setTheme_] = createSignal<Theme>(document.documentElement.dataset.theme === "light" ? "light" : "dark")

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
