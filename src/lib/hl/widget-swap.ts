/**
 * Client websites move from GoHighLevel's quote form and chat bubble to Hell-level's (Alex,
 * 2026-11-14, for the clients that aren't A2P or toll-free verified on GoHighLevel). A person queues
 * clients (POST /api/admin/widget-swap); the scheduler carries each one on, two at a time at most:
 *
 *   queued → sending: the client is checked (not one of the 13 that stay on GoHighLevel; a site link
 *     in Clients; a published Lovable project, the very one live there when its page says; the
 *     sub-account's quote form and chat widget) and the live site is read as it is.
 *   sending → editing: one message to the project's Lovable agent. Never sent twice: a send a restart
 *     cut off is looked for in Lovable's chat first.
 *   editing → checking_code: Lovable's turn finishes. A pause for a person, a stop or an error ends
 *     the swap as failed, in Lovable's words, and nothing is published.
 *   checking_code → publishing: Lovable's code search shows our form and chat in, GoHighLevel's form
 *     and chat out (a GoHighLevel booking calendar stays). Something left: one follow-up message;
 *     still left after it: failed, unpublished.
 *   publishing → checking_live: Publish, as the button in Lovable.
 *   checking_live → done: the live site shows our chat and no GoHighLevel form or chat (30 minutes).
 *
 * State is one AppSetting row per client (hlWidgetSwap:<clientId>) with its log. The rules are pure,
 * in ./widget-swap-plan.ts.
 */
import { embedCode } from '@/components/hell-level/embed'
import { prisma } from '@/lib/prisma'
import {
  LovableMcpError,
  lovableMcpAgentState,
  lovableMcpDeploy,
  lovableMcpGrep,
  lovableMcpRecentMessages,
  lovableMcpSend,
  lovableProjectPublic,
} from '@/lib/seo/lovable-mcp'
import { REVIEW_REQUEST_FORM } from './client-kit'
import { lovablePublicId } from './site-plan'
import { publicBase } from './twilio'
import {
  codeGaps,
  followUpMessage,
  ghlInCode,
  hlInCode,
  liveGaps,
  liveState,
  liveSwapped,
  staysOnGhl,
  widgetSwapMessage,
  type LiveState,
} from './widget-swap-plan'

const KEY = 'hlWidgetSwap:'
/** Sites being edited at once (each is one Lovable agent turn). */
const AT_ONCE = 2
const EDIT_POLL_MS = 60_000
const EDIT_GIVE_UP_MS = 45 * 60_000
const LIVE_POLL_MS = 2 * 60_000
const LIVE_GIVE_UP_MS = 30 * 60_000
/** Tries for a step that didn't go through (Lovable or the site not answering). */
const MAX_TRIES = 4

export type SwapStatus = 'queued' | 'sending' | 'editing' | 'checking_code' | 'publishing' | 'checking_live' | 'done' | 'failed'
const WORKING: SwapStatus[] = ['sending', 'editing', 'checking_code', 'publishing', 'checking_live']

export type WidgetSwap = {
  clientId: string
  name: string
  status: SwapStatus
  by: string
  queuedAt: string
  /** When the current step began. */
  stepAt: string
  updatedAt: string
  projectId: string | null
  siteUrl: string | null
  formId: string | null
  formName: string | null
  chatId: string | null
  messageId: string | null
  threadId: string | null
  followUps: number
  /** Lovable credits the edits used. */
  credits: number | null
  tries: number
  /** The live site before and after. */
  before: LiveState | null
  after: LiveState | null
  detail: string | null
  log: { at: string; text: string }[]
}

class SwapStop extends Error {}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const editorLink = (projectId: string | null) => (projectId ? `https://lovable.dev/projects/${projectId}` : 'Lovable')

function parse(value: string): WidgetSwap | null {
  try {
    const x = JSON.parse(value) as Partial<WidgetSwap>
    if (!x || typeof x.clientId !== 'string' || typeof x.status !== 'string') return null
    return {
      name: '',
      by: '',
      queuedAt: new Date(0).toISOString(),
      stepAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      projectId: null,
      siteUrl: null,
      formId: null,
      formName: null,
      chatId: null,
      messageId: null,
      threadId: null,
      followUps: 0,
      credits: null,
      tries: 0,
      before: null,
      after: null,
      detail: null,
      log: [],
      ...x,
    } as WidgetSwap
  } catch {
    return null
  }
}

async function load(clientId: string): Promise<WidgetSwap | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY + clientId } })
  return row ? parse(row.value) : null
}

async function save(s: WidgetSwap): Promise<void> {
  s.updatedAt = new Date().toISOString()
  s.log = s.log.slice(-40)
  const key = KEY + s.clientId
  const value = JSON.stringify(s)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

function logLine(s: WidgetSwap, text: string) {
  s.log.push({ at: new Date().toISOString(), text })
  console.log(`[widget-swap] ${s.name || s.clientId}: ${text}`)
}

/** Log a line and move to `status` (a new step: its clock and tries start over). */
async function move(s: WidgetSwap, status: SwapStatus, text: string, detail: string | null = null): Promise<void> {
  logLine(s, text)
  if (s.status !== status) {
    s.status = status
    s.stepAt = new Date().toISOString()
    s.tries = 0
  }
  s.detail = detail
  await save(s)
}

/** Every swap, oldest queued first. */
export async function readSwaps(): Promise<WidgetSwap[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: KEY } } })
  return rows
    .map((r) => parse(r.value))
    .filter((s): s is WidgetSwap => !!s)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
}

export type QueueResult = { clientId: string; name: string | null; queued: boolean; note: string }

/** Queue clients for the swap. `again` redoes one that's done; a failed one can always be queued again. */
export async function queueWidgetSwaps(clientIds: string[], by: string, opts: { again?: boolean } = {}): Promise<QueueResult[]> {
  const out: QueueResult[] = []
  for (const clientId of [...new Set(clientIds)]) {
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, archivedAt: true } })
    if (!c) {
      out.push({ clientId, name: null, queued: false, note: 'No such client.' })
      continue
    }
    if (c.archivedAt) {
      out.push({ clientId, name: c.name, queued: false, note: 'The client is archived.' })
      continue
    }
    if (staysOnGhl(c.name)) {
      out.push({ clientId, name: c.name, queued: false, note: 'Verified on GoHighLevel: stays there (Alex, 2026-11-14).' })
      continue
    }
    const prev = await load(clientId)
    if (prev && (prev.status === 'queued' || WORKING.includes(prev.status))) {
      out.push({ clientId, name: c.name, queued: false, note: `Already ${prev.status === 'queued' ? 'queued' : `under way (${prev.status})`}.` })
      continue
    }
    if (prev?.status === 'done' && !opts.again) {
      out.push({ clientId, name: c.name, queued: false, note: 'Already swapped. Queue it with again: true to redo it.' })
      continue
    }
    const now = new Date().toISOString()
    const s: WidgetSwap = {
      clientId,
      name: c.name,
      status: 'queued',
      by,
      queuedAt: now,
      stepAt: now,
      updatedAt: now,
      projectId: null,
      siteUrl: null,
      formId: null,
      formName: null,
      chatId: null,
      messageId: null,
      threadId: null,
      followUps: 0,
      credits: null,
      tries: 0,
      before: null,
      after: null,
      detail: null,
      log: prev ? [...prev.log.slice(-10), { at: now, text: `Queued again by ${by} (was ${prev.status}).` }] : [{ at: now, text: `Queued by ${by}.` }],
    }
    await save(s)
    out.push({ clientId, name: c.name, queued: true, note: 'Queued.' })
  }
  return out
}

/** Take queued swaps off the queue (one under way finishes: Lovable may be mid-edit). */
export async function unqueueWidgetSwaps(clientIds: string[], by: string): Promise<QueueResult[]> {
  const out: QueueResult[] = []
  for (const clientId of [...new Set(clientIds)]) {
    const s = await load(clientId)
    if (!s || s.status !== 'queued') {
      out.push({ clientId, name: s?.name ?? null, queued: false, note: s ? `Not queued (${s.status}).` : 'Never queued.' })
      continue
    }
    await move(s, 'failed', `Taken off the queue by ${by}.`, `Taken off the queue by ${by}.`)
    out.push({ clientId, name: s.name, queued: false, note: 'Taken off the queue.' })
  }
  return out
}

// ---------------------------------------------------------------------------
// The live site
// ---------------------------------------------------------------------------

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub/1.0)' }

async function fetchText(url: string, max = 3_000_000): Promise<{ url: string; body: string } | null> {
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    return { url: res.url || url, body: (await res.text()).slice(0, max) }
  } catch {
    return null
  }
}

/**
 * The live site's own code: its home page, the scripts it loads from its own address, and a few
 * contact or quote page chunks those name. Null when the page doesn't load.
 */
async function liveCode(siteUrl: string): Promise<{ code: string; lovableId: string | null } | null> {
  const bust = `${siteUrl.replace(/\/+$/, '')}/?hlcheck=${Date.now()}`
  const home = await fetchText(bust)
  if (!home) return null
  const origin = new URL(home.url).origin
  const own = (u: string) => {
    try {
      const abs = new URL(u, origin).href
      return abs.startsWith(origin) ? abs : null
    } catch {
      return null
    }
  }
  const scripts = [...home.body.matchAll(/(?:src|href)="([^"]+\.m?js)(?:\?[^"]*)?"/g)].map((m) => own(m[1])).filter((u): u is string => !!u)
  let code = home.body
  for (const src of [...new Set(scripts)].slice(0, 6)) code += (await fetchText(src))?.body ?? ''
  const chunks = [...code.matchAll(/["'](\/?assets\/[A-Za-z0-9_.-]*(?:[Cc]ontact|[Qq]uote|[Ff]orm|[Ee]stimate)[A-Za-z0-9_.-]*\.js)["']/g)].map((m) => own(m[1].startsWith('/') ? m[1] : `/${m[1]}`))
  for (const c of [...new Set(chunks)].filter((u): u is string => !!u).slice(0, 4)) code += (await fetchText(c))?.body ?? ''
  return { code, lovableId: lovablePublicId(home.body) }
}

const said = (s: LiveState) =>
  [s.ghlForm && 'GoHighLevel’s form', s.ghlChat && 'GoHighLevel’s chat', s.hlForm && 'Hell-level’s form', s.hlChat && 'Hell-level’s chat'].filter(Boolean).join(', ') || 'neither form nor chat on its home page'

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/** queued → sending. */
async function prepare(s: WidgetSwap): Promise<boolean> {
  const c = await prisma.client.findUnique({
    where: { id: s.clientId },
    select: {
      name: true,
      archivedAt: true,
      siteUrl: true,
      hlSiteRequest: { select: { projectId: true } },
      seoSite: { select: { lovableProjectId: true } },
      hlAccount: {
        select: {
          archivedAt: true,
          forms: { where: { archivedAt: null, kind: { in: ['form', 'chat'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, name: true, ghlId: true } },
        },
      },
    },
  })
  if (!c) throw new SwapStop('The client is gone.')
  s.name = c.name
  if (c.archivedAt) throw new SwapStop('The client is archived.')
  if (staysOnGhl(c.name)) throw new SwapStop('Verified on GoHighLevel: stays there (Alex, 2026-11-14).')
  const siteUrl = c.siteUrl?.trim() ?? ''
  if (!/^https?:\/\/\S+$/i.test(siteUrl)) throw new SwapStop('No site link in Clients: add it there, then queue the swap again.')
  const projectId = c.hlSiteRequest?.projectId ?? c.seoSite?.lovableProjectId ?? null
  if (!projectId) throw new SwapStop('The Hub doesn’t know their Lovable project (no site build or SEO seat with one).')
  if (!c.hlAccount || c.hlAccount.archivedAt) throw new SwapStop('No Hell-level sub-account.')
  const native = c.hlAccount.forms.filter((f) => !f.ghlId)
  const quote = native.find((f) => f.kind === 'form' && f.name === 'Website Quote Form') ?? native.find((f) => f.kind === 'form' && f.name !== REVIEW_REQUEST_FORM)
  const chat = native.find((f) => f.kind === 'chat')
  if (!quote || !chat) throw new SwapStop(`Their Hell-level sub-account has no ${!quote ? 'quote form' : 'chat widget'}.`)
  const pub = await lovableProjectPublic(projectId)
  if (pub.isPublished === false) throw new SwapStop(`Their Lovable project (${editorLink(projectId)}) isn’t published, so it isn’t what ${siteUrl} shows.`)
  const live = await liveCode(siteUrl)
  if (!live) throw new Error(`${siteUrl} didn’t load.`)
  const publicId = pub.publicId?.toLowerCase() ?? null
  if (publicId && live.lovableId && live.lovableId !== publicId) {
    throw new SwapStop(`${siteUrl} shows another Lovable project (${live.lovableId}) than the one the Hub has for them (${publicId}, ${editorLink(projectId)}). Nothing was changed.`)
  }
  const ids = { formId: quote.id, chatId: chat.id }
  const before = liveState(live.code, ids)
  Object.assign(s, { siteUrl, projectId, formId: quote.id, formName: quote.name, chatId: chat.id, before })
  if (liveSwapped(before) && before.hlForm) {
    await move(s, 'done', `${siteUrl} already has Hell-level’s form and chat and no GoHighLevel form or chat: nothing sent.`, 'Already on Hell-level’s form and chat.')
    return false
  }
  const match = publicId && live.lovableId ? `its page carries the project’s id ${publicId}` : 'its page doesn’t carry a project id, so the Hub’s record of the project is trusted'
  await move(s, 'sending', `Checked: ${siteUrl} is project ${projectId} (${match}). The live site has ${said(before)}.`)
  return true
}

/** The message as sent (built again from the saved ids, so a retry sends the same words). */
function swapMessage(s: WidgetSwap): string {
  if (!s.formId || !s.chatId) throw new SwapStop('Lost the form and chat ids.')
  const origin = publicBase()
  return widgetSwapMessage({
    form: embedCode(origin, { id: s.formId, kind: 'form', name: s.formName ?? 'Website Quote Form' }),
    chat: embedCode(origin, { id: s.chatId, kind: 'chat', name: 'Chat' }),
  })
}

/** A message already in the project's chat since `sinceMs` that starts like this one. */
async function sentAlready(projectId: string, message: string, sinceMs: number): Promise<string | null> {
  const head = message.slice(0, 160).trim()
  const recent = await lovableMcpRecentMessages(projectId, 5)
  return recent.find((m) => m.role === 'user' && m.content.trim().startsWith(head) && !!m.createdAt && Date.parse(m.createdAt) >= sinceMs)?.id ?? null
}

/** Send `message` once: a send that timed out may still have arrived, so look before sending again. */
async function sendOnce(s: WidgetSwap, message: string): Promise<{ messageId: string; threadId: string | null }> {
  if (!s.projectId) throw new SwapStop('Lost the Lovable project.')
  const since = Date.parse(s.stepAt) - 60_000
  const before = await sentAlready(s.projectId, message, since)
  if (before) return { messageId: before, threadId: 'main' }
  try {
    const sent = await lovableMcpSend(s.projectId, message)
    return { messageId: sent.messageId, threadId: sent.threadId }
  } catch (err) {
    const arrived = await sentAlready(s.projectId, message, since).catch(() => null)
    if (arrived) return { messageId: arrived, threadId: 'main' }
    throw err
  }
}

/** sending → editing. */
async function send(s: WidgetSwap): Promise<boolean> {
  const sent = await sendOnce(s, swapMessage(s))
  s.messageId = sent.messageId
  s.threadId = sent.threadId
  await move(s, 'editing', `Sent Lovable the swap (message ${sent.messageId}).`, 'Lovable is swapping the form and chat.')
  return false
}

/** editing → checking_code, or still going. */
async function watchEdit(s: WidgetSwap): Promise<boolean> {
  if (!s.projectId || !s.messageId) throw new SwapStop('Lost track of the message sent to Lovable.')
  const st = await lovableMcpAgentState(s.projectId, s.messageId, s.threadId)
  const editor = editorLink(s.projectId)
  if (st.state === 'done') {
    if (st.credits !== null) s.credits = (s.credits ?? 0) + st.credits
    const used = st.credits !== null ? ` using ${st.credits} credit${st.credits === 1 ? '' : 's'}` : ''
    await move(s, 'checking_code', `Lovable finished${used}.${st.note ? ` Its summary: ${st.note.slice(0, 400)}` : ''}`)
    return true
  }
  if (st.state === 'waiting') throw new SwapStop(`Lovable paused for a person: ${st.note ?? 'a check-in'}. Answer it in Lovable (${editor}); nothing was published.`)
  if (st.state === 'stopped' || st.state === 'error') {
    throw new SwapStop(`Lovable ${st.state === 'stopped' ? 'stopped' : 'hit an error'}${st.note ? `: ${st.note.slice(0, 300)}` : ''}. Look in Lovable (${editor}); nothing was published.`)
  }
  if (st.queue?.paused) throw new SwapStop(`Lovable queued the message behind an earlier one that’s waiting for a person. Answer it in Lovable (${editor}); nothing was published.`)
  if (Date.now() - Date.parse(s.stepAt) > EDIT_GIVE_UP_MS) throw new SwapStop(`Lovable was still working after 45 minutes. Look in Lovable (${editor}); nothing was published.`)
  return false
}

/** checking_code → publishing, or one follow-up, or failed. */
async function checkCode(s: WidgetSwap): Promise<boolean> {
  if (!s.projectId || !s.formId || !s.chatId) throw new SwapStop('Lost the project or the form and chat ids.')
  const grep = async (q: string) => (await lovableMcpGrep(s.projectId!, q)).hits
  const ghlHits = [...(await grep('leadconnectorhq')), ...(await grep('msgsndr')), ...(await grep('chat-widget'))]
  const ghl = ghlInCode(ghlHits)
  const hl = hlInCode({ formHits: await grep(s.formId), widgetHits: await grep('hl/widget.js'), chatHits: await grep(s.chatId) })
  const gaps = codeGaps({ ghl, hl })
  if (!gaps.length) {
    await move(s, 'publishing', 'Lovable’s code search: our form and chat are in, and GoHighLevel’s form and chat are out.', 'Publishing.')
    return true
  }
  if (Date.now() - Date.parse(s.stepAt) < 45_000) {
    // Lovable's last edit can take a moment to reach its code search: look again next minute before asking again.
    logLine(s, `Lovable’s code search shows: ${gaps.join(' ')} Looking again in a minute.`)
    await save(s)
    return false
  }
  if (s.followUps < 1) {
    const sent = await sendOnce(s, followUpMessage(gaps))
    s.followUps += 1
    s.messageId = sent.messageId
    s.threadId = sent.threadId
    await move(s, 'editing', `Lovable left something undone: ${gaps.join(' ')} Sent one follow-up (message ${sent.messageId}).`, 'Lovable is finishing the swap.')
    return false
  }
  throw new SwapStop(`After a follow-up, Lovable still left: ${gaps.join(' ')} Nothing was published: finish it in Lovable (${editorLink(s.projectId)}).`)
}

/** publishing → checking_live. */
async function publish(s: WidgetSwap): Promise<boolean> {
  if (!s.projectId) throw new SwapStop('Lost the Lovable project.')
  try {
    const dep = await lovableMcpDeploy(s.projectId)
    await move(s, 'checking_live', `Asked Lovable to publish it${dep.url ? ` (${dep.url})` : ''}.`, 'Published; checking the live site.')
  } catch (err) {
    if (err instanceof LovableMcpError && /refus|not allowed|forbidden|permission|upgrade|plan|limit/i.test(err.message)) {
      throw new SwapStop(`Lovable wouldn’t publish it: ${err.message}. The edit is saved in Lovable (${editorLink(s.projectId)}): press Publish there.`)
    }
    throw err
  }
  return false
}

/** checking_live → done, or still waiting for the published site. */
async function checkLive(s: WidgetSwap): Promise<boolean> {
  if (!s.siteUrl || !s.formId || !s.chatId) throw new SwapStop('Lost the site link or the form and chat ids.')
  const live = await liveCode(s.siteUrl)
  if (live) {
    const st = liveState(live.code, { formId: s.formId, chatId: s.chatId })
    s.after = st
    if (liveSwapped(st)) {
      const form = st.hlForm ? 'Hell-level’s form and chat' : 'Hell-level’s chat (the form is on a page the home page doesn’t load; Lovable’s code has it)'
      const credits = s.credits !== null ? ` Lovable credits used: ${s.credits}.` : ''
      await move(s, 'done', `Live at ${s.siteUrl}: ${form}, and no GoHighLevel form or chat.${credits}`, `Swapped: live at ${s.siteUrl}.${credits}`)
      return false
    }
  }
  if (Date.now() - Date.parse(s.stepAt) > LIVE_GIVE_UP_MS) {
    const why = s.after ? liveGaps(s.after) : 'It didn’t load.'
    throw new SwapStop(`Published, but after 30 minutes ${s.siteUrl} still isn’t swapped: ${why} Look in Lovable (${editorLink(s.projectId)}).`)
  }
  await save(s)
  return false
}

async function runStep(s: WidgetSwap): Promise<boolean> {
  if (s.status === 'queued') return prepare(s)
  if (s.status === 'sending') return send(s)
  if (s.status === 'editing') return watchEdit(s)
  if (s.status === 'checking_code') return checkCode(s)
  if (s.status === 'publishing') return publish(s)
  if (s.status === 'checking_live') return checkLive(s)
  return false
}

/** Carry one swap on as far as it can go now. True when it moved to another step. */
async function advance(clientId: string): Promise<boolean> {
  let moved = false
  for (let i = 0; i < 4; i++) {
    const s = await load(clientId)
    if (!s || !(s.status === 'queued' || WORKING.includes(s.status))) return moved
    const was = s.status
    try {
      const again = await runStep(s)
      moved ||= s.status !== was
      if (!again) return moved
    } catch (err) {
      const stop = err instanceof SwapStop || (err instanceof LovableMcpError && err.reconnect) || s.tries + 1 >= MAX_TRIES
      if (stop) {
        const why = err instanceof LovableMcpError && err.reconnect ? `${err.message} (SEO page → Setup card), then queue the swap again.` : describe(err)
        await move(s, 'failed', `Stopped while ${was}: ${why}`, why)
        return true
      }
      s.tries += 1
      logLine(s, `Try ${s.tries} of ${MAX_TRIES} while ${was} didn’t go through: ${describe(err).slice(0, 300)}`)
      s.detail = `Trying again: ${describe(err).slice(0, 200)}`
      await save(s)
      return moved
    }
  }
  return moved
}

let sweeping = false
const lastPoll = new Map<string, number>()

/** The scheduler's call: swaps under way move on, and queued ones start while fewer than AT_ONCE are. */
export async function maybeSweepWidgetSwaps(now = Date.now()): Promise<number> {
  if (sweeping) return 0
  sweeping = true
  try {
    const all = await readSwaps()
    let moved = 0
    const working = all.filter((s) => WORKING.includes(s.status))
    for (const s of working) {
      const every = s.status === 'editing' ? EDIT_POLL_MS : s.status === 'checking_live' ? LIVE_POLL_MS : 0
      if (every && now - (lastPoll.get(s.clientId) ?? 0) < every - 5_000) continue
      lastPoll.set(s.clientId, now)
      if (await advance(s.clientId)) moved += 1
    }
    let free = AT_ONCE - working.length
    for (const s of all.filter((x) => x.status === 'queued')) {
      if (free <= 0) break
      free -= 1
      lastPoll.set(s.clientId, now)
      if (await advance(s.clientId)) moved += 1
    }
    return moved
  } finally {
    sweeping = false
  }
}
