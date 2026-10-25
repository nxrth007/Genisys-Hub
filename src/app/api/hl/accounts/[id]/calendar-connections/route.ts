import { NextResponse } from 'next/server'
import { getPublicOrigin } from '@/lib/drive'
import { connectApp, connectTarget, googleConsentUrl, listConnections, shareableConnectLink } from '@/lib/hl/google-calendar'
import { HlInputError, hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the team's Google Calendar connections (never their sign-ins). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  // Which Google app new connections sign in through: Hell-level's own (open to anyone's account once Google verifies it), the Hub's, or none.
  return NextResponse.json({ connections: await listConnections(id), googleApp: (await connectApp())?.kind ?? null })
}

/**
 * POST { staffKey, action: 'connect' | 'link' }: Google's sign-in to connect
 * a team member's calendar here and now ('connect', back to Settings), or a
 * week-long link to send them so they connect it themselves ('link').
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const staffKey = typeof body.staffKey === 'string' ? body.staffKey : ''
    if (!staffKey || !(await connectTarget(id, staffKey))) throw new HlInputError('Pick a team member on this sub-account.')
    if (!(await connectApp())) throw new HlInputError('No Google app is set up for calendar connections yet.')
    if (body.action === 'link') return NextResponse.json({ url: shareableConnectLink(id, staffKey) })
    return NextResponse.json({ url: await googleConsentUrl(getPublicOrigin(req), { accountId: id, staffKey, back: 'hub' }) })
  } catch (err) {
    return hlError(err, 'connect Google Calendar')
  }
}
