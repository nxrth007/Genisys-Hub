import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fireTrigger } from '@/lib/hl/automation'
import { upsertContact } from '@/lib/hl/contacts'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import type { HlStage } from '@/lib/hl/types'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST { pipelineId, stageId, name?, value?, contactId? | contact: { firstName, lastName, phone, email } }
 * Adds an opportunity, making the contact when it's a new person.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const pipeline = await prisma.hlPipeline.findFirst({ where: { id: str(body.pipelineId) ?? '', accountId: id } })
    if (!pipeline) throw new HlInputError('Pick a pipeline.')
    const stages = (pipeline.stages as HlStage[]) ?? []
    const stage = stages.find((s) => s.id === body.stageId) ?? stages[0]
    let contactId = str(body.contactId)
    let created = false
    if (contactId) {
      const c = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { accountId: true } })
      if (!c || c.accountId !== id) throw new HlInputError('That contact isn’t in this sub-account.')
    } else {
      const c = (body.contact ?? {}) as Record<string, unknown>
      if (!str(c.phone) && !str(c.email)) throw new HlInputError('Add the contact’s phone or email.')
      const r = await upsertContact(id, { firstName: str(c.firstName), lastName: str(c.lastName), phone: str(c.phone), email: str(c.email), source: 'manual' })
      contactId = r.contact.id
      created = r.created
    }
    const contact = await prisma.hlContact.findUniqueOrThrow({ where: { id: contactId } })
    const last = await prisma.hlOpportunity.findFirst({ where: { pipelineId: pipeline.id, stageId: stage.id }, orderBy: { position: 'desc' }, select: { position: true } })
    const opp = await prisma.hlOpportunity.create({
      data: {
        accountId: id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        contactId,
        name: str(body.name) ?? ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone || contact.email || 'New opportunity'),
        value: Math.max(0, Math.round(Number(body.value) || 0)),
        source: 'manual',
        position: (last?.position ?? 0) + 1,
      },
    })
    if (created) await fireTrigger(id, contactId, { type: 'contact_created' })
    await fireTrigger(id, contactId, { type: 'opportunity_created', pipelineId: pipeline.id, stageId: stage.id })
    return NextResponse.json({ opportunity: opp })
  } catch (err) {
    return hlError(err, 'create opportunity')
  }
}
