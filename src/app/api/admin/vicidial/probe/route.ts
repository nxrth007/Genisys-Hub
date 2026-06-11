import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { vicidialAdminFetch } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/probe?path=admin.php%3FADD%3D100&find=TOTAL&max=3
 *
 * Generic Vicidial page prober — the iteration tool for building
 * scrapers against pages we can't see locally (vault creds are
 * server-side, vicitel is IP-whitelisted to Render). Fetches an
 * admin-relative path with the configured credentials and returns
 * structured diagnostics instead of raw HTML dumps:
 *
 *   - status / final URL / page title / body length
 *   - data-row count (records_list_x/y) + first row snippet
 *   - head + tail slices
 *   - when `find` is set: up to `max` 400-char windows around each
 *     case-insensitive match
 *
 * Admin ONLY (not member) — this can read any admin page in the
 * dialer. Path is pinned relative to the /vicidial/ base: no
 * scheme, no host, no traversal. The lesson that motivated this:
 * the vicidial-users parser took 5 deploy round-trips because every
 * markup question needed a code change; with this endpoint a markup
 * question is one URL Alex can paste back.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const path = (sp.get('path') || '').trim()
  const find = (sp.get('find') || '').trim()
  const max = Math.min(10, Math.max(1, parseInt(sp.get('max') || '3', 10) || 3))

  if (!path) {
    return NextResponse.json(
      { error: 'path query param required, e.g. ?path=admin.php%3FADD%3D100' },
      { status: 400 },
    )
  }
  // Relative-only: no scheme/host smuggling, no parent traversal.
  if (/^[a-z]+:\/\//i.test(path) || path.includes('..') || path.startsWith('/')) {
    return NextResponse.json(
      { error: 'path must be relative to /vicidial/ (e.g. "admin.php?ADD=100")' },
      { status: 400 },
    )
  }

  const res = await vicidialAdminFetch(path)
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 502 })
  }

  const html = res.html
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i)
  const rowRe =
    /<tr[^>]*class=['"][^'"]*records_list_[xy][^'"]*['"][^>]*>([\s\S]*?)<\/tr>/gi
  let rowCount = 0
  let firstRow: string | null = null
  let m
  while ((m = rowRe.exec(html))) {
    rowCount++
    if (!firstRow) firstRow = m[0].slice(0, 500).replace(/\s+/g, ' ')
  }

  const matches: Array<{ index: number; window: string }> = []
  if (find) {
    const lower = html.toLowerCase()
    const needle = find.toLowerCase()
    let from = 0
    while (matches.length < max) {
      const idx = lower.indexOf(needle, from)
      if (idx === -1) break
      matches.push({
        index: idx,
        window: html
          .slice(Math.max(0, idx - 150), idx + needle.length + 250)
          .replace(/\s+/g, ' '),
      })
      from = idx + needle.length
    }
  }

  return NextResponse.json(
    {
      ok: true,
      status: res.status,
      finalUrl: res.finalUrl,
      title: titleMatch ? titleMatch[1].trim() : null,
      length: html.length,
      dataRowCount: rowCount,
      firstDataRow: firstRow,
      head: html.slice(0, 600).replace(/\s+/g, ' '),
      tail: html.slice(-600).replace(/\s+/g, ' '),
      ...(find ? { find, matchCount: matches.length, matches } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
