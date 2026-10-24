import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import type { HlField, HlFieldType, HlFormSettings } from '@/lib/hl/types'

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
  const color = t(s.color, 7)
  return {
    heading: t(s.heading, 120),
    submitLabel: t(s.submitLabel, 40),
    thankYou: t(s.thankYou, 400),
    consentText: t(s.consentText, 600),
    color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#155EEF',
  }
}

/** GET: the form and its latest submissions. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, formId } = await params
  const form = await load(id, formId)
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 })
  const submissions = await prisma.hlFormSubmission.findMany({
    where: { formId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { contact: { select: { id: true, firstName: true, lastName: true } } },
  })
  return NextResponse.json({ form, submissions })
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
