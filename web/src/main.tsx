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

for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) link.dataset.entry = ""
window.ingleBooted = true
const search = location.search.replace(/[?&]boot=\d+/, "").replace(/^&/, "?")
if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash)

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
render(() => <App />, root)
