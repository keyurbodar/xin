import { render } from "solid-js/web"
import { App } from "./app.tsx"
import { trackMotion } from "./lib/motion.ts"
import "./plugins/registry.ts"
import "./styles/app.css"

declare global {
  interface Window {
    ingleBooted?: boolean
  }
}

const entryCss = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
for (const link of entryCss) link.dataset.entry = ""
window.ingleBooted = true
const settled = (): boolean => entryCss.every((link) => (link.sheet?.cssRules.length ?? 0) > 0)
addEventListener(
  "load",
  () => {
    if (!settled()) return
    const search = location.search.replace(/[?&]boot=\d+/, "").replace(/^&/, "?")
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash)
  },
  { once: true },
)

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
render(() => <App />, root)
