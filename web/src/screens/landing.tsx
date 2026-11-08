import { For, Show, type JSX } from "solid-js"
import { Button } from "../components/ui/button.tsx"
import { Icon, type IconName } from "../components/ui/icon.tsx"
import { StatusGlyph } from "../components/ui/status-glyph.tsx"
import { Wordmark } from "../components/onboarding/chrome.tsx"
import { navigate } from "../lib/router.ts"
import type { VisualState } from "../lib/status.ts"

type DemoThread = {
  readonly title: string
  readonly line: string
  readonly state: VisualState
  readonly elapsed: string
}

const THREADS: readonly DemoThread[] = [
  { title: "Read 214 HubSpot deals", line: "Pulling open Q4 deals", state: "working", elapsed: "0:40" },
  { title: "Find deals that slipped", line: "Comparing with Oct 28", state: "working", elapsed: "0:35" },
  { title: "Draft owner nudges", line: "Writing note 3 of 11", state: "working", elapsed: "0:30" },
  { title: "Post the report", line: "Waits for the drafts", state: "queued", elapsed: "—" },
]

const PROJECTS: readonly { readonly name: string; readonly icon: IconName; readonly dot: "working" | "waiting" | "none" }[] = [
  { name: "Q4 pipeline", icon: "sliders", dot: "working" },
  { name: "Onboarding", icon: "inbox", dot: "waiting" },
  { name: "Invoices", icon: "file", dot: "none" },
  { name: "Lisbon trip", icon: "link", dot: "none" },
]

type Feature = { readonly icon: IconName; readonly title: string; readonly detail: string }

const FEATURES: readonly Feature[] = [
  {
    icon: "inbox",
    title: "A coordinator chat",
    detail: "One chat per project. It answers, starts threads, and posts what came back.",
  },
  {
    icon: "layers",
    title: "Parallel threads",
    detail: "Each one has a live status line and a timer. Open, steer, stop or re-run any of them.",
  },
  { icon: "folder", title: "Files", detail: "A library with previews. Documents the agents write land here too." },
  {
    icon: "brain",
    title: "Memory",
    detail: "What it remembers, per project and everywhere. You can read, edit and forget any of it.",
  },
  {
    icon: "calendar",
    title: "Schedules in plain words",
    detail: "“Every weekday at 5pm, post what changed.” It reads it back and shows the next runs.",
  },
  { icon: "sliders", title: "Cost you can see", detail: "Usage per project and per model, with a daily limit you set." },
]

const PACKAGES: readonly { readonly icon: IconName; readonly name: string; readonly detail: string; readonly kind: string }[] = [
  { icon: "calendar", name: "Calendar tools", detail: "Find a slot, draft invites", kind: "Instant" },
  { icon: "file", name: "PDF tools", detail: "Read, split and fill PDFs", kind: "Needs a build" },
  { icon: "folder", name: "Ledger sync", detail: "Stripe and QuickBooks payments", kind: "Instant" },
  { icon: "link", name: "Travel tools", detail: "Track fares, hold seats", kind: "Instant" },
]

const QUESTIONS: readonly { readonly question: string; readonly answer: string }[] = [
  {
    question: "Which models does it use?",
    answer:
      "Any model in the catalog, from any provider you add a key for. Pick one per project or per conversation, switch mid-chat, and set the effort level.",
  },
  {
    question: "Does work stop when I close the tab?",
    answer:
      "No. Projects run durably in the cloud. Close the laptop and the threads keep going, then report back when they’re done.",
  },
  {
    question: "What does it cost?",
    answer:
      "You pay your model provider directly for what you use. Usage and cost show per project and per model, and you can set a daily limit.",
  },
  {
    question: "Can it act on my tools?",
    answer: "Only the ones you connect. Every connector and package says what it can reach before you install it.",
  },
  {
    question: "What happens when something fails?",
    answer:
      "The failure shows up in the chat and the panel with what broke and a Retry button. Nothing fails silently.",
  },
]

const DISPLAY = "font-display font-normal leading-[1.06] tracking-[-0.03em]"

export function LandingScreen(): JSX.Element {
  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div class="h-full overflow-y-auto bg-page text-fg">
      <nav class="sticky top-0 z-10 border-b border-line bg-page/85 backdrop-blur-md">
        <div class="mx-auto flex h-16 max-w-[1200px] items-center gap-8 px-5 md:px-10">
          <button type="button" onClick={() => scrollTo("top")} aria-label="Top">
            <Wordmark />
          </button>
          <div class="hidden items-center gap-8 text-[14px] text-fg-3 md:flex">
            <button type="button" class="hover:text-fg-2" onClick={() => scrollTo("product")}>
              Product
            </button>
            <button type="button" class="hover:text-fg-2" onClick={() => scrollTo("extensions")}>
              Extensions
            </button>
            <span class="text-fg-4">Docs</span>
            <span class="text-fg-4">Changelog</span>
          </div>
          <div class="ml-auto flex items-center gap-2">
            <Button size="md" variant="quiet" onClick={() => navigate("/")}>
              Sign in
            </Button>
            <Button size="md" variant="primary" onClick={() => navigate("/welcome")}>
              Start a project
            </Button>
          </div>
        </div>
      </nav>

      <main id="top">
        <section class="atmos relative overflow-hidden pb-16 pt-16 md:pt-24">
          <div class="mx-auto max-w-[1200px] px-5 text-center md:px-10">
            <span class="inline-flex h-[26px] items-center gap-2 rounded-[6px] border border-line-inner bg-surface px-3 text-[12.5px] text-fg-2">
              <StatusGlyph state="working" size={14} />
              Threads keep running after you close the tab
            </span>
            <h1 class={`mx-auto mt-5 max-w-[900px] text-[40px] md:text-[60px] xl:text-[72px] ${DISPLAY}`}>
              One project. Many hands. All of them working while you’re away.
            </h1>
            <p class="mx-auto mt-5 max-w-[620px] text-[16px] leading-[1.55] text-fg-2 md:text-[18px]">
              Tell a project what you need. Its coordinator splits the work into threads that run in parallel in the
              cloud, asks when it needs you, and lands a report in the chat when it’s done.
            </p>
            <div class="mt-8 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
              <Button size="lg" variant="primary" onClick={() => navigate("/welcome")}>
                Start a project
              </Button>
              <Button size="lg" variant="ghost" onClick={() => scrollTo("product")}>
                <Icon name="play" size={14} />
                Watch it work · 2 min
              </Button>
            </div>
            <DemoShot />
          </div>
        </section>

        <div class="mx-auto max-w-[1200px] px-5 md:px-10">
          <section id="product" class="scroll-mt-20 pt-24 md:pt-28">
            <span class="label">How it works</span>
            <h2 class={`mt-3 max-w-[640px] text-[34px] md:text-[44px] ${DISPLAY}`}>
              Ask once. It splits, works, and reports back.
            </h2>
            <div class="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-[12px] border border-line bg-line md:mt-12 md:grid-cols-3">
              <div class="flex min-h-[300px] flex-col gap-3 bg-surface p-7">
                <span class="label">01</span>
                <b class="text-[18px] font-medium">Start a project</b>
                <p class="text-[14px] leading-[1.6] text-fg-3">
                  Give it a name and a goal. Drop in files, connect your tools, and pick a model from any provider you
                  have a key for.
                </p>
                <div class="mt-auto rounded-[12px] border border-line-inner bg-raised p-3 text-[13.5px]">
                  <span class="label">Goal</span>
                  <div class="mt-1.5 text-fg-2">
                    Hire two account execs and a support lead before March.
                  </div>
                </div>
              </div>
              <div class="flex min-h-[300px] flex-col gap-3 bg-surface p-7">
                <span class="label">02</span>
                <b class="text-[18px] font-medium">The coordinator fans out</b>
                <p class="text-[14px] leading-[1.6] text-fg-3">
                  It answers directly when it can. When the job is bigger, it starts threads that each take one part,
                  and they run side by side.
                </p>
                <div class="mt-auto flex flex-col gap-1.5">
                  <For each={THREADS}>
                    {(thread) => (
                      <div class="flex h-[30px] items-center gap-2 rounded-[8px] border border-line-inner bg-raised px-2.5 text-[13px]">
                        <StatusGlyph state={thread.state} size={14} />
                        <span class="truncate">{thread.title}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
              <div class="flex min-h-[300px] flex-col gap-3 bg-surface p-7">
                <span class="label">03</span>
                <b class="text-[18px] font-medium">Answer, steer, or just read</b>
                <p class="text-[14px] leading-[1.6] text-fg-3">
                  Threads ask when they need you, in the chat or by push. Steer one mid-run. Reports land in the chat,
                  files land in the library.
                </p>
                <div class="mt-auto rounded-[12px] border border-line-inner bg-raised p-3 text-[13.5px]">
                  <div class="flex items-center gap-2 text-fg">
                    <StatusGlyph state="waiting" size={14} />
                    Choose a payroll vendor
                  </div>
                  <div class="mt-2.5 flex gap-1.5">
                    <For each={["Gusto", "Rippling", "Deel"]}>
                      {(vendor) => (
                        <span class="inline-flex h-[26px] items-center rounded-[6px] border border-line-inner bg-hover px-2 text-[12px] text-fg">
                          {vendor}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="pt-24 md:pt-28">
            <span class="label">What a project has</span>
            <h2 class={`mt-3 max-w-[640px] text-[34px] md:text-[44px] ${DISPLAY}`}>
              Everything the work needs, in one place.
            </h2>
            <div class="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-12 lg:grid-cols-3">
              <For each={FEATURES}>
                {(feature) => (
                  <div class="flex flex-col gap-2.5 rounded-[12px] border border-line bg-surface p-6">
                    <span class="grid h-9 w-9 place-items-center rounded-[8px] border border-line-inner bg-raised text-fg-2">
                      <Icon name={feature.icon} size={16} />
                    </span>
                    <b class="text-[15px] font-medium">{feature.title}</b>
                    <p class="text-[14px] leading-[1.6] text-fg-3">{feature.detail}</p>
                  </div>
                )}
              </For>
            </div>
          </section>

          <section id="extensions" class="scroll-mt-20 pt-24 md:pt-28">
            <div class="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
              <div>
                <span class="label">Extensions</span>
                <h2 class={`mt-3 max-w-[520px] text-[34px] md:text-[44px] ${DISPLAY}`}>
                  Add skills, tools and connectors in seconds.
                </h2>
                <p class="mt-4 max-w-[560px] text-[16px] leading-[1.6] text-fg-2">
                  Instant packages are bundles of skills, prompts, presets and MCP servers, and they install in seconds.
                  Packages that need a build apply on the next deploy, and you can roll any of them back.
                </p>
                <div class="mt-7 flex gap-2.5">
                  <Button size="md" variant="ghost" onClick={() => navigate("/extensions")}>
                    Browse extensions
                  </Button>
                </div>
              </div>
              <div class="flex flex-col gap-2.5">
                <For each={PACKAGES}>
                  {(pack) => (
                    <div class="flex items-center gap-3 rounded-[12px] border border-line bg-surface p-3.5">
                      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border border-line-inner bg-raised text-fg-2">
                        <Icon name={pack.icon} size={16} />
                      </span>
                      <div class="min-w-0 flex-1">
                        <b class="block text-[14px] font-medium">{pack.name}</b>
                        <div class="truncate text-[13px] text-fg-3">{pack.detail}</div>
                      </div>
                      <span class="inline-flex h-[26px] shrink-0 items-center rounded-[6px] border border-line-inner bg-fill px-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">
                        {pack.kind}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </section>

          <section class="pt-24 md:pt-28">
            <div class="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
              <div class="mx-auto w-[300px] max-w-full rounded-[36px] border border-line-strong bg-page p-2.5 shadow-[var(--shadow-float)]">
                <div class="relative h-[600px] overflow-hidden rounded-[28px] bg-page">
                  <div class="flex justify-between px-5 py-4 text-[13.5px] font-semibold">
                    <span>9:41</span>
                    <span class="tracking-[0.15em]">•••</span>
                  </div>
                  <div class="mt-10 text-center text-[64px] font-extralight tracking-[-0.04em]">9:41</div>
                  <div class="text-center text-[15px] text-fg-2">Friday, November 7</div>
                  <div class="mx-3 mt-16 flex items-start gap-2.5 rounded-[12px] border border-line bg-raised p-2.5">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line-inner bg-raised text-fg-2">
                      <Icon name="inbox" size={15} />
                    </span>
                    <div class="min-w-0 flex-1 text-[13.5px]">
                      <div class="flex items-baseline justify-between gap-2">
                        <b class="truncate font-semibold">Onboarding</b>
                        <span class="shrink-0 text-[11px] text-fg-3">now</span>
                      </div>
                      <div class="truncate">Which payroll vendor should I go with?</div>
                      <div class="truncate text-fg-3">Gusto · Rippling · Deel</div>
                    </div>
                  </div>
                  <div class="mx-3 mt-4 flex items-center gap-2 rounded-[12px] border border-line bg-raised p-2.5 text-[13.5px] text-fg-2">
                    <span class="h-1.5 w-1.5 rounded-full bg-waiting" />
                    Waiting on you · 1 question
                  </div>
                </div>
              </div>
              <div>
                <span class="label">On your phone</span>
                <h2 class={`mt-3 max-w-[520px] text-[34px] md:text-[44px] ${DISPLAY}`}>Answer from the lock screen.</h2>
                <p class="mt-4 max-w-[560px] text-[16px] leading-[1.6] text-fg-2">
                  Push for the three things that matter: a thread needs you, a thread finished, a thread failed. If the
                  question has choices, you can answer it straight from the notification. Everything else waits for you
                  in the app.
                </p>
              </div>
            </div>
          </section>

          <section id="questions" class="scroll-mt-20 pt-24 md:pt-28">
            <span class="label">Questions</span>
            <h2 class={`mt-3 max-w-[640px] text-[34px] md:text-[44px] ${DISPLAY}`}>What people ask first.</h2>
            <div class="mt-8 border-t border-line">
              <For each={QUESTIONS}>
                {(entry) => (
                  <div class="flex flex-col gap-2 border-b border-line py-5 md:flex-row md:gap-6">
                    <b class="w-full shrink-0 text-[15px] font-medium md:w-[380px]">{entry.question}</b>
                    <p class="text-[14px] leading-[1.6] text-fg-3">{entry.answer}</p>
                  </div>
                )}
              </For>
            </div>
          </section>

          <section class="atmos relative mt-24 overflow-hidden rounded-[20px] border border-line-inner bg-surface px-6 py-14 text-center md:mt-28 md:px-10 md:py-[72px]">
            <div class="relative">
              <h2 class={`text-[36px] md:text-[48px] ${DISPLAY}`}>Give your next project a coordinator.</h2>
              <p class="mt-3.5 text-[16px] text-fg-2">Bring a model key. Your first project takes about a minute.</p>
              <div class="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
                <Button size="lg" variant="primary" onClick={() => navigate("/welcome")}>
                  Start a project
                </Button>
                <Button size="lg" variant="quiet" onClick={() => scrollTo("questions")}>
                  Read the docs
                </Button>
              </div>
            </div>
          </section>

          <footer class="mt-24 grid grid-cols-1 gap-6 border-t border-line py-10 text-[13.5px] text-fg-3 md:grid-cols-[2fr_repeat(3,1fr)] md:pb-14">
            <div>
              <Wordmark />
              <p class="mt-2.5 max-w-[280px] leading-[1.6]">
                A personal agent that runs in the cloud. The name is a placeholder.
              </p>
            </div>
            <FooterColumn title="Product" items={["Projects", "Threads", "Extensions", "Mobile"]} />
            <FooterColumn title="Resources" items={["Docs", "Changelog", "Status"]} />
            <FooterColumn title="Company" items={["Privacy", "Terms", "Contact"]} />
          </footer>
        </div>
      </main>
    </div>
  )
}

function DemoShot(): JSX.Element {
  return (
    <div class="relative mx-auto mt-14 flex h-[560px] max-w-[1120px] overflow-hidden rounded-[12px] border border-line-inner bg-page text-left text-[13.5px] shadow-[var(--shadow-float)]">
      <aside class="hidden w-[200px] shrink-0 border-r border-line bg-surface p-2.5 lg:block">
        <div class="label px-1.5 pb-2 pt-1.5">Projects</div>
        <For each={PROJECTS}>
          {(project) => (
            <div
              class="flex h-[34px] items-center gap-2 rounded-[8px] px-1.5 text-[13px]"
              classList={{ "bg-selected text-fg": project.name === "Q4 pipeline", "text-fg-2": project.name !== "Q4 pipeline" }}
            >
              <span class="relative grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[8px] border border-line-inner bg-raised text-fg-2">
                <Icon name={project.icon} size={12} />
                <Show when={project.dot !== "none"}>
                  <span
                    class="absolute -right-[3px] -top-[3px] h-1.5 w-1.5 rounded-full shadow-[0_0_0_2px_var(--color-surface)]"
                    classList={{ "bg-working": project.dot === "working", "bg-waiting": project.dot === "waiting" }}
                  />
                </Show>
              </span>
              <span class="truncate">{project.name}</span>
            </div>
          )}
        </For>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col gap-4 px-5 py-6 md:px-7">
        <div class="ml-auto max-w-[400px] rounded-[12px] border border-line-inner bg-hover px-3 py-2 leading-[1.55]">
          Which deals slipped since Oct 28? Draft nudges for the owners.
        </div>
        <div class="leading-[1.6] text-fg">On it. I’ve started four threads.</div>
        <div class="overflow-hidden rounded-[8px] border border-line-inner">
          <For each={THREADS}>
            {(thread) => (
              <div class="flex h-8 items-center gap-2 border-b border-line bg-raised px-2.5 last:border-0">
                <StatusGlyph state={thread.state} size={14} />
                <b class="truncate font-medium">{thread.title}</b>
                <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg-3" classList={{ shimmer: thread.state === "working" }}>
                  {thread.line}
                </span>
                <span class="shrink-0 font-mono text-[11px] text-fg-4">{thread.elapsed}</span>
              </div>
            )}
          </For>
        </div>
        <div class="rounded-[12px] border border-line-inner bg-raised p-3">
          <div class="flex items-center gap-2">
            <StatusGlyph state="done" size={14} />
            <b class="flex-1 font-medium">Find deals that slipped</b>
            <span class="font-mono text-[11px] text-fg-4">4m 10s</span>
          </div>
          <p class="mt-2 leading-[1.6] text-fg-2">
            19 deals moved out of Q4, $412k at risk. Most of it is two deals waiting on legal.
          </p>
        </div>
      </div>

      <aside class="hidden w-[320px] shrink-0 border-l border-line bg-surface lg:block">
        <div class="flex h-11 items-end gap-4 border-b border-line px-3.5 text-[13px] font-medium text-fg-3">
          <span class="flex h-9 items-center text-fg shadow-[inset_0_-1px_var(--color-fg)]">Threads</span>
          <span class="flex h-9 items-center">Files</span>
          <span class="flex h-9 items-center">Memory</span>
          <span class="flex h-9 items-center">Schedules</span>
        </div>
        <div class="p-2">
          <div class="label px-2.5 pb-1.5 pt-3">Working · 3</div>
          <For each={THREADS.filter((thread) => thread.state === "working")}>
            {(thread) => (
              <div class="flex gap-2 px-2.5 py-1.5">
                <StatusGlyph state={thread.state} size={14} />
                <div class="min-w-0">
                  <div class="truncate font-medium">{thread.title}</div>
                  <div class="truncate text-[11.5px] text-fg-3 shimmer">{thread.line}</div>
                </div>
              </div>
            )}
          </For>
          <div class="label px-2.5 pb-1.5 pt-3">Queued · 1</div>
          <div class="flex gap-2 px-2.5 py-1.5">
            <StatusGlyph state="queued" size={14} />
            <div class="min-w-0">
              <div class="truncate font-medium">Post the report</div>
              <div class="truncate text-[11.5px] text-fg-3">Waits for the drafts</div>
            </div>
          </div>
          <div class="label px-2.5 pb-1.5 pt-3">Done · 1</div>
          <div class="flex gap-2 px-2.5 py-1.5">
            <StatusGlyph state="done" size={14} />
            <div class="min-w-0">
              <div class="truncate font-medium">Find deals that slipped</div>
              <div class="truncate text-[11.5px] text-fg-3">Done</div>
            </div>
          </div>
        </div>
      </aside>

      <span class="absolute right-4 top-4 font-mono text-[11px] text-fg-4">live</span>
    </div>
  )
}

function FooterColumn(props: { title: string; items: readonly string[] }): JSX.Element {
  return (
    <div>
      <b class="mb-2.5 block font-medium text-fg">{props.title}</b>
      <For each={props.items}>{(item) => <span class="mt-1.5 block">{item}</span>}</For>
    </div>
  )
}
