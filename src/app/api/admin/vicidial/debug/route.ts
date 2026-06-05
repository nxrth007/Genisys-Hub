import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  fetchVicidialStats,
  getLastRawVicidialHtml,
} from '@/lib/vicidial-stats'
import {
  fetchVicidialUsers,
  getLastRawVicidialUsersHtml,
} from '@/lib/vicidial-users'

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

  // Force a fresh scrape on BOTH endpoints so cached raw HTML is
  // current for the dashboard and the Users listing.
  const result = await fetchVicidialStats()
  const raw = getLastRawVicidialHtml()
  const usersResult = await fetchVicidialUsers()
  const usersRaw = getLastRawVicidialUsersHtml()

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

  // Users page — give back a few representative slices so we can
  // see what the actual row structure looks like. Anchor on the
  // 850-prefix that Genisys's BPO uses for agent user IDs, plus
  // generic anchors like "USER ID" header + "Agents" group label.
  const usersSlices: Record<string, string | null> = {}
  if (usersRaw) {
    // Find the table header
    const headerIdx = usersRaw.html.indexOf('USER ID')
    usersSlices['__header'] =
      headerIdx === -1
        ? null
        : usersRaw.html.slice(
            Math.max(0, headerIdx - 100),
            headerIdx + 1500,
          )
    // Find a sample user row by 850-prefix (Genisys's BPO convention)
    const sampleIdx = usersRaw.html.indexOf('850001')
    usersSlices['__sample_user_row'] =
      sampleIdx === -1
        ? null
        : usersRaw.html.slice(
            Math.max(0, sampleIdx - 300),
            sampleIdx + 1200,
          )
    // A second sample to see if the pattern is consistent
    const sample2Idx = usersRaw.html.indexOf('850005')
    usersSlices['__second_sample'] =
      sample2Idx === -1
        ? null
        : usersRaw.html.slice(
            Math.max(0, sample2Idx - 200),
            sample2Idx + 1000,
          )
  }

  return NextResponse.json({
    parsed: result,
    rawAvailable: !!raw,
    rawFetchedAt: raw?.fetchedAt ?? null,
    rawLength: raw?.html.length ?? 0,
    slices,
    usersParsed: usersResult,
    usersRawAvailable: !!usersRaw,
    usersRawFetchedAt: usersRaw?.fetchedAt ?? null,
    usersRawLength: usersRaw?.html.length ?? 0,
    usersSlices,
  })
}
