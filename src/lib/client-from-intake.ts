import type { ClientIntake } from '@/generated/prisma/client'
import { prisma } from './prisma'

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
    line('About', i.aboutBusiness),
    line('Why choose them', i.whyChooseYou),
    line('FAQs', i.faqs),
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

export async function promoteIntakeToClient(
  intakeId: string,
): Promise<{ clientId: string; created: boolean } | null> {
  const intake = await prisma.clientIntake.findUnique({ where: { id: intakeId } })
  if (!intake) return null
  if (intake.clientId) return { clientId: intake.clientId, created: false }

  const name = intake.businessName?.trim()
  if (!name) return null

  // Client.name is unique; match case-insensitively so "Smith Plumbing"
  // and "smith plumbing" don't become two clients.
  const existing = await prisma.client.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (existing) {
    await prisma.clientIntake.update({
      where: { id: intakeId },
      data: { clientId: existing.id },
    })
    return { clientId: existing.id, created: false }
  }

  // The form's "business contact" is free text; only treat it as an
  // email when it looks like one, and prefer the dedicated lead email.
  const contactEmail =
    intake.leadEmail ??
    (intake.businessContact?.includes('@') ? intake.businessContact : null)

  const client = await prisma.client.create({
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
  await prisma.clientIntake.update({
    where: { id: intakeId },
    data: { clientId: client.id },
  })
  return { clientId: client.id, created: true }
}
