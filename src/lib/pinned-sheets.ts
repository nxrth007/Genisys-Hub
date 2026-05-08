/**
 * Pinned Google Sheets — surfaced at the top of /documents so the
 * team can view + edit the two operationally-critical spreadsheets
 * without bouncing to Google Drive.
 *
 *   1. Genisys Financial Dashboard
 *      Where Alex tracks revenue, expenses, and margin for the
 *      agency. Drives every "are we profitable this month" decision.
 *
 *   2. Mary Client Sheet
 *      Per-client fulfillment status + qualification criteria for
 *      booking. This is the source of truth Mary checks against
 *      every appointment to decide if a lead qualifies — keeping it
 *      front-and-center on the Hub means the team can update
 *      criteria the moment a client changes their requirements.
 *
 * Embed strategy:
 *   - The full Google Sheets UI loads in an iframe (?embedded=true),
 *     which means editing works in-place for users signed into
 *     Google in the same browser. This is the simplest "actually
 *     edit a sheet" experience we can give without re-implementing
 *     Google Sheets from scratch.
 *   - Cookie/X-Frame-Options edge cases (third-party-cookie blocked
 *     browsers, incognito tabs without Google session) are caught
 *     by the prominent "Open in Google Sheets" escape button on
 *     each card.
 *
 * Adding a third sheet later: append a new entry here, no other
 * changes needed.
 */

export type PinnedSheet = {
  /** Stable key used in React keys + analysis dispatch. */
  key: 'financials' | 'fulfillment'
  /** Display title shown in the card header. */
  title: string
  /** One-liner so admin remembers what each sheet is for. */
  description: string
  /** Google Sheets file id. */
  spreadsheetId: string
  /** Default tab gid (numeric sheetId Google uses in URLs). */
  defaultGid: number
  /**
   * Tone classes for the card accent — matches the existing color
   * vocabulary used on /settings cards (emerald for money, violet
   * for client comms).
   */
  accent: {
    badgeBg: string
    badgeText: string
    iconBg: string
    iconText: string
  }
}

export const PINNED_SHEETS: PinnedSheet[] = [
  {
    key: 'financials',
    title: 'Genisys Financial Dashboard',
    description:
      'Revenue, expenses, and margin for the agency. The single source of truth for "are we profitable" — update tabs as money moves.',
    spreadsheetId: '1Dt2lIr8qv-uPrITdkfxfvBp0V3wQe-AUUDqFKD3a-Bk',
    defaultGid: 494286460,
    accent: {
      badgeBg: 'bg-emerald-50 dark:bg-emerald-950',
      badgeText: 'text-emerald-700 dark:text-emerald-300',
      iconBg: 'bg-emerald-50 dark:bg-emerald-950',
      iconText: 'text-emerald-600 dark:text-emerald-300',
    },
  },
  {
    key: 'fulfillment',
    title: 'Mary Client Sheet',
    description:
      "Per-client fulfillment + qualification criteria. Mary's reference whenever an appointment lands — keep this updated the moment a client tweaks their requirements.",
    spreadsheetId: '1OL0pkuKihrid8uzsO5vo6ZH9n_wcmdCOgdoRGIm9sn8',
    defaultGid: 1833651533,
    accent: {
      badgeBg: 'bg-violet-50 dark:bg-violet-950',
      badgeText: 'text-violet-700 dark:text-violet-300',
      iconBg: 'bg-violet-50 dark:bg-violet-950',
      iconText: 'text-violet-600 dark:text-violet-300',
    },
  },
]

/**
 * Iframe-embeddable URL. `embedded=true` strips Google's chrome
 * (toolbars, file menu) but keeps the cell grid + edit affordances.
 * We append `&rm=minimal` to drop the bottom menu bar too — fewer
 * pixels lost to Google UI inside the iframe.
 *
 * The trailing `#gid=` is what actually controls which tab loads;
 * Google ignores the gid query param in some cases, so we put it
 * in both places for reliability.
 */
export function getEmbedUrl(s: PinnedSheet, gid?: number): string {
  const targetGid = gid ?? s.defaultGid
  return `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit?embedded=true&rm=minimal&gid=${targetGid}#gid=${targetGid}`
}

/** Full-tab URL — what the "Open in Google Sheets" button uses. */
export function getViewUrl(s: PinnedSheet, gid?: number): string {
  const targetGid = gid ?? s.defaultGid
  return `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit?gid=${targetGid}#gid=${targetGid}`
}

/**
 * Look up a pinned sheet by its stable `key`. Used by the detail
 * route at /documents/sheets/[key] to validate the param + load the
 * right config. Returns undefined for unknown keys; callers should
 * 404 on undefined.
 */
export function findPinnedSheet(key: string): PinnedSheet | undefined {
  return PINNED_SHEETS.find((s) => s.key === key)
}
