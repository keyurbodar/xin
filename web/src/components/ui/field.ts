const SHELL =
  "rounded-[8px] border border-line bg-fill shadow-[inset_0_var(--hl-y)_0_0_var(--hl-top)] outline-none transition-[background-color,border-color] duration-[120ms] ease-[var(--ease-kiko)] hover:border-line-inner hover:bg-fill-strong"

const INK = "text-fg placeholder:text-fg-4 focus:border-line-strong focus:bg-fill-strong"

export const FIELD = `h-8 w-full ${SHELL} ${INK} px-2.5 text-[13.5px] disabled:opacity-50`

export const MONO_FIELD = `h-8 w-full ${SHELL} ${INK} px-2.5 font-mono text-[12.5px] disabled:opacity-50`

export const FIELD_AREA = `w-full ${SHELL} ${INK} px-3 py-2.5 text-[13.5px] leading-[1.55]`

export const MONO_AREA = `w-full ${SHELL} ${INK} px-3 py-2.5 font-mono text-[12.5px] leading-relaxed`

export const FIELD_ROW = `flex h-8 items-center gap-2 ${SHELL} ${INK} px-3 text-[13.5px] focus-within:border-line-strong focus-within:bg-fill-strong`

export const FIELD_BOX = `overflow-hidden ${SHELL} focus-within:border-line-strong focus-within:bg-fill-strong`
