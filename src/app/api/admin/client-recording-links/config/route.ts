import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import {
  clientRecordingLinksEnabled,
  setClientRecordingLinksEnabled,
} from '@/lib/client-recording-flag'

/**
 * GET / PATCH /api/admin/client-recording-links/config
 *
 * Master toggle for exposing call-recording links to CLIENTS — the
 * client Slack post, the client email, and the client dashboard
 * Listen button. Internal/admin/agent playback is unaffected.
 *
 * Storage is the AppSetting KV row `clientRecordingLinks.enabled`.
 * Disabled by Alex 2026-06-17; this endpoint lets him flip it back
 * on without a deploy.
 *
 * PATCH body: { enabled: boolean }
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const enabled = await clientRecordingLinksEnabled()
  return NextResponse.json({ enabled })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { enabled?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'enabled must be a boolean' },
      { status: 400 },
    )
  }

  await setClientRecordingLinksEnabled(body.enabled)
  return NextResponse.json({ ok: true, enabled: body.enabled })
}
