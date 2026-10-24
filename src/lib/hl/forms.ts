import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { fireTrigger } from './automation'
import { logActivity, upsertContact } from './contacts'
import { resolveLegalLinks, type LegalLinks } from './legal-links'
import { toE164 } from './phone'
import { CONSENT_TEXT } from './templates'
import type { HlConsentBox, HlField, HlFormSettings } from './types'

/**
 * Website forms and the chat widget, as the public sees them: the Hub serves
 * the form (embedded on the client's Lovable site in an iframe or the chat
 * bubble), and a submission becomes a contact, a conversation entry and the
 * matching automation.
 */

export const asFields = (v: unknown) => (Array.isArray(v) ? (v as HlField[]) : [])
export const asSettings = (v: unknown) => (v && typeof v === 'object' ? (v as HlFormSettings) : {})

/** The form's consent boxes; a form from before the two-box consent has its one texting box. */
export function consentsOf(s: HlFormSettings): HlConsentBox[] {
  if (Array.isArray(s.consents)) return s.consents.filter((c) => (c.kind === 'sms' || c.kind === 'marketing') && typeof c.text === 'string' && c.text.trim())
  return [{ kind: 'sms', text: s.consentText || CONSENT_TEXT, required: false }]
}

/** The form field each box posts as. */
export const consentField = (kind: HlConsentBox['kind']) => (kind === 'marketing' ? 'marketing_consent' : 'sms_consent')

export type PublicForm = {
  id: string
  kind: 'form' | 'chat'
  name: string
  business: string
  fields: HlField[]
  /** consents as shown: the business name filled in. */
  settings: HlFormSettings & { consents: HlConsentBox[] }
  legal: LegalLinks
  accountId: string
}

export async function publicForm(formId: string): Promise<PublicForm | null> {
  const form = await prisma.hlForm.findUnique({ where: { id: formId }, include: { account: { select: { id: true, name: true, profile: true, archivedAt: true } } } })
  if (!form || form.archivedAt || form.account.archivedAt) return null
  const profile = readProfile(form.account.profile)
  const business = profile.businessName || form.account.name
  const settings = asSettings(form.settings)
  const consents = consentsOf(settings).map((c) => ({ ...c, text: c.text.replace(/\{\{\s*business\s*\}\}/g, business) }))
  return {
    id: form.id,
    kind: form.kind === 'chat' ? 'chat' : 'form',
    name: form.name,
    business,
    fields: asFields(form.fields),
    settings: { ...settings, consentText: undefined, consents },
    legal: resolveLegalLinks(form.account.id, profile, settings),
    accountId: form.account.id,
  }
}

export type SubmitOutcome = { ok: true; thankYou: string; contactId: string; created: boolean; formKind: 'form' | 'chat'; accountId: string; answers: Record<string, string> } | { ok: false; error: string; field?: string }

/** Check and store a submission. Automations are fired separately (fireFormTriggers) so the visitor isn't kept waiting. */
export async function submitForm(formId: string, raw: Record<string, unknown>, meta: { ip: string | null; pageUrl: string | null }): Promise<SubmitOutcome> {
  const form = await publicForm(formId)
  if (!form) return { ok: false, error: 'This form is no longer available.' }
  const answers: Record<string, string> = {}
  for (const f of form.fields) {
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim().slice(0, 4000) : ''
    if (f.required && !v) return { ok: false, error: `Please fill in “${f.label}”.`, field: f.key }
    if (v && f.type === 'phone' && !toE164(v)) return { ok: false, error: 'Please enter a valid US phone number.', field: f.key }
    if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, error: 'Please enter a valid email address.', field: f.key }
    if (v) answers[f.key] = v
  }
  const ticked = (kind: HlConsentBox['kind']) => {
    const v = raw[consentField(kind)]
    return form.settings.consents.some((c) => c.kind === kind) && (v === true || v === 'true' || v === 'on' || v === '1')
  }
  const missing = form.settings.consents.find((c) => c.required && !ticked(c.kind))
  if (missing) return { ok: false, error: 'Please check the box to agree before sending.', field: consentField(missing.kind) }
  const consent = ticked('sms')
  const marketingConsent = ticked('marketing')
  const phoneKey = form.fields.find((f) => f.type === 'phone')?.key
  const emailKey = form.fields.find((f) => f.type === 'email')?.key
  if (!(phoneKey && answers[phoneKey]) && !(emailKey && answers[emailKey])) return { ok: false, error: 'Please leave a phone number or email so we can reach you.' }

  const known = new Set(['full_name', 'first_name', 'last_name', phoneKey, emailKey])
  const extra = Object.fromEntries(Object.entries(answers).filter(([k]) => !known.has(k)))
  const { contact, created } = await upsertContact(form.accountId, {
    fullName: answers.full_name ?? null,
    firstName: answers.first_name ?? null,
    lastName: answers.last_name ?? null,
    phone: phoneKey ? answers[phoneKey] : null,
    email: emailKey ? answers[emailKey] : null,
    source: form.kind,
    consent,
    marketingConsent,
    fields: extra,
  })
  const consentData = {
    sms_consent: consent,
    ...(form.settings.consents.some((c) => c.kind === 'marketing') ? { marketing_consent: marketingConsent } : {}),
  }
  await prisma.hlFormSubmission.create({
    data: { formId: form.id, accountId: form.accountId, contactId: contact.id, data: { ...answers, ...consentData } as Prisma.InputJsonValue, pageUrl: meta.pageUrl, ip: meta.ip },
  })
  const summary = form.fields
    .filter((f) => answers[f.key])
    .map((f) => `${f.label}: ${answers[f.key]}`)
    .join('\n')
  await logActivity(form.accountId, contact.id, `${form.kind === 'chat' ? 'Chat widget' : form.name}\n${summary}`, { formId: form.id, consent, marketingConsent, pageUrl: meta.pageUrl })
  return {
    ok: true,
    thankYou: form.settings.thankYou || 'Thanks! We’ll be in touch shortly.',
    contactId: contact.id,
    created,
    formKind: form.kind,
    accountId: form.accountId,
    answers,
  }
}

export async function fireFormTriggers(formId: string, o: Extract<SubmitOutcome, { ok: true }>): Promise<void> {
  if (o.created) await fireTrigger(o.accountId, o.contactId, { type: 'contact_created', context: { form: o.answers } })
  await fireTrigger(o.accountId, o.contactId, { type: o.formKind === 'chat' ? 'chat_submitted' : 'form_submitted', formId, context: { form: o.answers, formId } })
}
