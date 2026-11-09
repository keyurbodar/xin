import { Show, type JSX } from "solid-js"
import { activeProjects } from "../../state/home.ts"
import { navigate, route } from "../../lib/router.ts"
import { Icon, type IconName } from "../ui/icon.tsx"

export function TabBar(): JSX.Element {
  const first = () => route().parts[0]
  const needsYou = (): boolean =>
    activeProjects().some(
      (project) => project.openRequests > 0 || project.threads.waiting.length > 0 || project.threads.failed.length > 0,
    )

  return (
    <nav class="flex h-[76px] shrink-0 items-start gap-0 border-t border-line bg-surface px-3 pb-6 pt-2 lg:hidden">
      <Tab icon="home" label="Home" active={first() === undefined} onClick={() => navigate("/")} />
      <Tab icon="inbox" label="Inbox" active={first() === "inbox"} onClick={() => navigate("/inbox")} dot={needsYou()} />
      <Tab icon="grid" label="Extensions" active={first() === "extensions"} onClick={() => navigate("/extensions")} />
      <Tab icon="settings" label="Settings" active={first() === "settings"} onClick={() => navigate("/settings/general")} />
    </nav>
  )
}

function Tab(props: { icon: IconName; label: string; active: boolean; dot?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex flex-1 flex-col items-center gap-0.5 pt-1 text-[10.5px]"
      classList={{ "text-fg": props.active, "text-fg-3": !props.active }}
    >
      <span class="relative">
        <Icon name={props.icon} size={18} />
        <Show when={props.dot === true}>
          <span class="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-[1px] bg-accent" />
        </Show>
      </span>
      {props.label}
    </button>
  )
}
