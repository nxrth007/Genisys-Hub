/**
 * Read a HighLevel security code from the Google Workspace mailbox
 * that already receives those emails. Read-only: the fetch uses
 * BODY.PEEK, sets no flags, and deletes nothing.
 *
 * IMAP SINCE is date-only, so the search is wide and the real cutoff
 * is the moment Send security code was clicked.
 */

export type OtpImapSettings = {
  host: string
  port: number
  user: string
  password: string
}

export function imapSettings(env: NodeJS.ProcessEnv = process.env): OtpImapSettings | null {
  const host = env.GHL_OTP_IMAP_HOST?.trim()
  const user = env.GHL_OTP_IMAP_USER?.trim()
  const password = env.GHL_OTP_IMAP_PASSWORD?.trim()
  if (!host || !user || !password) return null
  const port = Number(env.GHL_OTP_IMAP_PORT || '993')
  return { host, port: Number.isFinite(port) && port > 0 ? port : 993, user, password }
}

const HIGHLEVEL_FROM = /(?:^|[.@])(?:gohighlevel\.com|leadconnectorhq\.com|msgsndr\.com)\b|highlevel/i
const CODE_TALK = /security code|verification code|one[- ]time (?:password|code)|login code|sign[- ]in code|\botp\b/i

/** The From address has to be HighLevel, and the mail has to be about a code. */
export function isHighLevelSecurityMail(from: string, subject: string, body: string): boolean {
  if (!HIGHLEVEL_FROM.test(from)) return false
  return CODE_TALK.test(`${subject}\n${body}`)
}

export function extractSecurityCode(text: string): string | null {
  const labeled = text.match(
    /(?:security code|verification code|one[- ]time (?:password|code)|login code|sign[- ]in code|your code(?: is)?)\D{0,40}(\d{4,8})/i,
  )
  if (labeled?.[1]) return labeled[1]
  const standalone = text.match(/(?:^|[\r\n])\s*(\d{6})\s*(?:[\r\n]|$)/)
  return standalone?.[1] ?? null
}

export type MailHit = {
  from: string
  subject: string
  body: string
  receivedAt: Date
}

/** Newest HighLevel security-code mail at or after the Send click. */
export function pickSecurityCode(messages: MailHit[], sentAt: Date): string | null {
  const cutoff = sentAt.getTime() - 15_000
  const hits = messages
    .filter((m) => m.receivedAt.getTime() >= cutoff)
    .filter((m) => isHighLevelSecurityMail(m.from, m.subject, m.body))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  for (const message of hits) {
    const code = extractSecurityCode(`${message.subject}\n${message.body}`)
    if (code) return code
  }
  return null
}

type ImapAddress = { name?: string; address?: string }
type ImapMessage = {
  envelope?: { from?: ImapAddress[]; subject?: string }
  internalDate?: Date | string
  source?: Buffer
}

/**
 * Poll the inbox. Returns null when IMAP is not configured or no
 * matching code has arrived. Never marks mail read and never deletes.
 */
export async function fetchLatestSecurityCode(sentAt: Date, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const settings = imapSettings(env)
  if (!settings) return null
  const { ImapFlow } = (await import('imapflow')) as {
    ImapFlow: new (opts: Record<string, unknown>) => {
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
  }
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
  await client.connect()
  let lock: { release: () => void } | null = null
  try {
    lock = await client.getMailboxLock('INBOX', { readOnly: true })
    const since = new Date(sentAt.getTime() - 24 * 60 * 60 * 1000)
    const found = await client.search({ since }, { uid: true })
    const uids = Array.isArray(found) ? found.slice(-25) : []
    if (!uids.length) return null
    const hits: MailHit[] = []
    for await (const msg of client.fetch(uids, { envelope: true, internalDate: true, source: true }, { uid: true })) {
      const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ')
      const subject = msg.envelope?.subject || ''
      const body = msg.source ? msg.source.toString('utf8') : ''
      const receivedAt = msg.internalDate ? new Date(msg.internalDate) : new Date(0)
      hits.push({ from, subject, body, receivedAt })
    }
    return pickSecurityCode(hits, sentAt)
  } finally {
    lock?.release()
    await client.logout().catch(() => {})
  }
}
