import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { addServer, errorMessage, isRecord, readMcpTools, removeServer, servers, type McpServer } from "../../state/extensions.ts"
import { Button, Empty, Failure, MONO_INPUT, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function Connectors(): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const [adding, setAdding] = createSignal(false)

  const list = (): readonly McpServer[] => {
    const state = servers.state()
    return state.kind === "ready" ? state.value : []
  }

  const current = (): McpServer | undefined => list().find((server) => server.name === selected())

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">MCP connectors</span>
          <Button
            size="sm"
            class="ml-auto"
            onClick={() => {
              setAdding(true)
              setSelected(undefined)
            }}
          >
            <Glyph name="plus" size={14} />
            Add server
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={servers.state().kind === "loading"}>
            <Pending label="Reading connectors" />
          </Show>
          <Show when={failureOf(servers.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void servers.reload()} />
              </div>
            )}
          </Show>
          <Show when={servers.state().kind === "ready" && list().length === 0}>
            <div class="p-3">
              <Empty title="No connectors yet." detail="An MCP server adds tools to every thread it is enabled for." />
            </div>
          </Show>
          <For each={list()}>
            {(server) => (
              <button
                type="button"
                onClick={() => {
                  setSelected(server.name)
                  setAdding(false)
                }}
                class="flex w-full items-center gap-2.5 border-b border-line px-3.5 py-3 text-left hover:bg-hover"
                classList={{ "bg-hover": selected() === server.name }}
              >
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg-2">
                  <Glyph name="plug" size={15} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-medium text-fg">{server.name}</span>
                  <span class="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                    <span
                      class="h-1.5 w-1.5 rounded-[1px]"
                      classList={{ "bg-ok": server.error === undefined, "bg-bad": server.error !== undefined }}
                    />
                    {server.error ?? `${server.tools} ${server.tools === 1 ? "tool" : "tools"}`}
                  </span>
                </span>
                <Glyph name="chevron-right" size={13} class="text-fg-4" />
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={adding()}
          fallback={
            <Show
              when={current()}
              fallback={
                <div class="px-6 py-6">
                  <Empty
                    title="Pick a connector or add a server."
                    detail="Connectors are MCP servers. Each one is reached over https and its headers are stored sealed."
                  />
                </div>
              }
            >
              {(server) => <ConnectorDetail server={server()} onRemoved={() => setSelected(undefined)} />}
            </Show>
          }
        >
          <AddServer onAdded={(name) => { setAdding(false); setSelected(name) }} onCancel={() => setAdding(false)} />
        </Show>
      </div>
    </>
  )
}

function ConnectorDetail(props: { server: McpServer; onRemoved: () => void }): JSX.Element {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await removeServer(props.server.name)
      props.onRemoved()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="flex items-center gap-3 border-b border-line px-6 py-4">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
          <Glyph name="plug" size={18} />
        </span>
        <div class="min-w-0 flex-1">
          <span class="block truncate text-[16px] font-medium text-fg">{props.server.name}</span>
          <span class="block truncate text-[12px] text-fg-3">
            MCP · {props.server.tools} tools
            <Show when={props.server.source}>
              {(source) => <span> · contributed by {source()}</span>}
            </Show>
          </span>
        </div>
        <Show when={props.server.source === undefined}>
          <Show when={confirming()} fallback={<Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>Remove</Button>}>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
            <Button size="sm" variant="danger" disabled={busy()} onClick={() => void remove()}>{busy() ? "Removing" : "Remove server"}</Button>
          </Show>
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div class="flex max-w-[560px] flex-col gap-5">
          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>
          <Show when={props.server.error}>
            {(message) => <Failure message={`The server answered with: ${message()}`} />}
          </Show>
          <Panel>
            <div class="flex items-center justify-between border-b border-line px-3.5 py-2.5 text-[12.5px]">
              <span class="text-fg-3">Endpoint</span>
              <span class="font-mono text-[12px] text-fg-2">{props.server.url}</span>
            </div>
            <div class="flex items-center justify-between border-b border-line px-3.5 py-2.5 text-[12.5px]">
              <span class="text-fg-3">Tools</span>
              <span class="font-mono text-[12px] text-fg-2">{props.server.tools}</span>
            </div>
            <div class="flex items-center justify-between px-3.5 py-2.5 text-[12.5px]">
              <span class="text-fg-3">Headers</span>
              <span class="text-[11.5px] text-fg-3">{props.server.source === undefined ? "Sealed, never shown" : "Supplied by a row"}</span>
            </div>
          </Panel>
          <Note>
            Headers are sealed and cannot be read back. To change them, remove the server and add it again with the new headers.
          </Note>
          <ToolsList name={props.server.name} />
        </div>
      </div>
    </>
  )
}

/** The tool names the server last advertised; the count in the header is the same list. */
function ToolsList(props: { name: string }): JSX.Element {
  const [tools] = createResource(() => props.name, readMcpTools)
  return (
    <section class="flex flex-col gap-2">
      <span class="label">Tools</span>
      <Show when={tools.error}>
        {(failure) => <Failure message={errorMessage(failure())} />}
      </Show>
      <Show when={tools.loading}>
        <Pending label="Reading the tool list" />
      </Show>
      <Show when={tools()}>
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={<Note>This server has not advertised any tool yet. Headers are sealed, so the token may be stale.</Note>}
          >
            <Panel>
              <For each={list()}>
                {(tool) => (
                  <div class="flex items-baseline gap-2.5 border-b border-line px-3.5 py-2 last:border-0">
                    <code class="shrink-0 font-mono text-[11.5px] text-fg">{tool.name}</code>
                    <span class="min-w-0 truncate text-[11.5px] text-fg-3">{tool.description ?? ""}</span>
                  </div>
                )}
              </For>
            </Panel>
          </Show>
        )}
      </Show>
    </section>
  )
}

function AddServer(props: { onAdded: (name: string) => void; onCancel: () => void }): JSX.Element {
  const [name, setName] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [headers, setHeaders] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const validName = (): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name().trim())
  const validUrl = (): boolean => {
    try {
      return new URL(url().trim()).protocol === "https:"
    } catch {
      return false
    }
  }

  const parsedHeaders = (): Readonly<Record<string, string>> | undefined => {
    if (headers().trim() === "") return undefined
    const value: unknown = JSON.parse(headers())
    if (!isRecord(value)) throw new Error("Headers must be a JSON object of strings")
    const found: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") throw new Error(`Header ${key} must be a string`)
      found[key] = entry
    }
    return found
  }

  const submit = async (): Promise<void> => {
    if (!validName() || !validUrl() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const parsed = parsedHeaders()
      await addServer(name().trim(), url().trim(), parsed)
      props.onAdded(name().trim())
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="flex items-center gap-3 border-b border-line px-6 py-4">
        <div class="min-w-0 flex-1">
          <span class="block text-[16px] font-medium text-fg">Add MCP server</span>
          <span class="block text-[12px] text-fg-3">Streamable HTTP over https</span>
        </div>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div class="flex max-w-[520px] flex-col gap-4">
          <label class="flex flex-col gap-1.5">
            <span class="text-[12px] font-medium text-fg-2">Name</span>
            <input
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder="ats-sync"
              spellcheck={false}
              class={MONO_INPUT}
              classList={{ "border-bad/50": name() !== "" && !validName() }}
            />
            <span class="text-[11.5px] text-fg-3">Lowercase, hyphen separated. This is the tool prefix.</span>
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="text-[12px] font-medium text-fg-2">Endpoint</span>
            <input
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://mcp.example.com/mcp"
              spellcheck={false}
              class={MONO_INPUT}
              classList={{ "border-bad/50": url() !== "" && !validUrl() }}
            />
            <span class="text-[11.5px] text-fg-3">Must be https. Credentials belong in headers, not the URL.</span>
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="text-[12px] font-medium text-fg-2">Headers</span>
            <textarea
              value={headers()}
              onInput={(event) => setHeaders(event.currentTarget.value)}
              placeholder={'{"Authorization": "Bearer …"}'}
              spellcheck={false}
              class={`${MONO_INPUT} h-auto min-h-[72px] resize-y py-2 leading-relaxed`}
            />
            <span class="text-[11.5px] text-fg-3">Optional JSON object. Stored sealed; models never see it.</span>
          </label>
          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>
        </div>
      </div>
      <footer class="flex items-center gap-2 border-t border-line px-6 py-3">
        <span class="ml-auto" />
        <Button size="sm" variant="quiet" onClick={props.onCancel}>Cancel</Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy() || !validName() || !validUrl()}
          onClick={() => void submit()}
        >
          {busy() ? "Adding" : "Add server"}
        </Button>
      </footer>
    </>
  )
}

