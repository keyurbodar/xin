import {
  CircleDot,
  File,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessagesSquare,
} from "lucide-solid"
import { Match, Show, Switch, createEffect, createMemo, createResource, createSignal, type Accessor, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { bytes } from "../../lib/format.ts"
import { STATE_WORD, type SignalState } from "../../lib/status.ts"
import { HoverCard } from "./hover-card.tsx"
import { Signal } from "./signal.tsx"
import { Bar } from "./skeleton.tsx"

export type PrState = "open" | "draft" | "merged" | "closed"

export type PrDetails = {
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: PrState
  readonly additions: number
  readonly deletions: number
  readonly author: string
}
export type ThreadDetails = { readonly code: string; readonly title: string; readonly project: string; readonly status: SignalState }
export type IssueDetails = { readonly key: string; readonly title: string; readonly state: string }
export type CommitDetails = { readonly sha: string; readonly message: string }
export type FileDetails = { readonly path: string; readonly size?: number | undefined }

type Common = { label: string; href: string; version?: string | number | undefined }

export type LinkChipProps = Common &
  (
    | { kind: "pr"; state: PrState; load: () => Promise<PrDetails> }
    | { kind: "thread"; load: () => Promise<ThreadDetails> }
    | { kind: "issue"; load: () => Promise<IssueDetails> }
    | { kind: "commit"; load: () => Promise<CommitDetails> }
    | { kind: "file"; load: () => Promise<FileDetails> }
  )

const ICON = { size: 14, "stroke-width": 1.5 } as const

const PR_ICON = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const

const PR_TONE: Readonly<Record<PrState, string>> = {
  open: "text-done",
  draft: "text-ink-3",
  merged: "text-merged",
  closed: "text-failed",
}

const PR_WORD: Readonly<Record<PrState, string>> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

const KIND_ICON = { thread: MessagesSquare, issue: CircleDot, commit: GitCommitHorizontal, file: File } as const

const CHIP =
  "im-focus inline-flex max-w-full items-baseline gap-1 rounded-xs text-primary-ink no-underline decoration-primary-ink/40 underline-offset-2 hover:underline"

/**
 * An inline reference to a PR, thread, issue, commit or file. Its hover card loads the details through `load` while it is
 * settled, once per href and `version`: the caller sets `version` from whatever changes the content (PR state, issue
 * status, a thread's updated time), so a changed item reloads and an unchanged one never does. The card shows only details
 * loaded for the chip's current href and version, and the loading state otherwise.
 */
export function LinkChip(props: LinkChipProps): JSX.Element {
  const mono = (): boolean => props.kind === "commit" || props.kind === "file"
  const identity = (): string => JSON.stringify([props.href, props.version ?? null])
  const [settled, setSettled] = createSignal(false)
  const [wanted, setWanted] = createSignal<string | false>(false)
  createEffect(() => {
    if (settled()) setWanted(identity())
  })
  return (
    <HoverCard
      onSettledChange={setSettled}
      trigger={
        <a href={props.href} class={CHIP} data-kind={props.kind}>
          <span class={`shrink-0 self-center ${props.kind === "pr" ? PR_TONE[props.state] : "text-ink-3"}`}>
            <Dynamic component={props.kind === "pr" ? PR_ICON[props.state] : KIND_ICON[props.kind]} {...ICON} />
          </span>
          <span class={`truncate ${mono() ? "font-mono" : ""}`}>{props.label}</span>
        </a>
      }
    >
      <div class="flex flex-col gap-1.5 p-2">
        <Switch>
          <Match when={props.kind === "pr" && props}>{(chip) => <Loaded wanted={wanted} current={identity} load={chip().load} render={PrCard} />}</Match>
          <Match when={props.kind === "thread" && props}>
            {(chip) => <Loaded wanted={wanted} current={identity} load={chip().load} render={ThreadCard} />}
          </Match>
          <Match when={props.kind === "issue" && props}>{(chip) => <Loaded wanted={wanted} current={identity} load={chip().load} render={IssueCard} />}</Match>
          <Match when={props.kind === "commit" && props}>
            {(chip) => <Loaded wanted={wanted} current={identity} load={chip().load} render={CommitCard} />}
          </Match>
          <Match when={props.kind === "file" && props}>{(chip) => <Loaded wanted={wanted} current={identity} load={chip().load} render={FileCard} />}</Match>
        </Switch>
      </div>
    </HoverCard>
  )
}

function Loaded<T>(props: {
  wanted: Accessor<string | false>
  current: Accessor<string>
  load: () => Promise<T>
  render: (details: T) => JSX.Element
}): JSX.Element {
  const [details] = createResource(props.wanted, async (key) => ({ key, details: await props.load() }))
  const failed = (): boolean => details.error !== undefined && !details.loading && props.wanted() === props.current()
  const fresh = createMemo(() => {
    if (details.error !== undefined || details.loading) return undefined
    const loaded = details.latest
    return loaded?.key === props.current() ? loaded.details : undefined
  })
  return (
    <Show when={!failed()} fallback={<p class="text-small text-ink-3">Couldn't load the details.</p>}>
      <Show
        when={fresh()}
        keyed
        fallback={
          <div role="status" aria-busy="true" aria-label="Loading" class="flex flex-col gap-2 py-0.5">
            <Bar width="34%" class="h-2" />
            <Bar width="86%" />
            <Bar width="52%" class="h-2" />
          </div>
        }
      >
        {(loaded) => props.render(loaded)}
      </Show>
    </Show>
  )
}

function Head(props: { children: JSX.Element }): JSX.Element {
  return <div class="flex min-w-0 items-center gap-1.5 text-mini text-ink-3">{props.children}</div>
}

function Title(props: { children: JSX.Element }): JSX.Element {
  return <p class="line-clamp-2 text-small font-title text-ink">{props.children}</p>
}

function PrCard(pr: PrDetails): JSX.Element {
  return (
    <>
      <Head>
        <span class={PR_TONE[pr.state]}>
          <Dynamic component={PR_ICON[pr.state]} {...ICON} />
        </span>
        <span class="truncate">
          {pr.repo}#{pr.number}
        </span>
        <span class="ml-auto shrink-0">{PR_WORD[pr.state]}</span>
      </Head>
      <Title>{pr.title}</Title>
      <div class="flex items-center gap-2 text-mini">
        <span class="font-mono text-diff-add">+{pr.additions}</span>
        <span class="font-mono text-diff-del">-{pr.deletions}</span>
        <span class="ml-auto flex min-w-0 items-center gap-1.5 text-ink-3">
          <span
            aria-hidden="true"
            class="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-muted text-micro leading-none font-strong uppercase text-ink-2"
          >
            {pr.author.slice(0, 1)}
          </span>
          <span class="truncate">{pr.author}</span>
        </span>
      </div>
    </>
  )
}

function ThreadCard(thread: ThreadDetails): JSX.Element {
  return (
    <>
      <Head>
        <Signal state={thread.status} size={12} />
        <span class="truncate">{thread.code}</span>
      </Head>
      <Title>{thread.title}</Title>
      <p class="truncate text-mini text-ink-3">
        {thread.project} · {STATE_WORD[thread.status]}
      </p>
    </>
  )
}

function IssueCard(issue: IssueDetails): JSX.Element {
  return (
    <>
      <Head>
        <CircleDot {...ICON} />
        <span class="truncate">{issue.key}</span>
        <span class="ml-auto shrink-0">{issue.state}</span>
      </Head>
      <Title>{issue.title}</Title>
    </>
  )
}

function CommitCard(commit: CommitDetails): JSX.Element {
  return (
    <>
      <Head>
        <GitCommitHorizontal {...ICON} />
        <span class="font-mono">{commit.sha.slice(0, 7)}</span>
      </Head>
      <Title>{commit.message.split("\n", 1)[0]}</Title>
    </>
  )
}

function FileCard(file: FileDetails): JSX.Element {
  return (
    <>
      <Head>
        <File {...ICON} />
        <span>File</span>
        <Show when={file.size}>{(size) => <span class="ml-auto shrink-0">{bytes(size())}</span>}</Show>
      </Head>
      <p class="break-all font-mono text-mini text-ink">{file.path}</p>
    </>
  )
}
