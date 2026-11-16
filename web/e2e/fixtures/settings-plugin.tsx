import "../../src/styles/app.css"
import { render } from "solid-js/web"
import type { SlotItem } from "../../src/plugins/slots.tsx"
import { SettingsScreen } from "../../src/screens/settings.tsx"

const pages: readonly SlotItem<"settings.page">[] = [
  {
    plugin: "broken",
    key: "broken:page",
    id: "page",
    title: "Broken settings",
    component: () => {
      throw new Error("the page threw")
    },
  },
  { plugin: "steady", key: "steady:page", id: "page", title: "Steady settings", component: () => <p id="steady">steady body</p> },
]

window.location.hash = "/settings/plugin/steady/page"
render(() => <SettingsScreen pages={() => pages} />, document.getElementById("app")!)
document.body.dataset.ready = "1"
