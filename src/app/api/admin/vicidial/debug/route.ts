import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  fetchVicidialStats,
  getLastRawVicidialHtml,
} from '@/lib/vicidial-stats'

/**
 * GET /api/admin/vicidial/debug
 *
 * Diagnostic for the Vicidial dashboard scraper. Returns slices of
 * the raw admin.php HTML around each label we parse so we can
 * iterate on the regex without redeploying when Vicidial changes
 * markup.
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

  const result = await fetchVicidialStats()
  const raw = getLastRawVicidialHtml()

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
