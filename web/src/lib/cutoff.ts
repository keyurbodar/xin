export const CUT_OFF_MS = 10_000

/**
 * How long until the app is cut off: the banner covers a short drop, and past ten seconds without a socket, or with no
 * network at all, the offline screen takes over. A socket held closed on purpose is never an outage.
 */
export function cutOffIn(
  state: { readonly online: boolean; readonly held: boolean; readonly since: number | undefined },
  now: number,
): number | undefined {
  if (state.held) return undefined
  if (!state.online) return 0
  if (state.since === undefined) return undefined
  return Math.max(0, state.since + CUT_OFF_MS - now)
}
