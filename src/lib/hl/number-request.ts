/**
 * A client's Hell-level toll-free number, asked for in the Office.
 *
 * Right after onboarding makes the client's Hell-level sub-account, Echo asks:
 * "Buy a toll-free number for <client> in Hell-level?" (status
 * awaiting_approval, plus a text). Yes buys one on Genisys's Twilio and rings
 * the client's business phone. There's no ID check: GHL's selfie is only for
 * numbers on its own phone system. Once the client's site link is in, the
 * number's texting verification is filed (free; Twilio reviews it in about 3
 * business days). No drops it. Buying costs money, so it never happens
 * without a Yes.
 *
 * Decisions are in ./number-plan.ts; the Office shows the questions
 * (src/lib/office) and answers them through /api/office/approvals.
 */
import { Prisma } from '@/generated/prisma/client'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { textNumberEvent } from '@/lib/ghl-subaccount-worker/alerts'
import { jobLogEntry } from '@/lib/ghl-subaccount-worker/heartbeat'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { askDecision, FILE_RETRY_MS, prettyPhone, readyToFile, reconcileVerify, ringTo, textsTo } from './number-plan'
import { buyNumber, searchNumbers } from './twilio'
import { submitVerification } from './verification'

const SINCE_KEY = 'hlNumber.since'
const SWEEP_EVERY_MS = 10 * 60_000
/** A Yes that never finished buying (a restart mid-purchase) is looked at after this long. */
const STUCK_BUYING_MS = 10 * 60_000

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const logged = (prev: unknown, msg: string): Prisma.InputJsonValue => [...(Array.isArray(prev) ? prev : []), jobLogEntry(msg)].slice(-60) as Prisma.InputJsonValue
const numbersPage = (accountId: string) => hubLink(`/hell-level/${accountId}/settings?tab=phone-numbers`)

/** When asking started: only sub-accounts made after it are asked about by themselves. */
export async function numberSince(now = new Date()): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  if (row?.value && !Number.isNaN(Date.parse(row.value))) return new Date(row.value)
  try {
    await prisma.appSetting.create({ data: { key: SINCE_KEY, value: now.toISOString() } })
  } catch {
    // Another process recorded it first.
  }
  const again = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  return new Date(again?.value && !Number.isNaN(Date.parse(again.value)) ? again.value : now.toISOString())
}

export type NumberAskResult = { ok: true; status: string; id: string } | { ok: false; reason: string }

/** Put the question in the Office for this client (and text the team). Never throws for an ordinary "no". */
export async function askForClientNumber(clientId: string, trigger: 'onboarding' | 'sweep' | 'manual'): Promise<NumberAskResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      hlAccount: { select: { id: true, createdAt: true, profile: true, numbers: { where: { status: 'active', kind: 'toll_free' }, select: { id: true } } } },
      hlNumberRequest: { select: { id: true, status: true, log: true } },
    },
  })
  if (!c) return { ok: false, reason: 'Client not found.' }
  const account = c.hlAccount
  const decision = askDecision({
    archived: !!c.archivedAt,
    accountId: account?.id ?? null,
    accountCreatedAt: account?.createdAt ?? null,
    hasTollFree: !!account?.numbers.length,
    request: c.hlNumberRequest ? { status: c.hlNumberRequest.status } : null,
    since: await numberSince(),
    trigger,
  })
  if (!decision.ask || !account) return { ok: false, reason: decision.reason }
  const ring = ringTo(readProfile(account.profile))
  const msg = `Asked in the Office (${trigger === 'manual' ? 'by hand' : 'the client just onboarded'}). Calls would ring ${ring ? prettyPhone(ring) : 'nobody (no business phone on file)'}.`
  const data = {
    accountId: account.id,
    status: 'awaiting_approval',
    forwardTo: ring,
    numberId: null,
    number: null,
    verifyNote: null,
    verifyTriedAt: null,
    detail: null,
    trigger,
    decidedBy: null,
    decidedAt: null,
  }
  const row = await prisma.hlNumberRequest.upsert({
    where: { clientId },
    create: { clientId, ...data, log: logged(null, msg) },
    update: { ...data, log: logged(c.hlNumberRequest?.log, msg) },
    select: { id: true },
  })
  await textNumberEvent({ key: row.id, kind: 'approve', client: c.name, link: hubLink('/office') })
  return { ok: true, status: 'awaiting_approval', id: row.id }
}

export type NumberDecisionResult = { ok: true; status: string; number?: string | null; detail?: string | null } | { ok: false; reason: string }

/** Yes or No on an Office question. A Yes buys the number right away. */
export async function decideClientNumber(id: string, decision: 'yes' | 'no', by: string): Promise<NumberDecisionResult> {
  const r = await prisma.hlNumberRequest.findUnique({ where: { id }, select: { id: true, status: true, log: true } })
  if (!r) return { ok: false, reason: 'That question is gone.' }
  if (r.status !== 'awaiting_approval') return { ok: false, reason: `It was already answered (${r.status.replace('_', ' ')}).` }
  const yes = decision === 'yes'
  const moved = await prisma.hlNumberRequest.updateMany({
    where: { id, status: 'awaiting_approval' },
    data: {
      status: yes ? 'buying' : 'declined',
      decidedBy: by,
      decidedAt: new Date(),
      detail: yes ? null : `Declined by ${by}.`,
      log: logged(r.log, yes ? `Approved by ${by}.` : `Declined by ${by}.`),
    },
  })
  if (moved.count !== 1) return { ok: false, reason: 'Someone else answered it first.' }
  if (!yes) return { ok: true, status: 'declined' }
  return buyForRequest(id)
}

async function note(id: string, msg: string, data: Prisma.HlNumberRequestUpdateInput = {}): Promise<void> {
  const row = await prisma.hlNumberRequest.findUnique({ where: { id }, select: { log: true } })
  await prisma.hlNumberRequest.update({ where: { id }, data: { ...data, log: logged(row?.log, msg) } })
}

/** Buy the number (or take one the sub-account already has), point its calls, then file verification if the site is in. */
async function buyForRequest(id: string): Promise<NumberDecisionResult> {
  const r = await prisma.hlNumberRequest.findUnique({ where: { id }, include: { client: { select: { name: true } } } })
  if (!r) return { ok: false, reason: 'That question is gone.' }
  const fail = async (detail: string): Promise<NumberDecisionResult> => {
    await note(id, detail, { status: 'failed', detail })
    await textNumberEvent({ key: id, kind: 'failed', client: r.client.name, reason: detail, link: hubLink('/office') })
    return { ok: false, reason: detail }
  }
  let account: { id: string; name: string; profile: Prisma.JsonValue } | null = null
  let num: Awaited<ReturnType<typeof buyNumber>> | null = null
  let purchasing = false
  try {
    const found = await prisma.hlAccount.findUnique({
      where: { id: r.accountId },
      select: { id: true, name: true, profile: true, numbers: { where: { status: 'active', kind: 'toll_free' }, orderBy: { createdAt: 'asc' } } },
    })
    if (!found) return await fail("The client's Hell-level sub-account is gone, so nothing was bought.")
    account = found
    num = found.numbers[0] ?? null
    if (num) {
      await note(id, `${found.name} already has ${prettyPhone(num.number)}; using it instead of buying another.`)
    } else {
      const pick = (await searchNumbers({ kind: 'toll_free' }))[0]
      if (!pick) return await fail('Twilio offered no toll-free numbers just now, so nothing was bought. Ask again in a while.')
      purchasing = true
      num = await buyNumber(found.id, pick.number, 'toll_free')
      console.log(`[hell-level] bought ${num.number} (toll_free) for ${found.name} after an Office Yes`)
    }
  } catch (err) {
    const msg = describe(err)
    if (err instanceof HlInputError) return fail(msg)
    // Twilio may have sold the number even though saving it failed: say where to look before anyone asks again.
    return fail(purchasing ? `Buying the number failed: ${msg} Check Twilio for a toll-free number that isn't in Hell-level before asking again.` : `Buying the number failed: ${msg}`)
  }
  // From here the number is the client's: a later hiccup never marks the request failed (a retry would just find the number).
  const profile = readProfile(account.profile)
  const ring = ringTo(profile)
  // Texts it receives are forwarded to the phone the owner gave on onboarding.
  const texts = textsTo(profile)
  if (texts && !num.forwardTextsTo) {
    await prisma.hlPhoneNumber.update({ where: { id: num.id }, data: { forwardTextsTo: texts } }).catch((err) => {
      console.warn('[hell-level] setting where a new number forwards its texts:', describe(err))
    })
  }
  let unpointed = false
  if (ring && !num.forwardTo) {
    // Calls ring the business phone (press any key to connect); with none on file every call is a missed call.
    await prisma.hlPhoneNumber.update({ where: { id: num.id }, data: { forwardTo: ring, whisper: true } }).catch((err) => {
      unpointed = true
      console.warn('[hell-level] pointing a new toll-free number at the business phone:', describe(err))
    })
  }
  const rings = unpointed ? num.forwardTo : (num.forwardTo ?? ring)
  const detail = [
    `${prettyPhone(num.number)} is ${r.client.name}'s toll-free number.`,
    unpointed
      ? `Calls aren't pointed at ${prettyPhone(ring)} yet; set it in Hell-level → Settings → Phone Numbers.`
      : rings
        ? `Calls ring ${prettyPhone(rings)}.`
        : 'No business phone is on file, so every call to it counts as missed and gets the text-back.',
    texts ? `Texts to it are forwarded to ${prettyPhone(num.forwardTextsTo ?? texts)}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  await note(id, purchasing ? `Bought ${prettyPhone(num.number)} on Genisys's Twilio. ${detail}` : detail, { status: 'bought', numberId: num.id, number: num.number, forwardTo: rings, detail }).catch(
    (err) => console.warn('[hell-level] saving a bought number on its request:', describe(err)),
  )
  const filed = await fileNumberVerification(r.clientId).catch(() => null)
  return { ok: true, status: 'bought', number: num.number, detail: filed ? `${detail} ${filed}` : detail }
}

/**
 * File the bought number's texting verification once the client's site link
 * is in. Called after buying, when the site link is saved (after
 * syncClientSite has read the site's policy pages), and by the sweep. Returns
 * a sentence for whoever asked, or null when it isn't time yet.
 */
export async function fileNumberVerification(clientId: string): Promise<string | null> {
  const r = await prisma.hlNumberRequest.findUnique({ where: { clientId }, include: { client: { select: { name: true, siteUrl: true } } } })
  if (!r || r.status !== 'bought' || !r.numberId) return null
  const n = await prisma.hlPhoneNumber.findUnique({ where: { id: r.numberId }, select: { id: true, status: true, kind: true, verificationStatus: true, accountId: true } })
  const ready = readyToFile({ siteUrl: r.client.siteUrl, numberActive: n?.status === 'active', kind: n?.kind ?? null, verificationStatus: n?.verificationStatus ?? null })
  if (!ready.file || !n) return ready.reason === 'waiting for the site link' ? 'Texting verification is filed once their site link is in.' : null
  await prisma.hlNumberRequest.update({ where: { id: r.id }, data: { verifyTriedAt: new Date() } })
  try {
    const v = await submitVerification(n.id)
    const msg = `Filed texting verification for ${prettyPhone(r.number)} (${v.status.replace('_', ' ')}); Twilio reviews it in about 3 business days.`
    await note(r.id, msg, { verifyNote: null })
    return msg
  } catch (err) {
    // HlInputError says what to fix (the full address, the site's own policy pages, …); anything else is Twilio's answer.
    const why = err instanceof HlInputError ? describe(err) : `Twilio didn't take it: ${describe(err)}`
    await note(r.id, `Texting verification not filed: ${why}`, { verifyNote: why })
    await textNumberEvent({ key: r.id, kind: 'verify', client: r.client.name, reason: why, link: numbersPage(n.accountId) })
    return `Texting verification isn't filed yet: ${why}`
  }
}

let lastSweep = 0

/**
 * Every 10 minutes: ask about new sub-accounts the onboarding hook missed,
 * sort out a Yes that a restart interrupted, and retry blocked filings now
 * and then (the site or profile may have been fixed).
 */
export async function maybeSweepNumberRequests(now = Date.now()): Promise<number> {
  if (now - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now
  let changed = 0
  const since = await numberSince()
  const fresh = await prisma.client.findMany({
    where: { archivedAt: null, hlNumberRequest: { is: null }, hlAccount: { is: { createdAt: { gte: since } } } },
    select: { id: true },
    take: 20,
  })
  for (const c of fresh) {
    const res = await askForClientNumber(c.id, 'sweep').catch(() => null)
    if (res?.ok) changed += 1
  }
  const stuck = await prisma.hlNumberRequest.findMany({ where: { status: 'buying', updatedAt: { lt: new Date(now - STUCK_BUYING_MS) } }, select: { id: true, accountId: true } })
  for (const s of stuck) {
    const has = await prisma.hlPhoneNumber.findFirst({ where: { accountId: s.accountId, status: 'active', kind: 'toll_free' }, orderBy: { createdAt: 'asc' } })
    if (has) {
      await note(s.id, `Found ${prettyPhone(has.number)} on the sub-account after an interrupted purchase.`, {
        status: 'bought',
        numberId: has.id,
        number: has.number,
        forwardTo: has.forwardTo,
        detail: `${prettyPhone(has.number)} is on the sub-account (the purchase was interrupted, then found).`,
      })
    } else {
      const detail = 'The purchase was interrupted before a number showed up. Check Twilio for an unassigned number before asking again.'
      await note(s.id, detail, { status: 'failed', detail })
    }
    changed += 1
  }
  const blocked = await prisma.hlNumberRequest.findMany({
    // Never tried (the site link came in while the hook was down), or tried and blocked a while ago.
    where: { status: 'bought', client: { siteUrl: { not: null } }, OR: [{ verifyTriedAt: null }, { verifyNote: { not: null }, verifyTriedAt: { lt: new Date(now - FILE_RETRY_MS) } }] },
    select: { clientId: true },
    take: 10,
  })
  for (const b of blocked) {
    const said = await fileNumberVerification(b.clientId).catch(() => null)
    if (said) changed += 1
  }
  // Twilio's answer (read every 30 minutes by maybeRefreshVerifications): a rejection needs a person; a re-filing clears it.
  const bought = await prisma.hlNumberRequest.findMany({
    where: { status: 'bought', numberId: { not: null } },
    select: { id: true, numberId: true, verifyNote: true, client: { select: { name: true } } },
    take: 200,
  })
  const numbers = await prisma.hlPhoneNumber.findMany({
    where: { id: { in: bought.map((b) => b.numberId!) } },
    select: { id: true, accountId: true, verificationStatus: true, verificationNote: true },
  })
  for (const b of bought) {
    const n = numbers.find((x) => x.id === b.numberId)
    if (!n) continue
    const step = reconcileVerify({ verificationStatus: n.verificationStatus, verificationNote: n.verificationNote, currentNote: b.verifyNote })
    if (!step) continue
    await note(b.id, step.note ?? `Texting verification is ${n.verificationStatus.replace('_', ' ')} now.`, { verifyNote: step.note }).catch(() => {})
    if (step.text) await textNumberEvent({ key: b.id, kind: 'rejected', client: b.client.name, reason: n.verificationNote ?? '', link: numbersPage(n.accountId) })
    changed += 1
  }
  return changed
}
