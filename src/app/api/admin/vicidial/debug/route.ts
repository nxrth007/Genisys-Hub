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

  // Users page diagnostic slices.
  const usersSlices: Record<string, string | null> = {}
  if (usersRaw) {
    // First 2000 chars so we can verify which Vicidial page the
    // scrape actually landed on (header, title, top of table).
    usersSlices['__preview_first_2000'] = usersRaw.html.slice(0, 2000)
    // <title> tag value if present
    const titleMatch = usersRaw.html.match(/<title>([\s\S]*?)<\/title>/i)
    usersSlices['__title'] = titleMatch ? titleMatch[1].trim() : null
    // Try multiple header anchors — Vicidial 2.14 uses any of these
    // depending on page variant.
    for (const anchor of ['USER ID', 'USER LISTING', 'USER LISTINGS', 'user_id']) {
      const idx = usersRaw.html.indexOf(anchor)
      usersSlices[`__anchor_${anchor.replace(/\s+/g, '_')}`] =
        idx === -1
          ? null
          : usersRaw.html.slice(
              Math.max(0, idx - 100),
              idx + 1500,
            )
    }
    // Sample user rows (the 850xxx convention at this BPO)
    const sampleIdx = usersRaw.html.indexOf('850001')
    usersSlices['__sample_850001'] =
      sampleIdx === -1
        ? null
        : usersRaw.html.slice(
            Math.max(0, sampleIdx - 300),
            sampleIdx + 1200,
          )
    const sample2Idx = usersRaw.html.indexOf('850005')
    usersSlices['__sample_850005'] =
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
