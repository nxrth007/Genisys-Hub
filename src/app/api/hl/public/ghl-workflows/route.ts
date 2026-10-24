import { NextResponse } from 'next/server'
import { hlError, hlGuard, HlInputError } from '@/lib/hl/http'
import { createExportKey, receiveExport, reimportSaved } from '@/lib/hl/ghl-workflows'

/**
 * GoHighLevel workflows → Hell-level (src/lib/hl/ghl-workflows.ts). Under /api/hl/public
 * because the copy script posts from GHL's site with no Hub session; the
 * signed-in calls check the session themselves (hlGuard).
 *
 * GET ?accountId=…          (signed in) a one-time key for the copy script.
 * PUT ?accountId=…          (signed in) run the import again from the copy already here.
 * POST, header x-import-key  the copy script in GHL's tab sends the export.
 *   It runs on GHL's site, so this one answers cross-site; the key, not a
 *   cookie, is what lets it in.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-import-key',
  'access-control-max-age': '600',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const accountId = new URL(req.url).searchParams.get('accountId') ?? ''
  try {
    return NextResponse.json(await createExportKey(accountId, guard.email))
  } catch (err) {
    return hlError(err, 'GHL workflow copy key')
  }
}

export async function PUT(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const accountId = new URL(req.url).searchParams.get('accountId') ?? ''
  try {
    const result = await reimportSaved(accountId)
    console.log(`[hell-level] ${guard.email} re-imported GHL workflows for ${accountId}: ${result.workflows} workflows`)
    return NextResponse.json({ result })
  } catch (err) {
    return hlError(err, 'GHL workflow re-import')
  }
}

export async function POST(req: Request) {
  try {
    const key = req.headers.get('x-import-key') ?? ''
    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new HlInputError('The copy wasn’t readable.')
    }
    const { accountId, result } = await receiveExport(key, body)
    console.log(`[hell-level] GHL workflows copied into ${accountId}: ${result.workflows} workflows, ${result.published} on`)
    return NextResponse.json({ result }, { headers: CORS })
  } catch (err) {
    const res = hlError(err, 'GHL workflow copy')
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
    return res
  }
}
