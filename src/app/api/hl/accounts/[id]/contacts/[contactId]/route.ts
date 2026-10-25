import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { fireTrigger, startWorkflow, cancelRun } from '@/lib/hl/automation'
import { hlError, hlGuard, HlInputError, jsonBody, str, hlAccountGuard } from '@/lib/hl/http'
import { toE164 } from '@/lib/hl/phone'

type Ctx = { params: Promise<{ id: string; contactId: string }> }

async function load(id: string, contactId: string) {
  const contact = await prisma.hlContact.findUnique({ where: { id: contactId } })
  return contact && contact.accountId === id ? contact : null
}

/** GET: the contact with its conversation, opportunities and automation runs. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id, contactId } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const contact = await load(id, contactId)
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  const [messages, opportunities, runs] = await Promise.all([
    prisma.hlMessage.findMany({ where: { contactId }, orderBy: { createdAt: 'asc' }, take: 500 }),
    prisma.hlOpportunity.findMany({ where: { contactId }, include: { pipeline: { select: { name: true, stages: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.hlWorkflowRun.findMany({ where: { contactId }, include: { workflow: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  return NextResponse.json({ contact, messages, opportunities, runs })
}

/**
 * PATCH { firstName?, lastName?, phone?, email?, tags?, smsConsent?, dnd?, emailDnd?, read?: true,
 *         addToWorkflow?: workflowId, cancelRun?: runId }
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id, contactId } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const contact = await load(id, contactId)
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    if (typeof body.addToWorkflow === 'string') {
      const runId = await startWorkflow(body.addToWorkflow, contactId)
      return NextResponse.json({ runId })
    }
    if (typeof body.cancelRun === 'string') {
      const cancelled = await cancelRun(body.cancelRun, id, contactId)
      if (!cancelled) return NextResponse.json({ error: 'Active workflow run not found for this contact' }, { status: 404 })
      return NextResponse.json({ ok: true })
    }
    const data: Prisma.HlContactUpdateInput = {}
    for (const k of ['firstName', 'lastName'] as const) if (k in body) data[k] = str(body[k])
    if ('email' in body) {
      const e = str(body.email)?.toLowerCase() ?? null
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HlInputError('That email doesn’t look right.')
      data.email = e
    }
    if ('phone' in body) {
      const raw = str(body.phone)
      const p = toE164(raw)
      if (raw && !p) throw new HlInputError('That phone number doesn’t look right.')
      data.phone = p
    }
    let freshTags: string[] = []
    if (Array.isArray(body.tags)) {
      const tags = [...new Set(body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean))]
      freshTags = tags.filter((t) => !contact.tags.includes(t))
      data.tags = tags
    }
    if (typeof body.smsConsent === 'boolean') {
      data.smsConsent = body.smsConsent
      data.smsConsentAt = body.smsConsent ? new Date() : null
    }
    if (typeof body.dnd === 'boolean') data.dnd = body.dnd
    if (typeof body.emailDnd === 'boolean') {
      data.emailDnd = body.emailDnd
      data.emailDndReason = body.emailDnd ? 'set by hand' : null
    }
    if (typeof body.starred === 'boolean') data.starred = body.starred
    if (body.read === true) data.unread = 0
    const updated = await prisma.hlContact.update({ where: { id: contactId }, data })
    for (const tag of freshTags) await fireTrigger(id, contactId, { type: 'tag_added', tag })
    return NextResponse.json({ contact: updated })
  } catch (err) {
    return hlError(err, 'update contact')
  }
}

/** DELETE: remove the contact and its conversation. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, contactId } = await params
  const contact = await load(id, contactId)
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  await prisma.hlContact.delete({ where: { id: contactId } })
  return NextResponse.json({ ok: true })
}
