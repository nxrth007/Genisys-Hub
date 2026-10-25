import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { HlEmailDomain, Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { upsertContact } from './contacts'
import { dnsProvider, resolve } from './dns-lookup'
import { HlInputError } from './http'
import { createDomain, createRoute, deleteDomain, deleteRoute, ensureEventWebhook, getDomain, mailgunStatus, MailgunError, sendMailgun, verifyDomain, type MailgunDomain, type MailgunRecord } from './mailgun'
import { createRecord, deleteRecord, dnsRecords, getNameservers } from './porkbun'
import { publicBase } from './twilio'

/**
 * A sub-account's email (Settings → Email Services), plug-and-play as in
 * GoHighLevel: give it the client's domain and Hell-level does the rest.
 *
 * - Mailgun gets a subdomain of it ("mail.forte.com"). Nothing touches the
 *   client's own mailbox, or GoHighLevel's email on the main domain.
 * - When the domain's DNS is Porkbun's (a domain held here), Hell-level writes
 *   the records itself and Mailgun passes them within minutes. Anywhere else,
 *   the records are listed to add, and checked until they're there.
 * - Email goes out from the client's own address (hello@forte.com), with
 *   replies directed to the subdomain, where Mailgun hands them to the Hub:
 *   they land in Conversations, start "Customer replied by email"
 *   automations, and are copied to the owner, who doesn't log in here.
 * - Bounces, spam reports and unsubscribes stop email to that contact.
 *   Automation email carries an unsubscribe link and the business's address,
 *   as the law asks of business email.
 *
 * Mailgun's side: src/lib/hl/mailgun.ts.
 */

const SUBDOMAINS = ['mail', 'mg', 'send', 'post']

export const inboundUrl = () => `${publicBase()}/api/hl/public/email/inbound`
export const eventsUrl = () => `${publicBase()}/api/hl/public/email/events`

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "https://www.Forte.com/x" → "forte.com". */
export function cleanDomain(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(s) ? s : null
}

export type EmailRecord = MailgunRecord & { /** Relative to the client's domain ("mail", "pdk1._domainkey.mail"); "" for the domain itself. */ host: string }

const hostOf = (name: string, root: string) => (name === root ? '' : name.endsWith(`.${root}`) ? name.slice(0, -(root.length + 1)) : name)
const withHosts = (records: MailgunRecord[], root: string): EmailRecord[] => records.map((r) => ({ ...r, host: hostOf(r.name, root) }))
export const recordsOf = (row: Pick<HlEmailDomain, 'records'>) => (Array.isArray(row.records) ? (row.records as unknown as EmailRecord[]) : [])

const same = (a: string, b: string) => a.toLowerCase().replace(/^"|"$/g, '').replace(/\.$/, '') === b.toLowerCase().replace(/^"|"$/g, '').replace(/\.$/, '')

/** A name that already answers in DNS (a webmail host, say) is someone else's. */
async function inUse(name: string): Promise<boolean> {
  const answers = await Promise.all((['A', 'CNAME', 'MX', 'TXT'] as const).map((t) => resolve(name, t).catch(() => [])))
  return answers.some((a) => a.length > 0)
}

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

export type EmailChoice = { name: string; held: boolean }

/** The domains this sub-account could send from: those in Hell-level, and its website's. */
export async function emailDomainChoices(accountId: string): Promise<EmailChoice[]> {
  const [domains, account] = await Promise.all([
    prisma.hlDomain.findMany({ where: { accountId, status: 'active' }, select: { name: true, origin: true }, orderBy: { createdAt: 'asc' } }),
    prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true, client: { select: { siteUrl: true } } } }),
  ])
  const out: EmailChoice[] = []
  const add = (name: string | null, held: boolean) => {
    if (name && !out.some((c) => c.name === name)) out.push({ name, held })
  }
  for (const d of domains) add(cleanDomain(d.name), d.origin !== 'external')
  add(cleanDomain(readProfile(account?.profile).website ?? ''), false)
  add(cleanDomain(account?.client?.siteUrl ?? ''), false)
  return out
}

/** Write Mailgun's records into Porkbun (skipping any already there), plus a starter DMARC policy when the domain has none. */
async function writeRecords(root: string, records: EmailRecord[]): Promise<string[]> {
  const existing = await dnsRecords(root)
  const problems: string[] = []
  for (const r of records) {
    const there = existing.some((e) => e.host === r.host && e.type === r.type && same(e.content, r.value) && (r.type !== 'MX' || e.prio === r.priority))
    if (there) continue
    try {
      await createRecord(root, { host: r.host, type: r.type, content: r.value, ttl: 600, prio: r.type === 'MX' ? (r.priority ?? 10) : null })
    } catch (err) {
      problems.push(`${r.type} ${r.host || '@'}: ${errText(err)}`)
    }
  }
  if (!existing.some((e) => e.host === '_dmarc' && e.type === 'TXT')) {
    await createRecord(root, { host: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=none;', ttl: 600 }).catch((err) => problems.push(`DMARC: ${errText(err)}`))
  }
  return problems
}

/**
 * Set up email on one of the sub-account's domains. Mailgun takes a
 * subdomain of it; on Porkbun DNS the records are written here; replies and
 * delivery news are pointed at the Hub. Running it again for the same domain
 * just checks it again.
 */
export async function setUpEmail(o: { accountId: string; domain: string; by: string }): Promise<HlEmailDomain> {
  const root = cleanDomain(o.domain)
  if (!root) throw new HlInputError('That isn’t a domain name.')
  const existing = await prisma.hlEmailDomain.findUnique({ where: { accountId: o.accountId } })
  if (existing) {
    if (existing.rootDomain === root) return checkEmail(o.accountId)
    throw new HlInputError(`Email is already set up on ${existing.rootDomain}. Remove it first to use ${root} instead.`)
  }
  const held = await prisma.hlDomain.findUnique({ where: { name: root }, select: { accountId: true, origin: true, status: true } })
  if (held && held.accountId !== o.accountId) throw new HlInputError(`${root} belongs to another sub-account.`)
  const ours = !!held && held.origin !== 'external' && held.status === 'active'
  const onPorkbunNs = ours ? await getNameservers(root).then((ns) => ns.length > 0 && ns.every((n) => n.endsWith('.porkbun.com'))).catch(() => null) : null
  const { provider } = await dnsProvider(root).catch(() => ({ provider: null as string | null }))
  const porkbun = ours && (onPorkbunNs ?? provider === 'Porkbun')

  // The first subdomain that's free in DNS, here, and at Mailgun (a domain can only be in one Mailgun account).
  let made: MailgunDomain | null = null
  let refusal = ''
  for (const sub of SUBDOMAINS) {
    const name = `${sub}.${root}`
    if (await prisma.hlEmailDomain.findUnique({ where: { domain: name } })) continue
    try {
      const mine = await getDomain(name)
      if (!mine && (await inUse(name))) continue
      made = mine ?? (await createDomain(name))
      break
    } catch (err) {
      // Taken (another Mailgun account has it): try the next name. Any other refusal (a plan's domain limit, say) is the answer.
      if (err instanceof MailgunError && (err.status === 400 || err.status === 409) && /already|exist|taken|registered|in use/i.test(err.message)) {
        refusal = err.message
        continue
      }
      if (err instanceof MailgunError) throw new HlInputError(`Mailgun: ${err.message}`)
      throw err
    }
  }
  if (!made) throw new HlInputError(`Mailgun wouldn’t take a subdomain of ${root}${refusal ? ` (${refusal})` : ''}.`)

  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: o.accountId }, select: { name: true, profile: true } })
  const records = withHosts(made.records, root)
  await prisma.hlEmailDomain.create({
    data: {
      accountId: o.accountId,
      rootDomain: root,
      domain: made.name,
      fromName: readProfile(account.profile).businessName?.trim() || account.name,
      dnsMode: porkbun ? 'porkbun' : 'external',
      records: records as unknown as Prisma.InputJsonValue,
      status: 'verifying',
      createdBy: o.by,
    },
  })
  const problems = porkbun ? await writeRecords(root, records) : []
  if (problems.length) await prisma.hlEmailDomain.update({ where: { accountId: o.accountId }, data: { lastError: `Couldn’t add every record to the DNS: ${problems.join('; ')}` } })
  // Delivery news for every domain comes to one webhook; once is enough, but it's harmless again.
  await ensureEventWebhook(eventsUrl()).catch((err) => console.warn('[hell-level] Mailgun event webhook:', errText(err)))
  console.log(`[hell-level] ${o.by} set up email on ${made.name} (${porkbun ? 'records written to Porkbun' : 'records to add at ' + (provider ?? 'their DNS host')})`)
  return checkEmail(o.accountId)
}

/**
 * Ask Mailgun to check the records again. Active once the sending records
 * pass; replies are routed to the Hub from then on.
 */
export async function checkEmail(accountId: string): Promise<HlEmailDomain> {
  const row = await prisma.hlEmailDomain.findUniqueOrThrow({ where: { accountId } })
  let d: MailgunDomain
  try {
    d = await verifyDomain(row.domain)
  } catch (err) {
    return prisma.hlEmailDomain.update({ where: { accountId }, data: { checkedAt: new Date(), lastError: `Mailgun: ${errText(err)}` } })
  }
  const records = withHosts(d.records, row.rootDomain)
  const active = d.state === 'active'
  let routeId = row.routeId
  let lastError: string | null = null
  if (active && !routeId) {
    try {
      routeId = await createRoute(row.domain, inboundUrl())
    } catch (err) {
      lastError = `Replies can’t come in yet: ${errText(err)}`
    }
  }
  const replies = records.filter((r) => r.purpose === 'receiving')
  if (active && replies.length && replies.some((r) => r.valid === false)) lastError = lastError ?? 'Sending works. Replies need the MX records below before they come back in.'
  if (!active && Date.now() - row.createdAt.getTime() > 2 * 86_400_000) lastError = 'The records still aren’t showing after two days. Check they were added exactly as listed.'
  return prisma.hlEmailDomain.update({
    where: { accountId },
    data: {
      records: records as unknown as Prisma.InputJsonValue,
      status: active ? 'active' : 'verifying',
      routeId,
      checkedAt: new Date(),
      ...(active && !row.verifiedAt ? { verifiedAt: new Date() } : {}),
      lastError,
    },
  })
}

/** The From name and address, and whether replies are copied to the owner. */
export async function updateEmailSettings(accountId: string, o: { fromName?: string | null; fromLocal?: string | null; forwardReplies?: boolean }): Promise<HlEmailDomain> {
  const data: Prisma.HlEmailDomainUpdateInput = {}
  if (o.fromName !== undefined) data.fromName = (o.fromName ?? '').replace(/["<>\r\n]/g, '').trim().slice(0, 80) || null
  if (o.fromLocal !== undefined) {
    const local = (o.fromLocal ?? '').trim().toLowerCase()
    if (!/^[a-z0-9]([a-z0-9._+-]{0,40}[a-z0-9])?$/.test(local)) throw new HlInputError('The address before the @ can only have letters, numbers, dots, dashes and underscores.')
    data.fromLocal = local
  }
  if (typeof o.forwardReplies === 'boolean') data.forwardReplies = o.forwardReplies
  return prisma.hlEmailDomain.update({ where: { accountId }, data })
}

/** Take email off the sub-account: Mailgun's domain and route go, and the records Hell-level wrote. */
export async function removeEmail(accountId: string, by: string): Promise<void> {
  const row = await prisma.hlEmailDomain.findUnique({ where: { accountId } })
  if (!row) return
  if (row.routeId) await deleteRoute(row.routeId).catch((err) => console.warn('[hell-level] Mailgun route:', errText(err)))
  await deleteDomain(row.domain).catch((err) => console.warn('[hell-level] Mailgun domain:', errText(err)))
  if (row.dnsMode === 'porkbun') {
    const ours = recordsOf(row)
    const live = await dnsRecords(row.rootDomain).catch(() => [])
    for (const e of live) {
      if (ours.some((r) => r.host === e.host && r.type === e.type && same(r.value, e.content))) await deleteRecord(row.rootDomain, e.id).catch(() => undefined)
    }
  }
  await prisma.hlEmailDomain.delete({ where: { accountId } })
  console.log(`[hell-level] ${by} removed email from ${row.domain}`)
}

/** A domain just became the sub-account's (bought, transferred in, linked): set email up on it, if Mailgun is connected and there's none yet. */
export async function maybeSetUpEmail(accountId: string, domain: string, by: string): Promise<void> {
  if (await prisma.hlEmailDomain.findUnique({ where: { accountId }, select: { id: true } })) return
  if (!(await mailgunStatus()).connected) return
  await setUpEmail({ accountId, domain, by }).catch((err) => console.warn(`[hell-level] email on ${domain}:`, errText(err)))
}

/** Every few minutes: domains still waiting on their records get checked again. */
let lastSweep = 0
export async function checkPendingEmail(): Promise<void> {
  if (Date.now() - lastSweep < 5 * 60_000) return
  lastSweep = Date.now()
  const rows = await prisma.hlEmailDomain.findMany({ where: { status: 'verifying' }, select: { accountId: true } })
  for (const r of rows) await checkEmail(r.accountId).catch((err) => console.warn('[hell-level] email check:', errText(err)))
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type EmailResult = { ok: boolean; detail: string; messageId?: string }

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i

/** A display name made safe for a From line. */
const quoteName = (s: string) => `"${s.replace(/["\\\r\n]/g, '').trim()}"`

async function touch(contactId: string, preview: string, unread = false) {
  await prisma.hlContact.update({
    where: { id: contactId },
    data: { lastMessageAt: new Date(), lastMessage: preview.slice(0, 200), ...(unread ? { unread: { increment: 1 } } : {}) },
  })
}

const secret = () => process.env.AUTH_SECRET || 'genisys-hub'

/** A link only this contact's email could have: it unsubscribes them. */
export function unsubscribeToken(contactId: string): string {
  return `${contactId}.${createHmac('sha256', secret()).update(`hl-unsubscribe:${contactId}`).digest('base64url').slice(0, 24)}`
}

export function contactFromToken(token: string): string | null {
  const [id] = token.split('.')
  if (!id) return null
  const want = Buffer.from(unsubscribeToken(id))
  const got = Buffer.from(token)
  return want.length === got.length && timingSafeEqual(want, got) ? id : null
}

export const unsubscribeUrl = (contactId: string) => `${publicBase()}/hl/unsubscribe/${unsubscribeToken(contactId)}`

/**
 * Email a contact from the sub-account's address. `bulk` (automations) adds
 * the unsubscribe link and the business's address; a person's one-to-one
 * email from Conversations goes as written.
 */
export async function sendEmailToContact(o: { accountId: string; contactId: string; subject: string; body: string; by: string; runId?: string; bulk?: boolean; fromName?: string }): Promise<EmailResult> {
  const contact = await prisma.hlContact.findUnique({ where: { id: o.contactId } })
  if (!contact || contact.accountId !== o.accountId) return { ok: false, detail: 'Contact not found' }
  const to = (contact.email ?? '').trim().toLowerCase()
  if (!EMAIL.test(to)) return { ok: false, detail: 'The contact has no email address' }
  if (contact.emailDnd) return { ok: false, detail: `No more email to this contact (${contact.emailDndReason ?? 'unsubscribed'})` }
  const setup = await prisma.hlEmailDomain.findUnique({ where: { accountId: o.accountId } })
  if (!setup) return { ok: false, detail: 'Email isn’t set up for this sub-account yet (Settings → Email Services)' }
  if (setup.status !== 'active') return { ok: false, detail: 'Email is still being verified (Settings → Email Services)' }
  const subject = o.subject.replace(/[\r\n]+/g, ' ').trim() || '(no subject)'
  let text = o.body.trim()
  if (!text) return { ok: false, detail: 'Empty email' }

  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: o.accountId }, select: { name: true, profile: true } })
  const profile = readProfile(account.profile)
  const business = setup.fromName || profile.businessName || account.name
  const sender = o.fromName?.trim() || business
  const headers: Record<string, string> = {}
  // Thread it with what they last wrote (not an out-of-office), so it reads as a conversation in their inbox.
  const recent = await prisma.hlMessage.findMany({ where: { contactId: contact.id, channel: 'email', direction: 'inbound', providerSid: { not: null } }, orderBy: { createdAt: 'desc' }, take: 10, select: { providerSid: true, meta: true } })
  const lastIn = recent.find((m) => !(m.meta as { automatic?: boolean } | null)?.automatic)
  if (lastIn?.providerSid) {
    headers['In-Reply-To'] = `<${lastIn.providerSid}>`
    headers['References'] = `<${lastIn.providerSid}>`
  }
  if (o.bulk) {
    const unsub = unsubscribeUrl(contact.id)
    text += `\n\n--\n${business}${profile.address ? `\n${profile.address}` : ''}\nDon’t want these emails? Unsubscribe: ${unsub}`
    headers['List-Unsubscribe'] = `<${unsub}>`
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  const from = `${setup.fromLocal}@${setup.rootDomain}`
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  const base = { accountId: o.accountId, contactId: contact.id, direction: 'outbound', channel: 'email', body: text, from, to, by: o.by, runId: o.runId ?? null, meta: { subject } as Prisma.InputJsonValue }
  try {
    const id = await sendMailgun({
      domain: setup.domain,
      from: `${quoteName(sender)} <${from}>`,
      to: name ? `${quoteName(name)} <${to}>` : to,
      subject,
      text,
      replyTo: `${quoteName(business)} <${setup.fromLocal}@${setup.domain}>`,
      headers,
      tag: o.bulk ? 'automation' : 'conversation',
      vars: { hl_account: o.accountId },
    })
    const msg = await prisma.hlMessage.create({ data: { ...base, status: 'queued', providerSid: id } })
    await touch(contact.id, `✉ ${subject}`)
    return { ok: true, detail: `Emailed ${to}`, messageId: msg.id }
  } catch (err) {
    const detail = errText(err)
    const msg = await prisma.hlMessage.create({ data: { ...base, status: 'failed', error: detail } })
    await touch(contact.id, `✉ ${subject}`)
    return { ok: false, detail, messageId: msg.id }
  }
}

/** A test email from the sub-account's address to a person (Settings → Email Services). */
export async function sendTestEmail(accountId: string, to: string): Promise<string> {
  const address = to.trim().toLowerCase()
  if (!EMAIL.test(address)) throw new HlInputError('That isn’t an email address.')
  const setup = await prisma.hlEmailDomain.findUnique({ where: { accountId } })
  if (!setup || setup.status !== 'active') throw new HlInputError('Email isn’t active yet: wait for the records to check out.')
  const business = setup.fromName || setup.rootDomain
  await sendMailgun({
    domain: setup.domain,
    from: `${quoteName(business)} <${setup.fromLocal}@${setup.rootDomain}>`,
    to: address,
    subject: `Test email from ${business}`,
    text: `This is a test from ${setup.fromLocal}@${setup.rootDomain}, sent through Hell-level.\n\nReply to it, and the reply shows up in Conversations.`,
    replyTo: `${quoteName(business)} <${setup.fromLocal}@${setup.domain}>`,
    tag: 'test',
  })
  return `Sent to ${address}`
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/** "Dana Whitfield <dana@x.com>" → its parts. */
export function parseAddress(raw: string): { name: string | null; email: string | null } {
  const s = raw.trim()
  const angled = s.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/)
  if (angled) return { name: angled[1].trim().replace(/^"|"$/g, '').trim() || null, email: angled[2].toLowerCase() }
  return EMAIL.test(s) ? { name: null, email: s.toLowerCase() } : { name: null, email: null }
}

export type InboundEmail = {
  recipient: string
  sender: string
  from: string
  subject: string
  bodyPlain: string
  strippedText: string
  /** [name, value] pairs, Mailgun's "message-headers". */
  headers: [string, string][]
  attachments: number
}

const header = (h: [string, string][], name: string) => h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null

/**
 * An email to a sub-account's subdomain (a reply, usually), as Mailgun
 * forwards it: onto the contact's conversation, then automations, and a copy
 * to the owner. Out-of-office and bounce replies are kept but set nothing off.
 */
export async function recordInboundEmail(m: InboundEmail): Promise<{ ok: boolean; detail: string }> {
  const domains = m.recipient
    .split(',')
    .map((a) => (parseAddress(a).email ?? '').split('@')[1])
    .filter(Boolean)
  const setup = domains.length ? await prisma.hlEmailDomain.findFirst({ where: { domain: { in: domains } } }) : null
  if (!setup) return { ok: false, detail: `No sub-account takes email for ${m.recipient}` }
  const header_ = parseAddress(m.from)
  const from = header_.email ? header_ : parseAddress(m.sender)
  const email = from.email
  if (!email) return { ok: false, detail: 'No sender address' }
  // Its own mail (a copy, a loop): nothing to record.
  if (email.endsWith(`@${setup.domain}`) || email === `${setup.fromLocal}@${setup.rootDomain}`) return { ok: true, detail: 'From this sub-account itself' }
  const messageId = (header(m.headers, 'message-id') ?? '').trim().replace(/^<|>$/g, '') || null
  if (messageId && (await prisma.hlMessage.findUnique({ where: { providerSid: messageId }, select: { id: true } }))) return { ok: true, detail: 'Already recorded' }
  const autoSubmitted = header(m.headers, 'auto-submitted')
  const automatic = (!!autoSubmitted && autoSubmitted.toLowerCase() !== 'no') || /^(mailer-daemon|postmaster|no-?reply)@/i.test(email)

  const { contact } = await upsertContact(setup.accountId, { email, fullName: from.name, source: 'email' })
  const body = (m.strippedText || m.bodyPlain).trim() || '(empty email)'
  const subject = m.subject.trim() || '(no subject)'
  await prisma.hlMessage.create({
    data: {
      accountId: setup.accountId,
      contactId: contact.id,
      direction: 'inbound',
      channel: 'email',
      body,
      status: 'received',
      from: email,
      to: m.recipient,
      providerSid: messageId,
      meta: { subject, ...(m.attachments ? { attachments: m.attachments } : {}), ...(automatic ? { automatic: true } : {}) } as Prisma.InputJsonValue,
    },
  })
  await touch(contact.id, `✉ ${subject}`, !automatic)
  if (automatic) return { ok: true, detail: 'Automatic reply: recorded only' }
  void import('./automation')
    .then((a) => a.fireTrigger(setup.accountId, contact.id, { type: 'inbound_email', text: body }))
    .catch((err) => console.error('[hell-level] inbound_email trigger failed:', err))
  if (setup.forwardReplies) await forwardToOwner(setup, { name: from.name, email }, subject, body).catch((err) => console.warn('[hell-level] reply copy to owner:', errText(err)))
  return { ok: true, detail: `Recorded on ${email}` }
}

/** A copy of a reply to the owner's email; replying to it answers the customer directly. */
async function forwardToOwner(setup: HlEmailDomain, sender: { name: string | null; email: string }, subject: string, body: string) {
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: setup.accountId }, select: { name: true, profile: true } })
  const profile = readProfile(account.profile)
  const owners = (profile.notifyEmail ?? '')
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => EMAIL.test(a) && !a.endsWith(`@${setup.domain}`))
  if (!owners.length) return
  const who = sender.name ? `${sender.name} (${sender.email})` : sender.email
  await sendMailgun({
    domain: setup.domain,
    from: `${quoteName(`${sender.name ?? sender.email} via ${setup.fromName || account.name}`)} <${setup.fromLocal}@${setup.rootDomain}>`,
    to: owners.join(', '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: `${who} wrote:\n\n${body}\n\n--\nReply to this email to answer them directly.`,
    replyTo: sender.name ? `${quoteName(sender.name)} <${sender.email}>` : sender.email,
    tag: 'owner-copy',
  })
}

// ---------------------------------------------------------------------------
// Delivery news (Mailgun's event webhook)
// ---------------------------------------------------------------------------

type EventData = {
  event?: string
  severity?: string
  reason?: string
  recipient?: string
  message?: { headers?: Record<string, string> }
  'delivery-status'?: { message?: string; description?: string; code?: number }
}

async function stopEmail(contactId: string, reason: string) {
  await prisma.hlContact.update({ where: { id: contactId }, data: { emailDnd: true, emailDndReason: reason } })
}

/** Delivered, bounced, marked as spam, unsubscribed: onto the message, and the contact for the last three. */
export async function recordEmailEvent(ev: EventData): Promise<void> {
  const id = String(ev.message?.headers?.['message-id'] ?? '').replace(/^<|>$/g, '')
  const msg = id ? await prisma.hlMessage.findUnique({ where: { providerSid: id }, select: { id: true, contactId: true, status: true } }) : null
  if (!msg) return
  const why = [ev['delivery-status']?.description, ev['delivery-status']?.message, ev.reason].find((s) => typeof s === 'string' && s.trim()) ?? ''
  switch (ev.event) {
    case 'delivered':
      if (msg.status !== 'failed') await prisma.hlMessage.update({ where: { id: msg.id }, data: { status: 'delivered' } })
      return
    case 'failed':
      if (ev.severity === 'permanent') {
        await prisma.hlMessage.update({ where: { id: msg.id }, data: { status: 'failed', error: why.slice(0, 300) || 'Bounced' } })
        await stopEmail(msg.contactId, 'bounced')
      }
      return
    case 'complained':
      await stopEmail(msg.contactId, 'marked it as spam')
      return
    case 'unsubscribed':
      await stopEmail(msg.contactId, 'unsubscribed')
      return
  }
}

/** The unsubscribe link (and Gmail's one-click unsubscribe). */
export async function unsubscribeContact(contactId: string): Promise<{ email: string | null; business: string } | null> {
  const contact = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { id: true, email: true, emailDnd: true, account: { select: { name: true, profile: true } } } })
  if (!contact) return null
  if (!contact.emailDnd) await stopEmail(contact.id, 'unsubscribed')
  return { email: contact.email, business: readProfile(contact.account.profile).businessName || contact.account.name }
}
