/** I3: 24 glyphs built on a 24-unit grid, one stroke weight, at most one solid part. */
export const PROJECT_GLYPHS = {
  pipeline: '<path d="M4 7h16M7 12h10M10 17h4"/><rect class="f" x="11" y="19.5" width="2" height="2"/>',
  onboarding: '<path d="M7 20V11a5 5 0 0 1 10 0v9M4 20h16"/><rect class="f" x="13" y="14" width="2" height="2"/>',
  invoices: '<path d="M6 4h12v16H6zM9 9h6M9 13h6"/><rect class="f" x="13" y="16" width="2" height="2"/>',
  personal: '<circle cx="12" cy="12" r="8"/><circle class="f" cx="15" cy="9" r="2"/>',
  garden: '<path d="M12 21V11M12 11c0-4 3-7 7-7 0 4-3 7-7 7z"/><path class="f" d="M12 14c0-3-2-5-5-5 0 3 2 5 5 5z"/>',
  research: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20"/><rect class="f" x="9" y="9" width="2" height="2"/>',
  travel: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="3.5" ry="8"/><path d="M4 12h16"/>',
  reading: '<path d="M4 6h7v13H4zM13 6h7v13h-7z"/><rect class="f" x="15" y="6" width="2" height="5"/>',
  health: '<path d="M3 12h5l2-5 4 10 2-5h5"/>',
  finance:
    '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/>',
  music: '<circle cx="7" cy="17" r="3"/><circle class="f" cx="17" cy="15" r="3"/><path d="M10 17V5l10-2v12"/>',
  home: '<path d="M4 11l8-6 8 6v9H4z"/><rect class="f" x="11" y="14" width="2" height="6"/>',
  writing: '<path d="M5 19L17 7"/><path class="f" d="M17 7l2-2 2 2-2 2z"/><path d="M4 21h8"/>',
  events: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/><rect class="f" x="13" y="14" width="3" height="3"/>',
  hiring: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  launch: '<path d="M12 3l6 12H6z"/><path d="M12 15v6"/><rect class="f" x="11" y="9" width="2" height="2"/>',
  data: '<path d="M6 20V12M12 20V5M18 20v-5M3 20h18"/>',
  legal: '<path d="M12 4v16M5 7h14M8 20h8"/><path class="f" d="M5 7l-3 6h6z"/><path d="M19 7l-3 6h6z"/>',
  photos: '<path d="M3 5h18v14H3z"/><path d="M3 17l6-6 5 5 3-3 4 4"/><circle class="f" cx="16" cy="9" r="1.5"/>',
  learning: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c2 2 10 2 12 0v-5"/>',
  support:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M6.3 6.3l3.2 3.2M17.7 6.3l-3.2 3.2M6.3 17.7l3.2-3.2M17.7 17.7l-3.2-3.2"/>',
  ops: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle class="f" cx="12" cy="12" r="2"/>',
  marketing: '<path d="M4 10v4h3l8 5V5L7 10z"/><path d="M18 9v6"/>',
  family:
    '<circle class="f" cx="12" cy="6" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M10.5 8.2L7.4 14.8M13.5 8.2l3.1 6.6M8.5 17h7"/>',
} as const

export type ProjectGlyphName = keyof typeof PROJECT_GLYPHS

const NAMES = Object.keys(PROJECT_GLYPHS) as readonly ProjectGlyphName[]

/** Words that name an object, so the sidebar reads by shape before it reads the names. */
const HINTS: readonly (readonly [RegExp, ProjectGlyphName])[] = [
  [/\b(hir|recruit|candidate|interview|job post|headcount)/iu, "hiring"],
  [/\b(onboard|welcome|first week|ramp)/iu, "onboarding"],
  [/\b(invoice|receipt|billing|payable)/iu, "invoices"],
  [/\b(finance|budget|bookkeep|account|revenue)/iu, "finance"],
  [/\b(legal|contract|policy|compliance)/iu, "legal"],
  [/\b(research|study|survey|analysis|competitor)/iu, "research"],
  [/\b(travel|trip|flight|hotel|itinerary)/iu, "travel"],
  [/\b(read|book|library|paper|novel)/iu, "reading"],
  [/\b(health|fitness|run|workout|sleep)/iu, "health"],
  [/\b(music|song|album|playlist|podcast)/iu, "music"],
  [/\b(garden|plant|grow)/iu, "garden"],
  [/\b(home|house|flat|move|renovat)/iu, "home"],
  [/\b(family|kids|parent|birthday)/iu, "family"],
  [/\b(writ|draft|essay|copy|story|blog)/iu, "writing"],
  [/\b(event|calendar|meet|conference|launch party)/iu, "events"],
  [/\b(launch|release|ship|design|brand)/iu, "launch"],
  [/\b(data|analytics|metric|warehouse|report)/iu, "data"],
  [/\b(photo|image|camera|shoot)/iu, "photos"],
  [/\b(learn|course|teach|training|curriculum)/iu, "learning"],
  [/\b(support|ticket|help desk|customer)/iu, "support"],
  [/\b(ops|pipeline|process|workflow|automation)/iu, "ops"],
  [/\b(marketing|campaign|audience|seo|ads)/iu, "marketing"],
  [/\b(personal|journal|habit|routine)/iu, "personal"],
]

/** Suggested from the project's words, then by slug when nothing matches. The word that comes first wins. */
export function projectGlyph(...words: readonly string[]): ProjectGlyphName {
  const text = words.join(" ").trim()
  let best: { readonly at: number; readonly name: ProjectGlyphName } | undefined
  for (const [pattern, name] of HINTS) {
    const found = pattern.exec(text)
    if (found === null) continue
    if (best === undefined || found.index < best.at) best = { at: found.index, name }
  }
  if (best !== undefined) return best.name
  let hash = 0
  for (const char of text) hash = (hash + char.charCodeAt(0)) % NAMES.length
  return NAMES[hash] ?? "pipeline"
}
