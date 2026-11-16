import { render } from "solid-js/web"
import { App } from "./app.tsx"
import { registerBlock } from "./components/chat/blocks.tsx"
import { CARD_TOOLS } from "./components/chat/interactive-cards.tsx"
import { trackMotion } from "./lib/motion.ts"
import "./plugins/registry.ts"
import "./styles/app.css"

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
trackMotion()
for (const [tool, Card] of Object.entries(CARD_TOOLS)) registerBlock(`tool:${tool}`, (call) => <Card {...call} />)
render(() => <App />, root)
