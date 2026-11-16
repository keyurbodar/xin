import { render } from "solid-js/web"
import { App } from "./app.tsx"
import { registerBlock } from "./components/chat/blocks.tsx"
import { VisualBlock } from "./components/chat/visual-block.tsx"
import { trackMotion } from "./lib/motion.ts"
import "./plugins/registry.ts"
import "./styles/app.css"

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
registerBlock("tool:show_visual", (call) => <VisualBlock {...call} />)
render(() => <App />, root)
