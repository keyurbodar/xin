import { createRenderer } from "solid-js/universal"

/** One node of the in-memory tree the web tests render Solid components into. */
export type TestNode = {
  readonly tag: string
  text: string
  readonly props: Record<string, unknown>
  readonly children: TestNode[]
  parent: TestNode | undefined
}

const node = (tag: string, text = ""): TestNode => ({ tag, text, props: {}, children: [], parent: undefined })

function detach(child: TestNode): void {
  const siblings = child.parent?.children
  if (siblings !== undefined) siblings.splice(siblings.indexOf(child), 1)
  child.parent = undefined
}

export const {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  memo,
  mergeProps,
  setProp,
  spread,
  use,
} = createRenderer<TestNode>({
  createElement: (tag) => node(tag),
  createTextNode: (text) => node("#text", text),
  replaceText: (target, text) => {
    target.text = text
  },
  isTextNode: (target) => target.tag === "#text",
  setProperty: (target, name, value) => {
    target.props[name] = value
  },
  insertNode: (parent, child, anchor) => {
    detach(child)
    const at = anchor === undefined ? -1 : parent.children.indexOf(anchor)
    if (at === -1) parent.children.push(child)
    else parent.children.splice(at, 0, child)
    child.parent = parent
  },
  removeNode: (_parent, child) => detach(child),
  getParentNode: (target) => target.parent,
  getFirstChild: (target) => target.children[0],
  getNextSibling: (target) => {
    const siblings = target.parent?.children ?? []
    return siblings[siblings.indexOf(target) + 1]
  },
})

export const root = (): TestNode => node("root")

export const textOf = (target: TestNode): string => target.text + target.children.map(textOf).join("")
