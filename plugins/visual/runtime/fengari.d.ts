declare module "fengari/src/fengaricore.js" {
  export function to_luastring(text: string): Uint8Array
  export function to_jsstring(bytes: Uint8Array, from?: number, to?: number, replacement?: boolean): string
}

declare module "fengari/src/lua.js" {
  export type LuaMeter = { buffer(size: number): void; string(size: number): void; entry(): void }
  export type LuaState = { readonly __lua: unique symbol; readonly l_G: { meter?: LuaMeter } }
  export const LUA_OK: number
  export const LUA_ERRRUN: number
  export const LUA_ERRSYNTAX: number
  export const LUA_ERRMEM: number
  export const LUA_TNIL: number
  export const LUA_TBOOLEAN: number
  export const LUA_TNUMBER: number
  export const LUA_TSTRING: number
  export const LUA_TTABLE: number
  export const LUA_TFUNCTION: number
  export const LUA_REGISTRYINDEX: number
  export const LUA_MASKCOUNT: number
  export const LUA_MULTRET: number
  export function lua_gettop(L: LuaState): number
  export function lua_settop(L: LuaState, index: number): void
  export function lua_pop(L: LuaState, n: number): void
  export function lua_type(L: LuaState, index: number): number
  export function lua_typename(L: LuaState, type: number): Uint8Array
  export function lua_toboolean(L: LuaState, index: number): boolean
  export function lua_tonumber(L: LuaState, index: number): number
  export function lua_isinteger(L: LuaState, index: number): boolean
  export function lua_tostring(L: LuaState, index: number): Uint8Array | null
  export function lua_pushnil(L: LuaState): void
  export function lua_pushboolean(L: LuaState, value: boolean): void
  export function lua_pushnumber(L: LuaState, value: number): void
  export function lua_pushinteger(L: LuaState, value: number): void
  export function lua_pushstring(L: LuaState, value: Uint8Array): void
  export function lua_pushliteral(L: LuaState, value: string): void
  export function lua_pushvalue(L: LuaState, index: number): void
  export function lua_insert(L: LuaState, index: number): void
  export function lua_replace(L: LuaState, index: number): void
  export function lua_pushjsfunction(L: LuaState, fn: (L: LuaState) => number): void
  export function lua_newtable(L: LuaState): void
  export function lua_createtable(L: LuaState, narr: number, nrec: number): void
  export function lua_setfield(L: LuaState, index: number, key: Uint8Array): void
  export function lua_getfield(L: LuaState, index: number, key: Uint8Array): number
  export function lua_setglobal(L: LuaState, name: Uint8Array): void
  export function lua_getglobal(L: LuaState, name: Uint8Array): number
  export function lua_rawgeti(L: LuaState, index: number, n: number): number
  export function lua_rawseti(L: LuaState, index: number, n: number): void
  export function lua_rawlen(L: LuaState, index: number): number
  export function lua_next(L: LuaState, index: number): number
  export function lua_setmetatable(L: LuaState, index: number): void
  export function lua_pcall(L: LuaState, nargs: number, nresults: number, msgh: number): number
  export function lua_call(L: LuaState, nargs: number, nresults: number): void
  export function lua_sethook(L: LuaState, hook: ((L: LuaState) => void) | null, mask: number, count: number): void
  export function lua_absindex(L: LuaState, index: number): number
}

declare module "fengari/src/lauxlib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaL_newstate(): LuaState
  export function luaL_loadbuffer(L: LuaState, buffer: Uint8Array, size: number | null, name: Uint8Array): number
  export function luaL_requiref(L: LuaState, name: Uint8Array, open: (L: LuaState) => number, global: number): void
  export function luaL_ref(L: LuaState, table: number): number
  export function luaL_unref(L: LuaState, table: number, ref: number): void
  export function luaL_error(L: LuaState, message: Uint8Array): never
  export function luaL_traceback(L: LuaState, L1: LuaState, message: Uint8Array | null, level: number): void
}

declare module "fengari/src/lbaselib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaopen_base(L: LuaState): number
}

declare module "fengari/src/ltablib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaopen_table(L: LuaState): number
}

declare module "fengari/src/lstrlib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaopen_string(L: LuaState): number
}

declare module "fengari/src/lmathlib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaopen_math(L: LuaState): number
}

declare module "fengari/src/lutf8lib.js" {
  import type { LuaState } from "fengari/src/lua.js"
  export function luaopen_utf8(L: LuaState): number
}
