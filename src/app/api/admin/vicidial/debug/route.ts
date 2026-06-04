import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  fetchVicidialStats,
  getLastRawVicidialHtml,
} from '@/lib/vicidial-stats'

/**
 * GET /api/admin/vicidial/debug
 *
 * Returns the parsed stats + slices of the raw Vicidial admin.php
 * HTML so we can iterate on the regex without redeploying. Admin
 * only — exposes raw HTML which is harmless on its own but never
 * worth surfacing more widely.
 *
 * Triggers a fresh fetch if no cached raw HTML exists, otherwise
 * returns whatever was cached on the last /api/team/vicidial/stats
 * call (within the last 5 minutes).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Force a fresh scrape so cached raw HTML is current.
  const result = await fetchVicidialStats()
  const raw = getLastRawVicidialHtml()

  // Pull short slices around each label we care about — full HTML
  // can be megabytes. 600 chars before / after each label gives us
  // enough context to write the right regex without dumping the
  // whole page.
  const labels = [
    'Agents Logged In',
    'Agents In Calls',
    'Active Calls',
    'Calls Ringing',
    'Users:',
    'Campaigns:',
    'Lists:',
    'In-Groups:',
    'DIDs:',
    'Total Stats for Today',
    'Total Stats for Yesterday',
  ]
  const slices: Record<string, string | null> = {}
  if (raw) {
    for (const label of labels) {
      const idx = raw.html.indexOf(label)
      if (idx === -1) {
        slices[label] = null
      } else {
        const start = Math.max(0, idx - 200)
        const end = Math.min(raw.html.length, idx + 600)
        slices[label] = raw.html.slice(start, end)
      }
    }
  }

  return NextResponse.json({
    parsed: result,
    rawAvailable: !!raw,
    rawFetchedAt: raw?.fetchedAt ?? null,
    rawLength: raw?.html.length ?? 0,
    slices,
  })
}
