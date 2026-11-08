import { str } from "@earendil-works/pi-schema"

export const MAX_FRAGMENT = 64

const FRAGMENT_BODY = "[A-Za-z0-9][A-Za-z0-9._-]*"

export const FRAGMENT_PATTERN = `^${FRAGMENT_BODY}$`

const FRAGMENT = new RegExp(FRAGMENT_PATTERN)

export const FragmentId = str({ minLength: 1, maxLength: MAX_FRAGMENT, pattern: FRAGMENT_PATTERN })

export const isFragment = (id: string): boolean => id.length <= MAX_FRAGMENT && FRAGMENT.test(id)
