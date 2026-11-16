import { render } from "solid-js/web"
import { App } from "./app.tsx"
import { trackMotion } from "./lib/motion.ts"
import "./plugins/registry.ts"
import "./styles/app.css"

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
render(() => <App />, root)
