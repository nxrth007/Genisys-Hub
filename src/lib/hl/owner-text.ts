import { prisma } from '@/lib/prisma'
import type { HlPhoneNumber } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { fireTrigger } from './automation'
import { upsertContact } from './contacts'
import { clientAccountsForOwnerPhone, genisysSender } from './genisys-sender'
import { sendInternalSms, sendSmsToContact, sendingNumber, textingReady } from './messages'
import { ownerPhones } from './number-plan'
import { latestOwnerAlert, noteOwnerConfirmed } from './owner-alerts'
import {
  DONE_NEEDS_PHONE,
  DONE_OWN_NUMBER,
  doneReply,
  helpText,
  NO_LEAD_TO_ANSWER,
  NO_SUCH_LEAD,
  PHOTO_WITH_DONE,
  photoReply,
  pickReplyTarget,
  readOwnerText,
  relayCannot,
  relayReply,
  UNDO_WINDOW_MS,
  undoReply,
  WHICH_BUSINESS,
  whichLead,
  type OwnerText,
} from './owner-text-plan'
import { JOB_COMPLETED_STAGE, REVIEW_STAGE_TRIGGER_ID } from './review-kit'
import { sendTwilioSms } from './twilio'
import type { HlProfile, HlStage } from './types'
import { addWorkPhotos, siteShowsWork, workPageUrl } from './work-photos'

/**
 * A text from the owner's own phone to a Genisys OS number (./owner-text-plan.ts says what it means):
 * their own business number, or Genisys's own number, which their alerts come from while theirs can't
 * text yet. On Genisys's number only a photo, DONE, UNDO, HELP and a reply with the lead's number put
 * first count: the rest is them writing to Genisys, as before. Replies to the owner go the way alerts
 * do (sendInternalSms: their number once approved, else Genisys's).
 */

type NumberAccount = { id: string; clientId: string | null; name: string; profile: HlProfile }
type Target = { id: string; name: string; profile: HlProfile }

const DONE_KIND = 'owner_done'

const log = (what: string, err: unknown) => console.error(`[genisys-os] owner text: ${what}:`, err instanceof Error ? err.message : err)

export async function handleOwnerText(o: { number: Pick<HlPhoneNumber, 'number' | 'forwardTo' | 'forwardTextsTo'>; numberAccount: NumberAccount; from: string; body: string; media: string[] }): Promise<void> {
  const found = await targetAccount(o)
  if (found === 'ambiguous') {
    const hub = (await genisysSender())?.number
    if (hub) await sendTwilioSms({ from: hub, to: o.from, body: WHICH_BUSINESS }).catch((err) => log('which business', err))
    return
  }
  if (!found) return
  const { target, viaHub } = found
  const read = readOwnerText(o.body, o.media.length)
  if (read.kind === 'empty') return
  const business = target.profile.businessName || target.name
  let reply: string | null = null
  try {
    reply = await act(target, o.from, read, o.media, business, viaHub)
  } catch (err) {
    log(read.kind, err)
    reply = "Something went wrong on our side; we're looking at it."
  }
  if (reply) {
    const r = await sendInternalSms(target.id, [o.from], reply).catch((err) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
    if (!r.ok) console.warn('[genisys-os] owner text: reply not sent:', r.detail)
  }
}

/**
 * Whose text it is. The number's own sub-account when it's a client's, or when the phone is on that
 * sub-account's own profile (Genisys's own owners on Lead Genisys's number). Otherwise, on Genisys's
 * number, the one client this phone belongs to, with `viaHub` set: it isn't their business number.
 */
async function targetAccount(o: { number: Pick<HlPhoneNumber, 'forwardTo' | 'forwardTextsTo'>; numberAccount: NumberAccount; from: string }): Promise<{ target: Target; viaHub: boolean } | 'ambiguous' | null> {
  if (o.numberAccount.clientId || ownerPhones(o.number, o.numberAccount.profile).has(o.from)) return { target: o.numberAccount, viaHub: false }
  const owned = await clientAccountsForOwnerPhone(o.from)
  if (owned.length > 1) return 'ambiguous'
  return owned[0] ? { target: owned[0], viaHub: true } : null
}

async function act(t: Target, from: string, read: OwnerText, media: string[], business: string, viaHub: boolean): Promise<string | null> {
  switch (read.kind) {
    case 'help':
      return helpText(business)
    case 'photo':
      return savePhotos(t, from, media, read.caption)
    case 'done': {
      const reply = await markJobDone(t, from, read, business)
      if (!read.phone || !media.length) return reply
      // A photo along with DONE: kept too, under the job's name.
      const { added } = await addWorkPhotos({ accountId: t.id, from, mediaUrls: media, caption: '' })
      return added ? `${reply}${PHOTO_WITH_DONE}` : reply
    }
    case 'undo':
      return undoJobDone(t, from)
    case 'reply':
      return relayToLead(t, from, read.text, viaHub)
    default:
      return null
  }
}

async function savePhotos(t: Target, from: string, media: string[], caption: string): Promise<string> {
  const { added, skipped, failed } = await addWorkPhotos({ accountId: t.id, from, mediaUrls: media, caption })
  const onSite = added ? await siteShowsWork(t.id).catch(() => false) : false
  return photoReply({ added, skipped, failed, link: workPageUrl(t.id), onSite })
}

/** The sub-account's own phones: the owner's, and the business numbers themselves. Never a lead. */
async function ownNumbers(t: Target, from: string): Promise<Set<string>> {
  const own = ownerPhones({}, t.profile)
  own.add(from)
  const numbers = await prisma.hlPhoneNumber.findMany({ where: { accountId: t.id, status: 'active' }, select: { number: true, forwardTo: true, forwardTextsTo: true } })
  for (const n of numbers) for (const p of [n.number, ...ownerPhones(n, {})]) own.add(p)
  return own
}

/** The sub-account's pipeline with a Job Completed stage: the kit's Customer Pipeline. */
async function jobPipeline(accountId: string): Promise<{ id: string; stages: HlStage[] } | null> {
  const pipelines = await prisma.hlPipeline.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, stages: true } })
  const withStage = pipelines.map((p) => ({ id: p.id, name: p.name, stages: (Array.isArray(p.stages) ? p.stages : []) as HlStage[] })).filter((p) => p.stages.some((s) => s.id === JOB_COMPLETED_STAGE))
  return withStage.find((p) => p.name === 'Customer Pipeline') ?? withStage[0] ?? null
}

/** Is the customer in the Review Request Campaign now (a run waiting out its 20 minutes, or texting)? */
async function inReviewCampaign(accountId: string, contactId: string): Promise<boolean> {
  const run = await prisma.hlWorkflowRun.findFirst({
    where: { accountId, contactId, status: { in: ['running', 'waiting'] }, workflow: { deletedAt: null, triggers: { array_contains: [{ id: REVIEW_STAGE_TRIGGER_ID }] } } },
    select: { id: true },
  })
  return !!run
}

/**
 * DONE + a number: the customer goes into the pipeline at Job Completed, which starts the kit's
 * Review Request Campaign (20-minute wait, then the text with their review link). Texting DONE is
 * the owner's word that the customer agreed to a text, as the owner's review-request form is. While
 * the business number can't text, the job is marked and nothing starts: a campaign that can't send
 * would only fail quietly.
 */
async function markJobDone(t: Target, from: string, read: Extract<OwnerText, { kind: 'done' }>, business: string): Promise<string> {
  if (!read.phone) return DONE_NEEDS_PHONE
  if ((await ownNumbers(t, from)).has(read.phone)) return DONE_OWN_NUMBER
  const pipeline = await jobPipeline(t.id)
  if (!pipeline) return `${business} has no pipeline with a Job Completed stage yet, so the review request can't start. We're on it.`
  const { contact } = await upsertContact(t.id, {
    phone: read.phone,
    firstName: read.firstName,
    lastName: read.lastName,
    source: 'manual',
    consent: true,
    fields: { added_by: `owner text from ${from}`, consent_note: 'Owner texted DONE: their word that the customer agreed to a review text' },
  })
  const open = await prisma.hlOpportunity.findFirst({ where: { contactId: contact.id, pipelineId: pipeline.id, status: 'open' }, orderBy: { createdAt: 'desc' } })
  let opportunityId: string
  let fromStage: string | null = null
  if (open) {
    fromStage = open.stageId === JOB_COMPLETED_STAGE ? null : open.stageId
    await prisma.hlOpportunity.update({ where: { id: open.id }, data: { stageId: JOB_COMPLETED_STAGE } })
    opportunityId = open.id
  } else {
    const last = await prisma.hlOpportunity.findFirst({ where: { pipelineId: pipeline.id, stageId: JOB_COMPLETED_STAGE }, orderBy: { position: 'desc' }, select: { position: true } })
    const made = await prisma.hlOpportunity.create({
      data: {
        accountId: t.id,
        pipelineId: pipeline.id,
        stageId: JOB_COMPLETED_STAGE,
        contactId: contact.id,
        name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone || 'Finished job',
        source: 'owner text',
        position: (last?.position ?? 0) + 1,
      },
      select: { id: true },
    })
    opportunityId = made.id
  }
  const ready = textingReady(await sendingNumber(t.id)).ok
  const started = ready ? (await fireTrigger(t.id, contact.id, { type: 'opportunity_stage', stageId: JOB_COMPLETED_STAGE, pipelineId: pipeline.id, context: { opportunityId } })) > 0 : false
  const inIt = ready && !started ? await inReviewCampaign(t.id, contact.id) : false
  if (ready && !started && !inIt) console.error(`[genisys-os] owner text: DONE for ${t.name} started no review request (is the Review Request Campaign published, with its Job Completed trigger?)`)
  // Kept for UNDO: the last DONE from this phone.
  const data = { opportunityId, contactId: contact.id, fromStage, at: new Date().toISOString() }
  const where = { accountId_kind_ghlId: { accountId: t.id, kind: DONE_KIND, ghlId: `${DONE_KIND}:${from}` } }
  await prisma.hlRecord.upsert({ where, create: { accountId: t.id, kind: DONE_KIND, ghlId: `${DONE_KIND}:${from}`, name: from, data }, update: { data } })
  return doneReply({ name: contact.firstName, phone: contact.phone, business, started, inIt, ready })
}

/** UNDO within the wait: the job goes back a stage, and the campaign's gate drops the run. */
async function undoJobDone(t: Target, from: string): Promise<string> {
  const where = { accountId_kind_ghlId: { accountId: t.id, kind: DONE_KIND, ghlId: `${DONE_KIND}:${from}` } }
  const rec = await prisma.hlRecord.findUnique({ where })
  const d = (rec?.data ?? null) as { opportunityId?: string; contactId?: string; fromStage?: string | null; at?: string } | null
  if (!rec || !d?.opportunityId || !d.at || Date.now() - Date.parse(d.at) > UNDO_WINDOW_MS) return undoReply({ undone: false, name: null, phone: null })
  const opp = await prisma.hlOpportunity.findUnique({ where: { id: d.opportunityId }, include: { pipeline: { select: { stages: true } }, contact: { select: { firstName: true, phone: true } } } })
  await prisma.hlRecord.delete({ where }).catch(() => undefined)
  if (!opp || opp.stageId !== JOB_COMPLETED_STAGE) return undoReply({ undone: false, name: null, phone: null })
  const stages = (Array.isArray(opp.pipeline.stages) ? opp.pipeline.stages : []) as HlStage[]
  const at = stages.findIndex((s) => s.id === JOB_COMPLETED_STAGE)
  const back = (d.fromStage && stages.find((s) => s.id === d.fromStage)?.id) || stages[Math.max(0, at - 1)]?.id || stages[0]?.id
  if (!back || back === JOB_COMPLETED_STAGE) return undoReply({ undone: false, name: null, phone: null })
  await prisma.hlOpportunity.update({ where: { id: opp.id }, data: { stageId: back } })
  await fireTrigger(t.id, opp.contactId, { type: 'opportunity_stage', stageId: back, pipelineId: opp.pipelineId, context: { opportunityId: opp.id } })
  return undoReply({ undone: true, name: opp.contact.firstName, phone: opp.contact.phone })
}

type Lead = { id: string; firstName: string | null; phone: string | null }

/**
 * Anything else is an answer to the lead they were last told about, sent from the business number.
 * On Genisys's number only an answer with the lead's number put first is one; the rest is for Genisys.
 */
async function relayToLead(t: Target, from: string, text: string, viaHub: boolean): Promise<string | null> {
  const target = pickReplyTarget(viaHub ? null : await latestOwnerAlert(t.id, from), text, new Date())
  if (!target) return viaHub ? null : NO_LEAD_TO_ANSWER
  if ('ack' in target) return null
  if ('which' in target) {
    const leads = await prisma.hlContact.findMany({ where: { id: { in: target.which }, accountId: t.id }, select: { id: true, firstName: true, phone: true } })
    const by = (id: string) => {
      const l = leads.find((x) => x.id === id)
      return { name: l?.firstName ?? null, phone: l?.phone ?? null }
    }
    return whichLead(by(target.which[0]), by(target.which[1]))
  }
  let lead: Lead | null
  if ('byPhone' in target) {
    if ((await ownNumbers(t, from)).has(target.byPhone)) return NO_SUCH_LEAD
    lead = await prisma.hlContact.findFirst({ where: { accountId: t.id, phone: target.byPhone }, orderBy: { createdAt: 'asc' }, select: { id: true, firstName: true, phone: true } })
  } else {
    const c = await prisma.hlContact.findUnique({ where: { id: target.contactId }, select: { id: true, firstName: true, phone: true, accountId: true } })
    lead = c && c.accountId === t.id ? c : null
  }
  if (!lead) return NO_SUCH_LEAD
  const r = await sendSmsToContact({ accountId: t.id, contactId: lead.id, body: target.text, by: `owner:${from}` })
  if (r.ok) {
    await noteOwnerConfirmed(t.id, from).catch(() => undefined)
    return relayReply(lead.firstName, lead.phone)
  }
  return relayCannot({ name: lead.firstName, phone: lead.phone, reason: r.detail, notApproved: !textingReady(await sendingNumber(t.id)).ok })
}

/** For the number's own sub-account (a client's own number). */
export const numberAccountOf = (a: { id: string; clientId: string | null; name: string; profile: unknown }): NumberAccount => ({ id: a.id, clientId: a.clientId, name: a.name, profile: readProfile(a.profile) })
