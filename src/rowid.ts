import { str } from "@earendil-works/pi-schema"
import { MAX_PACKAGE_NAME } from "./npmname.ts"

export const MAX_FRAGMENT = 64
export const MAX_ROW_ID = MAX_PACKAGE_NAME + 1 + MAX_FRAGMENT

const FRAGMENT_BODY = "[A-Za-z0-9][A-Za-z0-9._-]*"
const PACKAGE_BODY = "(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*"

export const FRAGMENT_PATTERN = `^${FRAGMENT_BODY}$`
export const RUNTIME_ROW_PATTERN = `^${PACKAGE_BODY}#${FRAGMENT_BODY}$`
export const ROW_ID_PATTERN = `^(?:${FRAGMENT_BODY}|${PACKAGE_BODY}#${FRAGMENT_BODY})$`

const FRAGMENT = new RegExp(FRAGMENT_PATTERN)
const RUNTIME_ROW = new RegExp(RUNTIME_ROW_PATTERN)
const HASH = "#"

export const FragmentId = str({ minLength: 1, maxLength: MAX_FRAGMENT, pattern: FRAGMENT_PATTERN })
export const RowId = str({ minLength: 1, maxLength: MAX_ROW_ID, pattern: ROW_ID_PATTERN })

export const isFragment = (id: string): boolean => id.length <= MAX_FRAGMENT && FRAGMENT.test(id)

export const isRuntimeRowId = (id: string): boolean => id.length <= MAX_ROW_ID && RUNTIME_ROW.test(id)

export const runtimeRowId = (pkg: string, row: string): string => `${pkg}${HASH}${row}`
