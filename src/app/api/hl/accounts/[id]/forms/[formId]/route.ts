import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from '@/lib/hl/accounts'
import { asSettings, consentsOf } from '@/lib/hl/forms'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { fillLegalLinksFromSite, resolveLegalLinks } from '@/lib/hl/legal-links'
import type { HlConsentBox, HlField, HlFieldType, HlFormSettings } from '@/lib/hl/types'

type Ctx = { params: Promise<{ id: string; formId: string }> }

const TYPES: HlFieldType[] = ['text', 'phone', 'email', 'textarea', 'select']

async function load(id: string, formId: string) {
  const f = await prisma.hlForm.findUnique({ where: { id: formId } })
  return f && f.accountId === id && !f.archivedAt ? f : null
}

function cleanFields(raw: unknown): HlField[] {
  if (!Array.isArray(raw) || !raw.length) throw new HlInputError('A form needs at least one field.')
  const keys = new Set<string>()
  const fields = raw.map((r, i) => {
    const f = (r ?? {}) as Record<string, unknown>
    const label = typeof f.label === 'string' ? f.label.trim().slice(0, 80) : ''
    if (!label) throw new HlInputError(`Field ${i + 1} needs a label.`)
    const type = TYPES.includes(f.type as HlFieldType) ? (f.type as HlFieldType) : 'text'
    let key = typeof f.key === 'string' && /^[a-z0-9_]{1,40}$/.test(f.key) ? f.key : label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `field_${i + 1}`
    while (keys.has(key)) key = `${key}_${i + 1}`
    keys.add(key)
    const options = type === 'select' && Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim().slice(0, 80)).slice(0, 30) : undefined
    return {
      key,
      label,
      type,
      ...(f.required === true ? { required: true } : {}),
      ...(typeof f.placeholder === 'string' && f.placeholder.trim() ? { placeholder: f.placeholder.trim().slice(0, 120) } : {}),
      ...(options?.length ? { options } : {}),
    }
  })
  if (!fields.some((f) => f.type === 'phone' || f.type === 'email')) throw new HlInputError('Keep a phone or email field, or there’s no way to reach the lead.')
  return fields
}

function cleanSettings(raw: unknown): HlFormSettings {
  const s = (raw ?? {}) as Record<string, unknown>
  const t = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)
  const hex = (v: unknown) => {
    const c = t(v, 7)
    return c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined
  }
  const url = (v: unknown, what: string) => {
    const u = t(v, 500)
    if (!u) return undefined
    if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(u)) throw new HlInputError(`The ${what} link has to be a full address starting with https://.`)
    return u
  }
  const consents: HlConsentBox[] = []
  for (const c of Array.isArray(s.consents) ? s.consents.slice(0, 4) : []) {
    const box = (c ?? {}) as Record<string, unknown>
    const text = t(box.text, 1000)
    if (!text || (box.kind !== 'sms' && box.kind !== 'marketing') || consents.some((x) => x.kind === box.kind)) continue
    consents.push({ kind: box.kind, text, required: box.required === true })
  }
  return {
    heading: t(s.heading, 120),
    submitLabel: t(s.submitLabel, 40),
    thankYou: t(s.thankYou, 400),
    // The editor always sends the boxes; the old single wording only stays on a form saved without them.
    ...(Array.isArray(s.consents) ? { consents } : { consentText: t(s.consentText, 600) }),
    color: hex(s.color) ?? '#155EEF',
    buttonText: hex(s.buttonText),
    background: s.background === 'transparent' ? 'transparent' : hex(s.background),
    textColor: hex(s.textColor),
    inputBackground: hex(s.inputBackground),
    inputText: hex(s.inputText),
    inputBorder: hex(s.inputBorder),
    showLegalLinks: s.showLegalLinks !== false,
    privacyUrl: url(s.privacyUrl, 'privacy policy'),
    termsUrl: url(s.termsUrl, 'terms'),
  }
}

/**
 * GET: the form (its consent boxes spelled out, old single-box forms too),
 * its latest submissions, and what blank links fall back to.
 * ?lookLegal=1 reads the client's website again for its policy pages.
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, formId } = await params
  const form = await load(id, formId)
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 })
  // The client's own /privacy and /terms, the first time (or when asked again).
  await fillLegalLinksFromSite(id, new URL(req.url).searchParams.get('lookLegal') === '1')
  const [submissions, account] = await Promise.all([
    prisma.hlFormSubmission.findMany({
      where: { formId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.hlAccount.findUniqueOrThrow({ where: { id }, select: { name: true, profile: true } }),
  ])
  const profile = readProfile(account.profile)
  const settings = asSettings(form.settings)
  const fallback = resolveLegalLinks(id, profile)
  return NextResponse.json({
    form: { ...form, settings: { ...settings, consentText: undefined, consents: consentsOf(settings) } },
    submissions,
    defaults: {
      business: profile.businessName || account.name,
      privacy: fallback.privacy,
      terms: fallback.terms,
      fromProfile: { privacy: !!profile.privacyUrl, terms: !!profile.termsUrl },
    },
  })
}

/** PATCH { name?, fields?, settings? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, formId } = await params
  const form = await load(id, formId)
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const data: Prisma.HlFormUpdateInput = {}
    const name = str(body.name)
    if (name) data.name = name
    if (body.fields !== undefined) data.fields = cleanFields(body.fields) as unknown as Prisma.InputJsonValue
    if (body.settings !== undefined) data.settings = cleanSettings(body.settings) as Prisma.InputJsonValue
    return NextResponse.json({ form: await prisma.hlForm.update({ where: { id: formId }, data }) })
  } catch (err) {
    return hlError(err, 'update form')
  }
}

/** DELETE: archive (the embed stops working; submissions stay). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, formId } = await params
  const form = await load(id, formId)
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 })
  await prisma.hlForm.update({ where: { id: formId }, data: { archivedAt: new Date() } })
  return NextResponse.json({ ok: true })
}
