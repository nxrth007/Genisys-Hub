import { prisma } from '@/lib/prisma'
import { promoteIntakeToClient } from '@/lib/client-from-intake'
import { ensureClientGeo } from '@/lib/geocode'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { ensureSeoSiteForClient } from '@/lib/seo/link-client'

/**
 * Storing an onboarding submission, however it reached the Hub.
 *
 * There are two ways in: the form's webhook (instant, but it depends on a
 * setting in the form that can be missing or wrong) and the Hub reading
 * the form's Google Sheet itself (a few minutes behind, but the sheet is
 * where the form always writes first). Both end here, so a submission is
 * parsed, stored, turned into a Client and announced the same way
 * whichever door it came through — and never twice.
 */

export const INTAKE_FIELDS = [
  'ein', 'fullName', 'businessName', 'businessContact', 'businessAddress',
  'customerPhone', 'areaCode', 'timeZone', 'leadEmail', 'cities', 'website',
  'aboutBusiness', 'mainServices', 'promotions', 'socialLinks', 'whyChooseYou',
  'brandColors', 'faqs', 'bringingOwnDomain', 'domainName',
] as const

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  // The form sends "N/A" for skipped optional questions; storing that as
  // if it were an answer makes every empty field look filled in.
  if (!t || /^(n\/?a|none|n\.a\.)$/i.test(t)) return null
  return t
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Does this body carry any onboarding answers (enveloped or flat)? */
export function looksLikeIntake(body: Record<string, unknown> | null): boolean {
  if (!body) return false
  const answers = isRecord(body.answers) ? body.answers : body
  return INTAKE_FIELDS.some((key) => str(answers[key]) !== null)
}

/** The ClientIntake row for a submission body ({ event, submittedAt, source, answers, labels, files } or flat). */
export function intakeDataFromBody(body: Record<string, unknown>) {
  // The funnel wraps answers in an envelope; imports and the earlier form
  // send them flat. Reading whichever is present keeps both working.
  const answers = isRecord(body.answers) ? body.answers : body
  // The original submission time sets receivedAt rather than being
  // stored as an answer, so imports and replays keep their real dates.
  const receivedAt = parseDate(body.submittedAt)
  const ownDomain = /^y(es)?$/i.test(str(answers.bringingOwnDomain) ?? '')
  const files = Array.isArray(body.files)
    ? body.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : []
  return {
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
}

export type IngestResult = {
  id: string
  clientId: string | null
  created: boolean
  /** True when this exact submission was already stored (same time, same business). */
  duplicate: boolean
}

/**
 * Store a submission, make (or link) its Client, and tell the team.
 *
 * Idempotent on (submittedAt, businessName): the webhook and the sheet
 * reader can both see the same submission, and whichever arrives second
 * finds the first one's row instead of writing another.
 */
export async function ingestIntake(body: Record<string, unknown>, source: 'webhook' | 'sheet'): Promise<IngestResult> {
  const data = intakeDataFromBody(body)

  if (data.receivedAt) {
    const near = await prisma.clientIntake.findFirst({
      where: {
        receivedAt: { gte: new Date(data.receivedAt.getTime() - 2000), lte: new Date(data.receivedAt.getTime() + 2000) },
        ...(data.businessName ? { businessName: { equals: data.businessName, mode: 'insensitive' } } : {}),
      },
      select: { id: true, clientId: true },
    })
    if (near) return { id: near.id, clientId: near.clientId, created: false, duplicate: true }
  }

  const intake = await prisma.clientIntake.create({
    data,
    select: { id: true, businessName: true, receivedAt: true },
  })
  console.log(`[client-onboarding] stored intake ${intake.id} for "${intake.businessName ?? 'unnamed'}" via ${source}`)

  // Every submission becomes a Client (or links to the one already
  // carrying this business name). Best-effort: a failure here must not
  // lose the stored intake.
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
  const city = data.cities?.split(/[,\n;]/)[0]?.trim()
  const via = source === 'sheet' ? ' _(recovered from the onboarding sheet — the form’s webhook didn’t deliver it)_' : ''
  if (clientId) {
    await hubAlert(
      `:tada: *New client onboarded* — *${who}*${city ? ` (${city})` : ''}${created ? '' : ' — linked to the client already on file'}${via}. <${hubLink(`/clients?focus=${clientId}`)}|Open in Hub>`,
    )
    // Give them a seat in SEO now (audit mode; it waits for a live URL).
    void ensureSeoSiteForClient(clientId).catch((err) => console.warn(`[client-onboarding] seo site for ${clientId}:`, err))
    // Put the new client on the Home globe now rather than on the next
    // page load. A new submission may carry the address an earlier one
    // lacked, so an unplaced client's backoff is lifted first.
    const id = clientId
    void prisma.client
      .updateMany({ where: { id, geoLat: null }, data: { geoRetryAt: null } })
      .then(() => ensureClientGeo(id))
      .catch((err) => console.warn(`[client-onboarding] geocode failed for ${id}:`, err))
  } else {
    await hubAlert(
      `:warning: *Onboarding submission stored but no client was created* — ${who}${via}. Usually the business name was blank. Review it under Clients → Onboarding answers: <${hubLink('/clients/onboarding')}|open>`,
    )
  }

  return { id: intake.id, clientId, created, duplicate: false }
}
