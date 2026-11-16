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
void Promise.all(
  entryCss.map((link) =>
    link.sheet === null
      ? new Promise((resolve, reject) => {
          link.addEventListener("load", resolve, { once: true })
          link.addEventListener("error", reject, { once: true })
        })
      : undefined,
  ),
).then(
  () => {
    const search = location.search.replace(/[?&]boot=\d+/, "").replace(/^&/, "?")
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash)
  },
  () => undefined,
)

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
render(() => <App />, root)
