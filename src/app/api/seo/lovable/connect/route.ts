import { NextRequest, NextResponse } from 'next/server'
import { seoGuard } from '@/lib/seo/http'
import { disconnectLovable, finishLovableConnect, LovableMcpError, startLovableConnect, testLovableConnection } from '@/lib/seo/lovable-mcp'

/**
 * The Hub's own sign-in to Lovable, so it can publish a project after a
 * merge (see lib/seo/lovable-mcp.ts). Alex + Ethan only.
 *
 *   POST { step: 'start' }                    → { authorizeUrl } to open in a new tab
 *   POST { step: 'finish', redirectUrl }      → exchanges the code from the pasted address
 *   POST { step: 'test' }                     → who the Hub is signed in as
 *   DELETE                                    → revoke and forget the sign-in
 */
function fail(err: unknown, where: string) {
  if (err instanceof LovableMcpError) return NextResponse.json({ error: err.message }, { status: 400 })
  console.error(`[seo] lovable ${where} failed:`, err)
  return NextResponse.json({ error: err instanceof Error ? err.message : 'Something went wrong.' }, { status: 500 })
}

export async function POST(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const body = (await req.json().catch(() => ({}))) as { step?: string; redirectUrl?: string }
  try {
    if (body.step === 'start') return NextResponse.json(await startLovableConnect())
    if (body.step === 'finish') {
      if (!body.redirectUrl?.trim()) return NextResponse.json({ error: 'Paste the address from the browser tab.' }, { status: 400 })
      return NextResponse.json({ ok: true, ...(await finishLovableConnect(body.redirectUrl, guard.email)) })
    }
    if (body.step === 'test') return NextResponse.json({ ok: true, ...(await testLovableConnection()) })
    return NextResponse.json({ error: 'Unknown step.' }, { status: 400 })
  } catch (err) {
    return fail(err, body.step ?? 'connect')
  }
}

export async function DELETE() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    await disconnectLovable()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return fail(err, 'disconnect')
  }
}
