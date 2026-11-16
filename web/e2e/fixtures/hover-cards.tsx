import "../../src/styles/app.css"
import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LinkChip } from "../../src/components/ui/link-chip.tsx"
import { MESSAGE_HOST, MessageToolbar } from "../../src/components/ui/message-toolbar.tsx"
import { RowCard } from "../../src/components/ui/row-card.tsx"

const loads: string[] = []
Object.assign(window, { loads })

const later =
  <T,>(value: T, ms = 600): (() => Promise<T>) =>
  () => {
    loads.push(JSON.stringify(value).slice(0, 40))
    return new Promise((resolve) => setTimeout(() => resolve(value), ms))
  }

function App() {
  const [log, setLog] = createSignal("")
  const [keep, setKeep] = createSignal(true)
  const [version, setVersion] = createSignal(1)
  Object.assign(window, { drop: () => setKeep(false), bump: () => setVersion((current) => current + 1) })
  return (
    <main class="flex flex-col gap-8 p-6 text-reading text-ink">
      <p id="prose" class="max-w-[640px]">
        The model lane's fixes are on main:{" "}
        <LinkChip
          kind="pr"
          state="merged"
          label="xin#54"
          href="#pr-54"
          load={later({
            repo: "keyurbodar/xin",
            number: 54,
            title: "models: owner compaction threshold as a share of the context window",
            state: "merged",
            additions: 114,
            deletions: 3,
            author: "keyur",
          })}
        />{" "}
        and{" "}
        <LinkChip
          kind="pr"
          state="open"
          label="xin#60"
          href="#pr-60"
          load={later({ repo: "keyurbodar/xin", number: 60, title: "docs: design system v2", state: "open", additions: 812, deletions: 40, author: "bosun" }, 0)}
        />
        . <LinkChip kind="thread" label="XIN-25" href="#xin-25" load={later({ code: "XIN-25", title: "Web UI v2: Linear and Palermo structure", project: "Ingle", status: "working" }, 0)} /> owns{" "}
        <LinkChip kind="issue" label="AMA-23" href="#ama-23" load={later({ key: "AMA-23", title: "Hover cards and link chips", state: "In progress" }, 0)} />, landed in{" "}
        <LinkChip kind="commit" label="418f19f" href="#418f19f" load={later({ sha: "418f19f2c0d1", message: "presets remove only tool extensions\n\nGoal tracking skips a storage read." }, 0)} /> and touches{" "}
        <LinkChip kind="file" label="web/src/styles/tokens.css" href="#tokens" load={later({ path: "web/src/styles/tokens.css", size: 6420 }, 0)} />.
      </p>

      <p id="drop">
        <Show when={keep()}>
          <LinkChip kind="issue" label="AMA-24" href="#ama-24" load={later({ key: "AMA-24", title: "Removed while open", state: "Todo" }, 0)} />
        </Show>{" "}
        <LinkChip
          kind="pr"
          state="open"
          label={version() === 1 ? "xin#7" : `xin#7 v${version()}`}
          href="#pr-7"
          load={later({ repo: "keyurbodar/xin", number: 7, title: `Title version ${version()}`, state: "open", additions: 1, deletions: 0, author: "keyur" }, 0)}
        />
      </p>

      <nav class="w-[240px]">
        <RowCard
          trigger={
            <button type="button" id="row" class="im-hover flex h-[var(--h-row-2)] w-full flex-col justify-center rounded-sm px-3 text-left">
              <span class="text-small text-ink">Atlas</span>
              <span class="text-mini text-ink-3">You don't need any mainnet</span>
            </button>
          }
          code="HOME-2"
          shortcut="⌥1"
          title="Atlas"
          project="Home"
          machine="build"
          model="Claude Opus 5.5"
          issues={[{ key: "AMA-22", title: "HealthBeat liquidation shield for Reactive Orders", href: "#ama-22" }]}
        />
      </nav>

      <button id="before-toolbar" type="button" class="sr-only">
        Before
      </button>
      <article id="message" class={`${MESSAGE_HOST} max-w-[640px] rounded-md px-3 py-4`}>
        <p>Next, the surfaces ship in order. Overlays and menus go first, then Drive, Issues, Automations and Captains.</p>
        <MessageToolbar
          time="9:04 AM"
          dateTime="2026-11-16T09:04:00+05:30"
          onReply={() => setLog("reply")}
          onCopy={() => setLog("copy")}
          onMore={() => setLog("more")}
        />
      </article>
      <output id="log">{log()}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
