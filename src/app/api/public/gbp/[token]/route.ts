import { NextResponse } from 'next/server'
import { publicSetupDone } from '@/lib/gbp-setup'

/**
 * POST /api/public/gbp/:token — the client's "Done" on their Google Business
 * Profile setup page: { profileUrl }. Public (no Hub account); the secret
 * token is the access, and it can only record a Google link for its own client.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = (await req.json().catch(() => ({}))) as { profileUrl?: unknown }
  const result = await publicSetupDone(token, body.profileUrl)
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === 'This link is no longer valid.' ? 404 : 400 })
}
