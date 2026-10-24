import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { logActivity, upsertContact } from './contacts'
import { asSettings } from './forms'
import { readLinkToken } from './links'
import type { HlProfile } from './types'

/**
 * The review survey GHL's client snapshot sends review-request texts to: "Rate
 * Us" from five stars down to one. Four or five go straight on to Google to
 * leave a review; three or fewer are asked what went wrong, and that feedback
 * starts "Negative Feedback Received" (a form_submitted trigger on this form).
 * The tracked review link ({{trigger_link.review}}) opens it with the contact
 * already known.
 */

/** GHL's options, best first. */
export const RATINGS = ['⭐⭐⭐⭐⭐ (5 Stars)', '⭐⭐⭐⭐ (4 Stars)', '⭐⭐⭐ (3 Stars)', '⭐⭐ (2 Stars)', '⭐ (1 Star)'] as const
export const ratingLabel = (stars: number) => RATINGS[5 - Math.min(5, Math.max(1, Math.round(stars)))]

/** Where a happy customer goes: the Google review link in the Business Profile, else Google itself, searched for the business. */
export function reviewDestination(profile: HlProfile, fallbackName: string): string {
  const link = (profile.reviewLink ?? '').trim()
  if (/^https?:\/\//i.test(link)) return link
  const city = (profile.address ?? '').split(',').slice(-2).map((x) => x.trim()).filter(Boolean).join(' ')
  return `https://www.google.com/search?q=${encodeURIComponent([profile.businessName || fallbackName, city].filter(Boolean).join(' '))}`
}

export type PublicSurvey = { id: string; business: string; heading: string; thankYou: string; threshold: number; color: string }

export async function publicSurvey(formId: string): Promise<(PublicSurvey & { accountId: string; destination: string }) | null> {
  const form = await prisma.hlForm.findUnique({ where: { id: formId }, include: { account: { select: { id: true, name: true, profile: true, archivedAt: true } } } })
  if (!form || form.kind !== 'survey' || form.archivedAt || form.account.archivedAt) return null
  const profile = readProfile(form.account.profile)
  const settings = asSettings(form.settings)
  const business = profile.businessName || form.account.name
  return {
    id: form.id,
    accountId: form.account.id,
    business,
    heading: settings.heading || `How did ${business} do?`,
    thankYou: settings.thankYou || 'Thank you for taking the time to complete this survey.',
    threshold: Math.min(5, Math.max(1, settings.reviewThreshold ?? 4)),
    color: settings.color || '#155EEF',
    destination: reviewDestination(profile, business),
  }
}

export type SurveyInput = { rating: number; name?: string; email?: string; feedback?: string; token?: string }
export type SurveyOutcome =
  | { ok: true; redirect: string; contactId: string | null }
  | { ok: true; thankYou: string; contactId: string; accountId: string; answers: Record<string, string> }
  | { ok: false; error: string; field?: string }

/** A rating (and, for a low one, the feedback). The caller fires the form trigger for low ones. */
export async function submitSurvey(formId: string, input: SurveyInput, meta: { ip: string | null; pageUrl: string | null }): Promise<SurveyOutcome> {
  const survey = await publicSurvey(formId)
  if (!survey) return { ok: false, error: 'This survey is no longer available.' }
  const stars = Math.round(Number(input.rating))
  if (!(stars >= 1 && stars <= 5)) return { ok: false, error: 'Please pick a rating.', field: 'rate_us' }
  const label = ratingLabel(stars)

  // The contact the tracked link was sent to, when they came that way.
  const fromLink = input.token ? readLinkToken(input.token) : null
  let contactId: string | null = null
  if (fromLink) {
    const known = await prisma.hlContact.findUnique({ where: { id: fromLink.contactId }, select: { id: true, accountId: true } })
    if (known?.accountId === survey.accountId) contactId = known.id
  }
  const keep = async (id: string, fields: Record<string, string>) => {
    const c = await prisma.hlContact.findUnique({ where: { id }, select: { fields: true } })
    await prisma.hlContact.update({ where: { id }, data: { fields: { ...((c?.fields as Record<string, unknown>) ?? {}), ...fields } as Prisma.InputJsonValue } })
  }

  if (stars >= survey.threshold) {
    if (contactId) {
      await keep(contactId, { rate_us: label })
      await logActivity(survey.accountId, contactId, `Review survey: ${label}. Sent on to leave a Google review.`, { formId, rating: stars }, false)
    }
    return { ok: true, redirect: survey.destination, contactId }
  }

  const feedback = (input.feedback ?? '').trim().slice(0, 4000)
  if (!feedback) return { ok: false, error: 'Please tell us what we could do better.', field: 'your_feedback' }
  const email = (input.email ?? '').trim().slice(0, 200)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.', field: 'email' }
  const name = (input.name ?? '').trim().slice(0, 120)
  if (!contactId) {
    const { contact } = await upsertContact(survey.accountId, { fullName: name || (email ? null : 'Survey feedback'), email: email || null, source: 'survey' })
    contactId = contact.id
  }
  const answers = { rate_us: label, your_feedback: feedback, ...(name ? { full_name: name } : {}), ...(email ? { email } : {}) }
  await keep(contactId, { rate_us: label, your_feedback: feedback })
  await prisma.hlFormSubmission.create({
    data: { formId, accountId: survey.accountId, contactId, data: answers as Prisma.InputJsonValue, pageUrl: meta.pageUrl, ip: meta.ip },
  })
  await logActivity(survey.accountId, contactId, `Review survey: ${label}\n${feedback}`, { formId, rating: stars })
  return { ok: true, thankYou: survey.thankYou, contactId, accountId: survey.accountId, answers }
}
