import { render } from "solid-js/web"
import { App } from "./app.tsx"
import "./plugins/registry.ts"
import "./styles/app.css"
import "./styles/status.css"

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
render(() => <App />, root)
