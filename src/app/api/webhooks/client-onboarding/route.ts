import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { promoteIntakeToClient } from '@/lib/client-from-intake'
import { ensureClientGeo } from '@/lib/geocode'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { ensureSeoSiteForClient } from '@/lib/seo/link-client'

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

  // The body is read before the secret is checked so a rejected request
  // that clearly came from the form (it carries onboarding answers) can
  // be reported — a submission the Hub turns away is a client nobody
  // hears about. Random scanners send neither a secret nor answers and
  // are ignored quietly.
  const rawText = await req.text().catch(() => '')
  let parsedBody: Record<string, unknown> | null = null
  try {
    const v: unknown = JSON.parse(rawText)
    if (isRecord(v)) parsedBody = v
  } catch {
    parsedBody = null
  }
  const looksLikeSubmission =
    !!parsedBody &&
    (isRecord(parsedBody.answers) || FIELDS.some((key) => str(parsedBody?.[key]) !== null))

  if (!provided || !secretMatches(provided, expected)) {
    if (looksLikeSubmission || provided) {
      await hubAlertThrottled(
        'onboarding:invalid_secret',
        30 * 60_000,
        `:rotating_light: *Onboarding webhook rejected a submission* — the secret it sent doesn't match the Vault entry "${SECRET_ENTRY}". ${looksLikeSubmission ? `It looked like a real form entry${str(parsedBody?.businessName ?? (isRecord(parsedBody?.answers) ? parsedBody.answers.businessName : null)) ? ` for *${str(parsedBody?.businessName ?? (parsedBody?.answers as Record<string, unknown>).businessName)}*` : ''}. ` : ''}Check the webhook secret in the onboarding funnel; the answers were NOT stored.`,
      )
    }
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

  if (!parsedBody) {
    await hubAlertThrottled(
      'onboarding:invalid_json',
      30 * 60_000,
      ':rotating_light: *Onboarding webhook rejected a submission* — the body was not valid JSON. The funnel\u2019s webhook payload format may have changed; the answers were NOT stored.',
    )
    return NextResponse.json(
      { error: 'invalid_json', message: 'Body was not valid JSON.' },
      { status: 400 },
    )
  }
  const body = parsedBody

  // The funnel wraps answers in an envelope ({ event, submittedAt, source,
  // answers, labels, files }); imports and the earlier form send them
  // flat. Reading whichever is present keeps both working.
  const answers = isRecord(body.answers) ? body.answers : body

  // A body with none of the form's fields is a misconfigured sender or a
  // liveness probe, not a submission. Storing it would put a blank row
  // in front of whoever reads the intakes next.
  if (!FIELDS.some((key) => str(answers[key]) !== null)) {
    await hubAlertThrottled(
      'onboarding:empty_payload',
      30 * 60_000,
      ':rotating_light: *Onboarding webhook received a submission with no answers in it* — the funnel\u2019s field mapping may have changed. Nothing was stored.',
    )
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

  // Every submission becomes a Client (or links to the one already
  // carrying this business name). Best-effort: a failure here must not
  // turn a stored intake into a 500 for the sender.
  let clientId: string | null = null
  let created = false
  try {
    const promoted = await promoteIntakeToClient(intake.id)
    clientId = promoted?.clientId ?? null
    created = promoted?.created ?? false
  } catch (err) {
    console.error(`[client-onboarding] client promotion failed for ${intake.id}:`, err)
  }

  // Every submission gets announced, so a missing one is noticed.
  const who = intake.businessName ?? 'an unnamed business'
  const city = str(answers.cities)?.split(/[,\n;]/)[0]?.trim()
  if (clientId) {
    await hubAlert(
      `:tada: *New client onboarded* — *${who}*${city ? ` (${city})` : ''}${created ? '' : ' — linked to the client already on file'}. <${hubLink(`/clients?focus=${clientId}`)}|Open in Hub>`,
    )
    // Give them a seat in SEO now (audit mode; it waits for a live URL).
    void ensureSeoSiteForClient(clientId).catch((err) => console.warn(`[client-onboarding] seo site for ${clientId}:`, err))
  } else {
    await hubAlert(
      `:warning: *Onboarding submission stored but no client was created* — ${who}. Usually the business name was blank. Review it under Clients → Onboarding answers: <${hubLink('/clients/onboarding')}|open>`,
    )
  }

  // Put the new client on the Home globe now rather than on the next
  // page load. Not awaited: a slow geocoder must not hold the sender.
  if (clientId) {
    // A new submission may carry the address an earlier one lacked, so an
    // unplaced client's backoff is lifted before trying again. A client
    // already on the map keeps its point.
    const id = clientId
    void prisma.client
      .updateMany({ where: { id, geoLat: null }, data: { geoRetryAt: null } })
      .then(() => ensureClientGeo(id))
      .catch((err) => console.warn(`[client-onboarding] geocode failed for ${id}:`, err))
  }

  return NextResponse.json({ ok: true, id: intake.id, clientId })
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
