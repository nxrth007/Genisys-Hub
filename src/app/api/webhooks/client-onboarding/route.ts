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

const FIELDS = [
  'ein', 'fullName', 'businessName', 'businessContact', 'businessAddress',
  'customerPhone', 'areaCode', 'timeZone', 'leadEmail', 'cities', 'website',
  'aboutBusiness', 'mainServices', 'promotions', 'socialLinks', 'whyChooseYou',
  'brandColors', 'faqs', 'bringingOwnDomain', 'domainName',
] as const

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

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

  // The funnel wraps answers in an envelope ({ event, submittedAt, source,
  // answers, labels, files }); imports and the earlier form send them
  // flat. Reading whichever is present keeps both working.
  const answers = isRecord(body.answers) ? body.answers : body

  // A body with none of the form's fields is a misconfigured sender or a
  // liveness probe, not a submission. Storing it would put a blank row
  // in front of whoever reads the intakes next.
  if (!FIELDS.some((key) => str(answers[key]) !== null)) {
    return NextResponse.json(
      { error: 'empty_payload', message: 'No onboarding fields were present.' },
      { status: 400 },
    )
  }

  // The original submission time sets receivedAt rather than being
  // stored as an answer, so imports and replays keep their real dates.
  const receivedAt = parseDate(body.submittedAt)
  const ownDomain = /^y(es)?$/i.test(str(answers.bringingOwnDomain) ?? '')
  const files = Array.isArray(body.files)
    ? body.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : []

  const data = {
    ...(receivedAt ? { receivedAt } : {}),
    ein: str(answers.ein),
    fullName: str(answers.fullName),
    businessName: str(answers.businessName),
    businessContact: str(answers.businessContact),
    businessAddress: str(answers.businessAddress),
    customerPhone: str(answers.customerPhone),
    areaCode: str(answers.areaCode),
    timeZone: str(answers.timeZone),
    leadEmail: str(answers.leadEmail),
    cities: str(answers.cities),
    website: str(answers.website),
    aboutBusiness: str(answers.aboutBusiness),
    mainServices: str(answers.mainServices),
    promotions: str(answers.promotions),
    socialLinks: str(answers.socialLinks),
    whyChooseYou: str(answers.whyChooseYou),
    brandColors: str(answers.brandColors),
    faqs: str(answers.faqs),
    bringingOwnDomain: str(answers.bringingOwnDomain),
    // The form leaves domainName empty on "No", but a stale value from
    // a toggled answer shouldn't be stored as if it were theirs.
    domainName: ownDomain ? str(answers.domainName) : null,
    files,
    raw: body as object,
  }

  // ?dryRun=1 parses and reports without storing, so a changed payload
  // shape can be checked against the running build before it goes live.
  if (req.nextUrl.searchParams.get('dryRun') === '1') {
    return NextResponse.json({ ok: true, dryRun: true, parsed: data })
  }

  const intake = await prisma.clientIntake.create({
    data,
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
    // Advertised so an importer can tell whether the running build will
    // honour an original submission time before it sends anything.
    acceptsSubmittedAt: true,
  })
}
