import { type JSX } from "solid-js"
import { TopBar } from "../components/shell/topbar.tsx"

export function SettingsScreen(): JSX.Element {
  return (
    <>
      <TopBar title="Settings" />
      <div class="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <p class="text-fg-3">Building.</p>
      </div>
    </>
  )
}
