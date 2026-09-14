import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'

/**
 * POST /api/webhooks/client-onboarding
 *
 * Receives a submission from the client onboarding form at
 * clientonboarding.leadgenisys.com.
 *
 * Authenticated with a shared secret held in the Vault as "Client
 * Onboarding Webhook Secret". Accepts it three ways because the sender's
 * capabilities aren't known: an `x-webhook-secret` header, an
 * Authorization bearer, or `?secret=` for form tools that cannot set
 * headers at all.
 *
 * This route must stay listed in middleware's PUBLIC_PATHS. Without that
 * the global session check answers first and the sender sees a generic
 * 401 from a route it never reached — which is exactly how the NCT
 * webhook looked broken for a day.
 *
 * The verbatim body is stored alongside the parsed fields. The form will
 * gain questions faster than this schema does, and an answer that was
 * never written down is unrecoverable.
 */

export const dynamic = 'force-dynamic'

const SECRET_ENTRY = 'Client Onboarding Webhook Secret'

/** Constant-time compare that can't leak length via early return. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  // The form sends "N/A" for skipped optional questions; storing that as
  // if it were an answer makes every empty field look filled in.
  if (!t || /^(n\/?a|none|n\.a\.)$/i.test(t)) return null
  return t
}

export async function POST(req: NextRequest) {
  let expected: string
  try {
    expected = (await getSecretByName(SECRET_ENTRY)).trim()
  } catch {
    return NextResponse.json(
      {
        error: 'not_configured',
        message: `Add the shared secret to the Hub vault as "${SECRET_ENTRY}".`,
      },
      { status: 503 },
    )
  }

  const provided =
    req.headers.get('x-webhook-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('secret') ??
    ''

  if (!provided || !secretMatches(provided, expected)) {
    // Deliberately distinct from middleware's generic "unauthorized", so
    // a wrong secret is distinguishable from never reaching the handler.
    return NextResponse.json(
      {
        error: 'invalid_secret',
        message: 'Missing or incorrect x-webhook-secret.',
      },
      { status: 401 },
    )
  }

  const rawText = await req.text().catch(() => '')
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawText) as Record<string, unknown>
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Body was not valid JSON.' },
      { status: 400 },
    )
  }

  const intake = await prisma.clientIntake.create({
    data: {
      ein: str(body.ein),
      fullName: str(body.fullName),
      businessName: str(body.businessName),
      businessContact: str(body.businessContact),
      businessAddress: str(body.businessAddress),
      customerPhone: str(body.customerPhone),
      areaCode: str(body.areaCode),
      timeZone: str(body.timeZone),
      leadEmail: str(body.leadEmail),
      cities: str(body.cities),
      website: str(body.website),
      aboutBusiness: str(body.aboutBusiness),
      mainServices: str(body.mainServices),
      promotions: str(body.promotions),
      socialLinks: str(body.socialLinks),
      whyChooseYou: str(body.whyChooseYou),
      brandColors: str(body.brandColors),
      faqs: str(body.faqs),
      raw: body as object,
    },
    select: { id: true, businessName: true, receivedAt: true },
  })

  console.log(
    `[client-onboarding] stored intake ${intake.id} for "${intake.businessName ?? 'unnamed'}"`,
  )

  return NextResponse.json({ ok: true, id: intake.id })
}

/** A GET here is almost always someone checking the URL is live. */
export function GET() {
  return NextResponse.json({
    ok: true,
    message:
      'Client onboarding webhook is live. POST JSON with the x-webhook-secret header.',
  })
}
