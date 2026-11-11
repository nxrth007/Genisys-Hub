/**
 * Read a HighLevel security code from the Google Workspace mailbox
 * that already receives those emails. Read-only: each mailbox is opened
 * with EXAMINE and the fetch uses BODY.PEEK. Nothing is marked and
 * nothing is deleted.
 *
 * IMAP SINCE is date-only, so the search is wide and the real cutoff
 * is the Send click, with about two minutes of clock skew.
 */

export type OtpImapSettings = {
  host: string
  port: number
  user: string
  password: string
}

export type OtpMailLog = (line: string) => void

export function imapSettings(env: NodeJS.ProcessEnv = process.env): OtpImapSettings | null {
  const host = env.GHL_OTP_IMAP_HOST?.trim()
  const user = env.GHL_OTP_IMAP_USER?.trim()
  const password = env.GHL_OTP_IMAP_PASSWORD?.trim()
  if (!host || !user || !password) return null
  const port = Number(env.GHL_OTP_IMAP_PORT || '993')
  return { host, port: Number.isFinite(port) && port > 0 ? port : 993, user, password }
}

const HIGHLEVEL_SENDER = /highlevel|gohighlevel|leadconnector|msgsndr/i
/** How far before the Send click a message may still be the code we just asked for. */
export const OTP_CLOCK_SKEW_MS = 2 * 60 * 1000
const MAILBOXES = ['INBOX', '[Gmail]/All Mail']

export function senderLooksHighLevel(from: string): boolean {
  return HIGHLEVEL_SENDER.test(from)
}

/** Quoted-printable and tags removed, so a code split by markup still reads as digits. */
export function htmlToText(raw: string): string {
  const decoded = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16)
    return code >= 32 && code < 127 ? String.fromCharCode(code) : ' '
  })
  const spaced = decoded
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&')
  const tight = spaced.replace(/[ \t\f\v]+/g, ' ')
  const joined = decoded.replace(/<[^>]+>/g, '')
  return `${tight}\n${joined}`.replace(/\s+/g, ' ').trim()
}

function isYear(digits: string): boolean {
  return digits.length === 4 && /^(19|20)\d{2}$/.test(digits)
}

export function extractSecurityCode(text: string): string | null {
  const plain = htmlToText(text)
  const labeled = plain.match(
    /(?:security code|verification code|one[- ]time (?:password|code)|login code|sign[- ]in code|your code(?: is)?|\botp\b)\D{0,40}(\d{4,8})(?!\d)/i,
  )
  if (labeled?.[1]) return labeled[1]
  const re = /(?:^|\D)(\d{4,8})(?=\D|$)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(plain))) {
    if (isYear(match[1]!)) continue
    return match[1]!
  }
  return null
}

export type MailHit = {
  from: string
  subject: string
  body: string
  receivedAt: Date
}

export type MailDecision = {
  accept: boolean
  reason: string
  code: string | null
}

export function classifySecurityMail(message: MailHit, sentAt: Date): MailDecision {
  const cutoff = sentAt.getTime() - OTP_CLOCK_SKEW_MS
  if (message.receivedAt.getTime() < cutoff) {
    return { accept: false, reason: `before the send click (${message.receivedAt.toISOString()})`, code: null }
  }
  if (!senderLooksHighLevel(message.from)) {
    return { accept: false, reason: 'sender is not HighLevel', code: null }
  }
  const code = extractSecurityCode(`${message.subject}\n${message.body}`)
  if (!code) return { accept: false, reason: 'no 4-8 digit code in the subject or body', code: null }
  return { accept: true, reason: `accepted ${code.length}-digit code`, code }
}

/** Newest HighLevel security-code mail at or after the Send click, minus clock skew. */
export function pickSecurityCode(messages: MailHit[], sentAt: Date): string | null {
  const hits = [...messages].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  for (const message of hits) {
    const decision = classifySecurityMail(message, sentAt)
    if (decision.accept && decision.code) return decision.code
  }
  return null
}

function redactDigits(value: string): string {
  return value.replace(/\d{4,8}/g, (digits) => '•'.repeat(digits.length))
}

function safeImapError(err: unknown, password: string): string {
  let message = err instanceof Error ? err.message : String(err)
  if (password && message.includes(password)) message = message.split(password).join('(password)')
  return message.slice(0, 300)
}

type ImapAddress = { name?: string; address?: string }
type ImapMessage = {
  envelope?: { from?: ImapAddress[]; subject?: string }
  internalDate?: Date | string
  source?: Buffer
}

type ImapClient = {
  connect: () => Promise<void>
  logout: () => Promise<void>
  getMailboxLock: (path: string, options?: { readOnly?: boolean }) => Promise<{ release: () => void }>
  search: (query: Record<string, unknown>, opts: { uid: boolean }) => Promise<number[] | false>
  fetch: (
    range: number[],
    query: Record<string, unknown>,
    opts: { uid: boolean },
  ) => AsyncIterable<ImapMessage>
}

/**
 * Poll INBOX and All Mail. Returns null when IMAP is not configured or
 * no matching code has arrived. The log receives connect, mailbox,
 * search, and per-message decisions, with passwords and digit codes removed.
 */
export async function fetchLatestSecurityCode(
  sentAt: Date,
  env: NodeJS.ProcessEnv = process.env,
  log: OtpMailLog = () => {},
): Promise<string | null> {
  const settings = imapSettings(env)
  if (!settings) {
    log('IMAP not configured (GHL_OTP_IMAP_HOST, GHL_OTP_IMAP_USER, or GHL_OTP_IMAP_PASSWORD is empty).')
    return null
  }
  const { ImapFlow } = (await import('imapflow')) as { ImapFlow: new (opts: Record<string, unknown>) => ImapClient }
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: true,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  })
  try {
    await client.connect()
    log(`IMAP connected to ${settings.host}:${settings.port} as ${settings.user} (read-only).`)
  } catch (err) {
    log(`IMAP connect/auth failed: ${safeImapError(err, settings.password)}`)
    return null
  }
  const cutoff = new Date(sentAt.getTime() - OTP_CLOCK_SKEW_MS).toISOString()
  const since = new Date(sentAt.getTime() - 24 * 60 * 60 * 1000)
  const sinceDay = since.toISOString().slice(0, 10)
  const hits: MailHit[] = []
  const seen = new Set<string>()
  try {
    for (const box of MAILBOXES) {
      let lock: { release: () => void } | null = null
      try {
        lock = await client.getMailboxLock(box, { readOnly: true })
        log(`Mailbox selected read-only (EXAMINE): ${box}`)
        const found = await client.search({ since }, { uid: true })
        const uids = Array.isArray(found) ? found : []
        log(`Search ${box} SINCE ${sinceDay} (IMAP date-only; keep mail at or after ${cutoff}): ${uids.length} hit(s).`)
        const recent = uids.slice(-15)
        let duplicates = 0
        if (recent.length) {
          for await (const msg of client.fetch(recent, { envelope: true, internalDate: true, source: true }, { uid: true })) {
            const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`.trim()).join(', ')
            const subject = msg.envelope?.subject || ''
            const body = msg.source ? msg.source.toString('utf8') : ''
            const receivedAt = msg.internalDate ? new Date(msg.internalDate) : new Date(0)
            const key = `${from}\n${subject}\n${receivedAt.toISOString()}`
            if (seen.has(key)) {
              duplicates += 1
              continue
            }
            seen.add(key)
            hits.push({ from, subject, body, receivedAt })
          }
        }
        if (duplicates) log(`Skipped ${duplicates} duplicate message(s) already read in another mailbox.`)
      } catch (err) {
        log(`Mailbox ${box} failed: ${safeImapError(err, settings.password)}`)
      } finally {
        lock?.release()
      }
    }
    const ranked = [...hits].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    let chosen: string | null = null
    let chosenAt = ''
    for (const message of ranked) {
      const decision = classifySecurityMail(message, sentAt)
      log(
        `candidate from="${redactDigits(message.from).slice(0, 120)}" subject="${redactDigits(message.subject).slice(0, 140)}" date=${message.receivedAt.toISOString()} — ${decision.reason}`,
      )
      if (!chosen && decision.accept && decision.code) {
        chosen = decision.code
        chosenAt = message.receivedAt.toISOString()
      }
    }
    if (!ranked.length) log('No candidate messages in INBOX or [Gmail]/All Mail.')
    if (chosen) log(`Using the newest accepted code (${chosen.length} digits, received ${chosenAt}).`)
    else if (ranked.length) log('No candidate was a HighLevel security code after the send click.')
    return chosen
  } finally {
    await client.logout().catch(() => {})
  }
}
