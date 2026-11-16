// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { to_jsstring, to_luastring } from "fengari/src/fengaricore.js"
import * as lauxlib from "fengari/src/lauxlib.js"
import { luaopen_base } from "fengari/src/lbaselib.js"
import { luaopen_math } from "fengari/src/lmathlib.js"
import { luaopen_string } from "fengari/src/lstrlib.js"
import { luaopen_table } from "fengari/src/ltablib.js"
import * as lua from "fengari/src/lua.js"
import { luaopen_utf8 } from "fengari/src/lutf8lib.js"
import { type DrawCmd, Graphics, GRAPHICS_METHODS, type Pointer } from "./draw.ts"
import { type HandlerId, type Node, Parser } from "./node.ts"
import { Meter, PER_CALL } from "./limits.ts"
import { PRELUDE } from "./prelude.lua.ts"
import { formatNumber, niceTicks, VisualError } from "./style.ts"
import { type LuaFunction, type LuaTable, type LuaValue, type Plain, plain } from "./value.ts"

type LuaState = lua.LuaState

export const MAX_SCRIPT_BYTES = 256 * 1024
/** Budgets count VM instructions, not wall time: a Worker's clock stands still while it computes, and a count is the same on every device. */
export const CALL_BUDGET = 5_000_000
export const DRAW_BUDGET = 1_500_000
const HOOK_EVERY = 1000
const MAX_LOG_LINES = 200
const MAX_VALUES = 400_000
const MAX_STRING_REP = 1 << 20

export type HandlerArg =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "point"; readonly x: number; readonly y: number }

export type CanvasDrawing = { readonly commands: readonly DrawCmd[]; readonly readsPointer: boolean }

export type SceneTarget = Readonly<Record<string, (...args: Plain[]) => void>>

const s = to_luastring

export function seedFor(id: string): number {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return Number(hash & 0x7fffffffn)
}

function message(L: LuaState): string {
  const raw = lua.lua_tostring(L, -1)
  lua.lua_pop(L, 1)
  return raw === null ? "the script raised a non-string error" : to_jsstring(raw)
}

/** A JS function Lua can call: a VisualError it throws becomes a Lua error at the calling line. */
function guarded(fn: (L: LuaState) => number): (L: LuaState) => number {
  return (L) => {
    let failure: string
    try {
      return fn(L)
    } catch (error) {
      if (!(error instanceof VisualError)) throw error
      failure = error.message
    }
    return lauxlib.luaL_error(L, s(failure))
  }
}

/** One visual's live program: a sandboxed Lua 5.3 state with the `ui` library, its view function, and the handlers of its latest render. */
export class Visual {
  private readonly L: LuaState
  private viewRef = -1
  private handlers: LuaFunction[] = []
  private refs: number[] = []
  private values = 0
  readonly logs: string[] = []

  private constructor(
    L: LuaState,
    private readonly seed: number,
    private readonly meter: Meter,
  ) {
    this.L = L
  }

  static load(source: string, seed: number, meter = new Meter(PER_CALL, "call")): Visual {
    if (new TextEncoder().encode(source).length > MAX_SCRIPT_BYTES)
      throw new VisualError(`the script is over ${MAX_SCRIPT_BYTES / 1024} KB`)
    const L = lauxlib.luaL_newstate()
    L.l_G.meter = meter
    const visual = new Visual(L, seed, meter)
    meter.reset(CALL_BUDGET)
    visual.install()
    const status = lauxlib.luaL_loadbuffer(L, s(source), null, s("=visual"))
    if (status !== lua.LUA_OK) throw new VisualError(message(L))
    visual.runSetup()
    return visual
  }

  private install(): void {
    const L = this.L
    for (const [name, open] of [
      ["_G", luaopen_base],
      ["table", luaopen_table],
      ["string", luaopen_string],
      ["math", luaopen_math],
      ["utf8", luaopen_utf8],
    ] as const) {
      lauxlib.luaL_requiref(L, s(name), open, 1)
      lua.lua_pop(L, 1)
    }
    for (const name of ["dofile", "loadfile", "load", "require", "collectgarbage"]) {
      lua.lua_pushnil(L)
      lua.lua_setglobal(L, s(name))
    }
    for (const name of ["pcall", "xpcall"]) {
      lua.lua_getglobal(L, s(name))
      const raw = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)
      lua.lua_pushjsfunction(L, (state) => {
        const handler = name === "xpcall" && lua.lua_gettop(state) >= 2 ? this.guardHandler(state) : undefined
        try {
          lua.lua_rawgeti(state, lua.LUA_REGISTRYINDEX, raw)
          lua.lua_insert(state, 1)
          lua.lua_call(state, lua.lua_gettop(state) - 1, lua.LUA_MULTRET)
        } finally {
          if (handler !== undefined) lauxlib.luaL_unref(state, lua.LUA_REGISTRYINDEX, handler)
        }
        if (this.meter.failure !== undefined) return lauxlib.luaL_error(state, s(this.meter.failure))
        return lua.lua_gettop(state)
      })
      lua.lua_setglobal(L, s(name))
    }
    lua.lua_getglobal(L, s("string"))
    lua.lua_getfield(L, -1, s("rep"))
    const rep = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)
    lua.lua_pushjsfunction(L, (state) => {
      const unit = lua.lua_tostring(state, 1)
      const separator = lua.lua_type(state, 3) === lua.LUA_TSTRING ? (lua.lua_tostring(state, 3)?.length ?? 0) : 0
      const count = lua.lua_tonumber(state, 2)
      if (((unit?.length ?? 0) + separator) * count > MAX_STRING_REP)
        return lauxlib.luaL_error(state, s("string.rep would build a string over 1 MB"))
      const top = lua.lua_gettop(state)
      lua.lua_rawgeti(state, lua.LUA_REGISTRYINDEX, rep)
      for (let index = 1; index <= top; index += 1) lua.lua_pushvalue(state, index)
      lua.lua_call(state, top, 1)
      return 1
    })
    lua.lua_setfield(L, -2, s("rep"))
    lua.lua_pop(L, 1)

    lua.lua_pushjsfunction(L, (state) => {
      const top = lua.lua_gettop(state)
      const parts: string[] = []
      for (let index = 1; index <= top; index += 1) parts.push(printable(state, index))
      if (this.logs.length < MAX_LOG_LINES) this.logs.push(parts.join("\t"))
      return 0
    })
    lua.lua_setglobal(L, s("print"))

    if (
      lauxlib.luaL_loadbuffer(L, s(PRELUDE), null, s("=ui")) !== lua.LUA_OK ||
      lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK
    )
      throw new VisualError(`the ui library failed to load: ${message(L)}`)
    lua.lua_pushjsfunction(L, (state) => {
      const value = lua.lua_tonumber(state, 1)
      const options = lua.lua_type(state, 2) === lua.LUA_TTABLE
      const field = (name: string): string | undefined => {
        if (!options) return undefined
        lua.lua_getfield(state, 2, s(name))
        const raw = lua.lua_type(state, -1) === lua.LUA_TNIL ? null : lua.lua_tostring(state, -1)
        lua.lua_pop(state, 1)
        return raw === null ? undefined : to_jsstring(raw)
      }
      const decimals = field("decimals")
      const text = formatNumber(
        {
          prefix: field("prefix") ?? "",
          unit: field("unit") ?? "",
          decimals: decimals === undefined ? undefined : Math.trunc(Math.min(6, Math.max(0, Number(decimals)))),
        },
        value,
      )
      lua.lua_pushstring(state, s(text))
      return 1
    })
    lua.lua_setfield(L, -2, s("fmt"))
    lua.lua_pushjsfunction(L, (state) => {
      const count = lua.lua_type(state, 3) === lua.LUA_TNUMBER ? lua.lua_tonumber(state, 3) : 5
      const ticks = niceTicks(lua.lua_tonumber(state, 1), lua.lua_tonumber(state, 2), count)
      lua.lua_createtable(state, ticks.length, 0)
      ticks.forEach((tick, index) => {
        lua.lua_pushnumber(state, tick)
        lua.lua_rawseti(state, -2, index + 1)
      })
      return 1
    })
    lua.lua_setfield(L, -2, s("ticks"))
    lua.lua_setglobal(L, s("ui"))
    lua.lua_sethook(
      L,
      (state) => {
        const failure = this.meter.tick(HOOK_EVERY)
        if (failure !== undefined) lauxlib.luaL_error(state, s(failure))
      },
      lua.LUA_MASKCOUNT,
      HOOK_EVERY,
    )
  }

  /** Replace xpcall's message handler with one that skips it once the meter has tripped: a budget error raised from the hook runs the handler with hooks off, so a looping handler would never be stopped. */
  private guardHandler(L: LuaState): number {
    lua.lua_pushvalue(L, 2)
    const handler = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)
    lua.lua_pushjsfunction(L, (state) => {
      if (this.meter.failure !== undefined) {
        lua.lua_pushstring(state, s(this.meter.failure))
        return 1
      }
      const top = lua.lua_gettop(state)
      lua.lua_rawgeti(state, lua.LUA_REGISTRYINDEX, handler)
      lua.lua_insert(state, 1)
      lua.lua_call(state, top, 1)
      return 1
    })
    lua.lua_replace(L, 2)
    return handler
  }

  private runSetup(): void {
    const L = this.L
    this.budget(CALL_BUDGET)
    this.protect(() => 0, 1)
    const type = lua.lua_type(L, -1)
    if (type === lua.LUA_TNIL) {
      lua.lua_pop(L, 1)
      throw new VisualError(
        "the script must end with `return function() return ui.column { ... } end` (or return a node)",
      )
    }
    if (type !== lua.LUA_TFUNCTION && type !== lua.LUA_TTABLE) {
      const name = to_jsstring(lua.lua_typename(L, type))
      lua.lua_pop(L, 1)
      throw new VisualError(`the script returned a ${name}; return a view function or a ui node`)
    }
    this.viewRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)
  }

  private budget(instructions: number): void {
    this.meter.reset(instructions)
    lua.lua_getglobal(this.L, s("math"))
    lua.lua_getfield(this.L, -1, s("randomseed"))
    lua.lua_pushinteger(this.L, this.seed)
    lua.lua_pcall(this.L, 1, 0, 0)
    lua.lua_pop(this.L, 1)
  }

  private protect(push: () => number, nresults: number): void {
    const L = this.L
    const base = lua.lua_gettop(L) - 1
    const status = lua.lua_pcall(L, push(), nresults, 0)
    const raised = status === lua.LUA_OK ? undefined : message(L)
    const failure = this.meter.failure ?? raised
    if (failure === undefined) return
    lua.lua_settop(L, base)
    throw new VisualError(failure)
  }

  private release(): void {
    for (const ref of this.refs) lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, ref)
    this.refs = []
  }

  private toValue(index: number, depth: number, refs: number[]): LuaValue {
    const L = this.L
    this.values += 1
    if (this.values > MAX_VALUES) throw new VisualError("the view returned too much data; summarize or paginate it")
    const at = lua.lua_absindex(L, index)
    const type = lua.lua_type(L, at)
    if (type === lua.LUA_TNIL) return undefined
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, at)
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, at)
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, at) ?? new Uint8Array())
    if (type === lua.LUA_TFUNCTION) {
      lua.lua_pushvalue(L, at)
      const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)
      refs.push(ref)
      return { kind: "function", ref }
    }
    if (type !== lua.LUA_TTABLE) return to_jsstring(lua.lua_typename(L, type))
    if (depth > 64) throw new VisualError("the view nests too deeply (or a table contains itself)")
    const length = lua.lua_rawlen(L, at)
    const seq: LuaValue[] = []
    const keys = new Map<string, LuaValue>()
    for (let i = 1; i <= length; i += 1) {
      lua.lua_rawgeti(L, at, i)
      seq.push(this.toValue(-1, depth + 1, refs))
      lua.lua_pop(L, 1)
    }
    lua.lua_pushnil(L)
    while (lua.lua_next(L, at) !== 0) {
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
        const key = to_jsstring(lua.lua_tostring(L, -2) ?? new Uint8Array())
        keys.set(key, this.toValue(-1, depth + 1, refs))
      }
      lua.lua_pop(L, 1)
    }
    const table: LuaTable = { kind: "table", seq, keys }
    return table
  }

  private pull(index: number, refs: number[]): LuaValue {
    this.values = 0
    return this.toValue(index, 0, refs)
  }

  private invoke(ref: number, push: () => number, results: number): void {
    const L = this.L
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref)
    this.protect(push, results)
  }

  /** Run the view and parse its tree. Handler ids stay valid until the next render. */
  render(): Node {
    const L = this.L
    this.budget(CALL_BUDGET)
    const top = lua.lua_gettop(L)
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, this.viewRef)
    if (lua.lua_type(L, -1) === lua.LUA_TFUNCTION) {
      this.protect(() => 0, 1)
    }
    const refs: number[] = []
    try {
      const value = this.pull(-1, refs)
      const parser = new Parser()
      const tree = parser.root(value)
      this.release()
      this.refs = refs
      this.handlers = parser.handlers
      return tree
    } catch (error) {
      for (const ref of refs) lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref)
      throw error
    } finally {
      lua.lua_settop(L, top)
    }
  }

  private handler(id: HandlerId): LuaFunction {
    const fn = this.handlers[id]
    if (fn === undefined) throw new VisualError("stale handler")
    return fn
  }

  /** Call an event handler; the caller renders again afterwards. */
  call(id: HandlerId, arg: HandlerArg): void {
    const L = this.L
    const fn = this.handler(id)
    this.budget(CALL_BUDGET)
    const top = lua.lua_gettop(L)
    try {
      this.invoke(
        fn.ref,
        () => {
          switch (arg.kind) {
            case "none":
              return 0
            case "text":
              lua.lua_pushstring(L, s(arg.value))
              return 1
            case "bool":
              lua.lua_pushboolean(L, arg.value)
              return 1
            case "number":
              lua.lua_pushnumber(L, arg.value)
              return 1
            case "point":
              lua.lua_pushnumber(L, arg.x)
              lua.lua_pushnumber(L, arg.y)
              return 2
            default: {
              const _exhaustive: never = arg
              return _exhaustive
            }
          }
        },
        0,
      )
    } finally {
      lua.lua_settop(L, top)
    }
  }

  /** Run a canvas's draw function at a size in pixels. */
  drawCanvas(id: HandlerId, width: number, height: number, time: number, pointer: Pointer | undefined): CanvasDrawing {
    const L = this.L
    const fn = this.handler(id)
    const graphics = new Graphics(width, height, time, pointer)
    this.budget(DRAW_BUDGET)
    const top = lua.lua_gettop(L)
    try {
      this.invoke(
        fn.ref,
        () => {
          lua.lua_createtable(L, 0, 4)
          lua.lua_pushnumber(L, width)
          lua.lua_setfield(L, -2, s("width"))
          lua.lua_pushnumber(L, height)
          lua.lua_setfield(L, -2, s("height"))
          lua.lua_pushnumber(L, time)
          lua.lua_setfield(L, -2, s("time"))
          for (const method of GRAPHICS_METHODS) {
            lua.lua_pushjsfunction(
              L,
              guarded((state) => {
                graphics.call(method, this.args(state, 2))
                return 0
              }),
            )
            lua.lua_setfield(L, -2, s(method))
          }
          lua.lua_createtable(L, 0, 1)
          lua.lua_pushjsfunction(L, (state) => {
            const key = lua.lua_tostring(state, 2)
            if (key === null || to_jsstring(key) !== "pointer") return 0
            graphics.readPointer = true
            if (pointer === undefined) return 0
            lua.lua_createtable(state, 0, 3)
            lua.lua_pushnumber(state, pointer.x)
            lua.lua_setfield(state, -2, s("x"))
            lua.lua_pushnumber(state, pointer.y)
            lua.lua_setfield(state, -2, s("y"))
            lua.lua_pushboolean(state, pointer.down)
            lua.lua_setfield(state, -2, s("down"))
            return 1
          })
          lua.lua_setfield(L, -2, s("__index"))
          lua.lua_setmetatable(L, -2)
          lua.lua_pushnumber(L, width)
          lua.lua_pushnumber(L, height)
          lua.lua_pushnumber(L, time)
          return 4
        },
        0,
      )
    } finally {
      lua.lua_settop(L, top)
    }
    return { commands: graphics.commands, readsPointer: graphics.readPointer }
  }

  /** Run a scene's draw function against a scene builder: each `s:<method>(...)` becomes `target[method](...plain args)`. */
  drawScene(id: HandlerId, time: number, target: SceneTarget): void {
    const L = this.L
    const fn = this.handler(id)
    this.budget(DRAW_BUDGET)
    const top = lua.lua_gettop(L)
    const temporary: number[] = []
    try {
      this.invoke(
        fn.ref,
        () => {
          lua.lua_createtable(L, 0, Object.keys(target).length)
          for (const [method, apply] of Object.entries(target)) {
            lua.lua_pushjsfunction(
              L,
              guarded((state) => {
                const args = this.args(state, 2, temporary).map((value) =>
                  plain(value, (handle) => this.callback(handle)),
                )
                apply(...args)
                return 0
              }),
            )
            lua.lua_setfield(L, -2, s(method))
          }
          lua.lua_pushnumber(L, time)
          return 2
        },
        0,
      )
    } finally {
      for (const ref of temporary) lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref)
      lua.lua_settop(L, top)
    }
  }

  private callback(handle: LuaFunction): (...args: number[]) => number {
    return (...args) => {
      const L = this.L
      const top = lua.lua_gettop(L)
      try {
        this.invoke(
          handle.ref,
          () => {
            for (const arg of args) lua.lua_pushnumber(L, arg)
            return args.length
          },
          1,
        )
        const result = lua.lua_type(L, -1) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -1) : Number.NaN
        if (!Number.isFinite(result)) throw new VisualError("a surface function must return a finite number")
        return result
      } finally {
        lua.lua_settop(L, top)
      }
    }
  }

  private args(L: LuaState, from: number, refs: number[] = []): LuaValue[] {
    const top = lua.lua_gettop(L)
    const out: LuaValue[] = []
    for (let index = from; index <= top; index += 1) {
      this.values = 0
      out.push(this.toValue(index, 0, refs))
    }
    return out
  }
}

function printable(L: LuaState, index: number): string {
  const type = lua.lua_type(L, index)
  if (type === lua.LUA_TNIL) return "nil"
  if (type === lua.LUA_TBOOLEAN) return String(lua.lua_toboolean(L, index))
  if (type === lua.LUA_TNUMBER || type === lua.LUA_TSTRING)
    return to_jsstring(lua.lua_tostring(L, index) ?? new Uint8Array())
  return to_jsstring(lua.lua_typename(L, type))
}
