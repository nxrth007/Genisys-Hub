import type { ClientIntake } from '@/generated/prisma/client'
import { prisma } from './prisma'
import { findClientForIntake } from './client-dedupe'

/**
 * Onboarding intake → Client.
 *
 * Clients are onboarded through clientonboarding.leadgenisys.com, so a
 * stored intake is the moment a business becomes a client. Every
 * submission is promoted: a new Client is created from the answers, or
 * — when one already carries that business name — the intake is linked
 * to it and nothing on the existing record is overwritten.
 *
 * The one-time backfill migration (20260926120100) does the same for
 * intakes that arrived before this existed; keep the two mappings in
 * step if either changes.
 */

function line(label: string, value: string | null): string | null {
  const v = value?.trim()
  return v ? `${label}: ${v}` : null
}

/** The answers that don't have a Client column, as readable notes. */
export function intakeNotes(i: ClientIntake): string {
  const domain =
    /^y(es)?$/i.test(i.bringingOwnDomain ?? '')
      ? `Domain: ${i.domainName ?? '(bringing their own)'}`
      : i.bringingOwnDomain
        ? 'Domain: none — we register one'
        : null

  return [
    `Onboarded via clientonboarding.leadgenisys.com on ${i.receivedAt.toISOString().slice(0, 10)}`,
    line('Services', i.mainServices),
    line('Cities', i.cities),
    line('Area code', i.areaCode),
    line('Time zone', i.timeZone),
    domain,
    line('Brand colours', i.brandColors),
    line('Promotions', i.promotions),
    line('Social', i.socialLinks),
    line('Google Business Profile', i.googleProfileLink ?? (i.hasGoogleProfile ? `${i.hasGoogleProfile} — no link` : null)),
    line('Review sites', i.reviewLinks),
    line('Started', i.yearStarted),
    line('License', i.licenseInfo),
    line('About', i.aboutBusiness),
    line('Why choose them', i.whyChooseYou),
    line('FAQs', i.faqs),
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/** "8302379649", "(830) 237-9649", "+1 830-237-9649": a phone number typed into the business-name box. */
export function looksLikePhoneNumber(name: string): boolean {
  return /^[\d\s().+-]+$/.test(name) && name.replace(/\D/g, '').length >= 7
}

export async function promoteIntakeToClient(
  intakeId: string,
): Promise<{ clientId: string; created: boolean; matched?: { name: string; why: string } } | null> {
  const intake = await prisma.clientIntake.findUnique({ where: { id: intakeId } })
  if (!intake) return null
  if (intake.clientId) return { clientId: intake.clientId, created: false }

  const name = intake.businessName?.trim()
  // A client named after a phone number gets an SEO site and a GHL
  // sub-account under that name; a person should pick the real one.
  if (!name || looksLikePhoneNumber(name)) return null

  // Client.name is unique; match case-insensitively so "Smith Plumbing"
  // and "smith plumbing" don't become two clients.
  const existing = await prisma.client.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  // Then the same business under another spelling ("Aplus" / "A Plus",
  // with or without LLC), or the same EIN, email, website or phone.
  const same = existing ? null : await findClientForIntake(intake)
  const linkTo = existing?.id ?? same?.id
  if (linkTo) {
    await prisma.clientIntake.update({
      where: { id: intakeId },
      data: { clientId: linkTo },
    })
    return { clientId: linkTo, created: false, ...(same ? { matched: { name: same.name, why: same.why } } : {}) }
  }

  // The form's "business contact" is free text; only treat it as an
  // email when it looks like one, and prefer the dedicated lead email.
  const contactEmail =
    intake.leadEmail ??
    (intake.businessContact?.includes('@') ? intake.businessContact : null)

  let client: { id: string }
  try {
    client = await prisma.client.create({
      data: {
        name,
        // In setup, not yet receiving bookings — admin flips to active.
        lifecycle: 'onboarding',
        package: 'custom',
        contactName: intake.fullName,
        contactEmail,
        contactPhone: intake.customerPhone,
        address: intake.businessAddress,
        website: intake.website,
        onboardingNotes: intakeNotes(intake),
        // The relationship started when they submitted, not when this ran.
        createdAt: intake.receivedAt,
      },
      select: { id: true },
    })
  } catch (err) {
    // A second submission from the same business, seconds behind the first,
    // loses the race to create the client — link it to the winner instead.
    if ((err as { code?: string }).code !== 'P2002') throw err
    const winner = await prisma.client.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!winner) throw err
    await prisma.clientIntake.update({ where: { id: intakeId }, data: { clientId: winner.id } })
    return { clientId: winner.id, created: false }
  }
  await prisma.clientIntake.update({
    where: { id: intakeId },
    data: { clientId: client.id },
  })
  return { clientId: client.id, created: true }
}
