/**
 * What a sub-account's own login sees of Genisys OS (role "hl_user": the
 * contractor and their staff, src/lib/hl/logins.ts): these sections and
 * tabs of their own sub-accounts, nothing under them. Settings, automations,
 * numbers, domains and billing stay with Genisys. src/middleware.ts holds
 * them to it, the shell shows only these, and the API routes they need call
 * hlAccountGuard (everything else is hlGuard: Genisys only).
 *
 * No imports: the middleware reads this.
 */

export const HL_MEMBER_ROLE = 'hl_user'

/** Section → the tabs they get (the first is the section's default). */
export const MEMBER_SECTIONS: Record<string, string[]> = {
  dashboard: [],
  conversations: ['conversations'],
  calendars: ['calendar', 'appointments'],
  contacts: ['smart-lists', 'tasks'],
  opportunities: ['opportunities'],
}

export const MEMBER_HOME_SECTION = 'dashboard'

/**
 * Where a sub-account login may go under /genisys-os, or where to send them
 * instead: /genisys-os itself (it opens their sub-account) and
 * /genisys-os/<id>/<section>[?tab=] for the sections above.
 */
export function memberPagePath(pathname: string, tab: string | null): { ok: true } | { ok: false; to: string } {
  const parts = pathname.split('/').filter(Boolean) // ['genisys-os', id?, section?, ...]
  if (parts[0] !== 'genisys-os') return { ok: false, to: '/genisys-os' }
  if (parts.length === 1) return { ok: true }
  const [, accountId, section] = parts
  if (accountId === 'agency') return { ok: false, to: '/genisys-os' }
  const home = `/genisys-os/${accountId}/${MEMBER_HOME_SECTION}`
  if (!section || parts.length > 3 || !(section in MEMBER_SECTIONS)) return { ok: false, to: home }
  const tabs = MEMBER_SECTIONS[section]
  if (tab && !tabs.includes(tab)) return { ok: false, to: `/genisys-os/${accountId}/${section}` }
  return { ok: true }
}
