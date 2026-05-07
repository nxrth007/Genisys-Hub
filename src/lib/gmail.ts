/**
 * Gmail helper — ported from Pf Hub, adapted for Genisys Hub's env vars.
 *
 * Uses the same Google OAuth client as Auth.js SSO (AUTH_GOOGLE_ID/SECRET)
 * but requests additional Gmail scopes via a distinct redirect URI at
 * /api/gmail/callback. Google handles incremental consent automatically —
 * clicking "Connect Gmail" from Settings shows Google's consent screen
 * listing only the new scopes.
 *
 * Each connected mailbox is stored in the GmailAccount table. Access tokens
 * auto-refresh via googleapis' token listener.
 */
import { google } from 'googleapis'
import { prisma } from './prisma'
import { extractEmailAddress, extractEmailName } from './utils'

/**
 * Build the redirect URI. Accepts an explicit base URL from the route handler
 * (derived from proxy headers). Falls back to AUTH_URL, then localhost.
 */
function getRedirectUri(baseUrl?: string): string {
  const base = baseUrl || process.env.AUTH_URL || 'http://localhost:3000'
  return `${base}/api/gmail/callback`
}

/**
 * Derive the public-facing origin from a request, accounting for Render's
 * (or any) reverse proxy. `req.nextUrl.origin` returns the INTERNAL origin
 * (e.g. http://localhost:10000) behind a proxy. The real hostname lives in
 * the `host` header, and the protocol in `x-forwarded-proto`.
 */
export function getPublicOrigin(req: { headers: { get(name: string): string | null } }): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}

function getOAuth2Client(baseUrl?: string) {
  return new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
    getRedirectUri(baseUrl)
  )
}

export function getAuthUrl(baseUrl?: string, state?: string) {
  const oauth2Client = getOAuth2Client(baseUrl)
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  })
}

export async function exchangeCode(code: string, baseUrl?: string) {
  const oauth2Client = getOAuth2Client(baseUrl)
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const { data: userInfo } = await oauth2.userinfo.get()

  if (!userInfo.email) throw new Error('No email returned from Google')
  if (!tokens.access_token) throw new Error('No access token')

  const account = await prisma.gmailAccount.upsert({
    where: { email: userInfo.email },
    update: {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      tokenExpiry: new Date(tokens.expiry_date || Date.now() + 3600_000),
    },
    create: {
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      tokenExpiry: new Date(tokens.expiry_date || Date.now() + 3600_000),
    },
  })

  return account
}

async function getAuthenticatedClient(accountEmail: string) {
  const account = await prisma.gmailAccount.findUnique({ where: { email: accountEmail } })
  if (!account) throw new Error(`No Gmail account found for ${accountEmail}`)

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry.getTime(),
  })

  // Persist refreshed tokens as they rotate
  oauth2Client.on('tokens', async (newTokens) => {
    await prisma.gmailAccount.update({
      where: { email: accountEmail },
      data: {
        accessToken: newTokens.access_token || account.accessToken,
        tokenExpiry: newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : account.tokenExpiry,
      },
    })
  })

  return { gmail: google.gmail({ version: 'v1', auth: oauth2Client }), account }
}

function parseHeaders(headers: Array<{ name?: string | null; value?: string | null }>) {
  const get = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
  return {
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
  }
}

function decodeBody(part: { body?: { data?: string | null } }): string {
  if (!part?.body?.data) return ''
  return Buffer.from(part.body.data, 'base64url').toString('utf-8')
}

type MailPart = {
  mimeType?: string | null
  body?: { data?: string | null }
  parts?: MailPart[]
}

function extractBody(payload: MailPart): { text: string; html: string } {
  let text = ''
  let html = ''

  if (payload.mimeType === 'text/plain') {
    text = decodeBody(payload)
  } else if (payload.mimeType === 'text/html') {
    html = decodeBody(payload)
  } else if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && !text) text = decodeBody(part)
      if (part.mimeType === 'text/html' && !html) html = decodeBody(part)
      if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const nested = extractBody(part)
        if (!text && nested.text) text = nested.text
        if (!html && nested.html) html = nested.html
      }
    }
  }

  return { text, html }
}

export async function syncInbox(accountEmail: string, maxResults = 50) {
  const { gmail, account } = await getAuthenticatedClient(accountEmail)

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'in:inbox -in:trash',
  })

  const messages = response.data.messages || []
  let synced = 0

  for (const msg of messages) {
    if (!msg.id) continue
    const exists = await prisma.email.findUnique({ where: { gmailMessageId: msg.id } })
    if (exists) continue

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    })

    const headers = parseHeaders(detail.data.payload?.headers || [])
    const { text, html } = extractBody(detail.data.payload || {})

    await prisma.email.create({
      data: {
        gmailMessageId: msg.id,
        threadId: detail.data.threadId,
        accountId: account.id,
        from: extractEmailAddress(headers.from),
        fromName: extractEmailName(headers.from),
        to: headers.to,
        subject: headers.subject,
        bodyText: text || null,
        bodyHtml: html || null,
        snippet: detail.data.snippet || null,
        date: new Date(headers.date || Date.now()),
        isRead: !detail.data.labelIds?.includes('UNREAD'),
      },
    })
    synced++
  }

  const profile = await gmail.users.getProfile({ userId: 'me' })
  await prisma.gmailAccount.update({
    where: { email: accountEmail },
    data: { historyId: profile.data.historyId?.toString() },
  })

  return { synced, scanned: messages.length }
}

export async function syncSent(accountEmail: string, maxResults = 50) {
  const { gmail, account } = await getAuthenticatedClient(accountEmail)

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'in:sent',
  })

  const messages = response.data.messages || []
  let synced = 0

  for (const msg of messages) {
    if (!msg.id) continue
    const exists = await prisma.email.findUnique({ where: { gmailMessageId: msg.id } })
    if (exists) continue

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    })

    const headers = parseHeaders(detail.data.payload?.headers || [])
    const { text, html } = extractBody(detail.data.payload || {})

    await prisma.email.create({
      data: {
        gmailMessageId: msg.id,
        threadId: detail.data.threadId,
        accountId: account.id,
        from: extractEmailAddress(headers.from),
        fromName: extractEmailName(headers.from),
        to: headers.to,
        subject: headers.subject,
        bodyText: text || null,
        bodyHtml: html || null,
        snippet: detail.data.snippet || null,
        date: new Date(headers.date || Date.now()),
        isRead: true,
        folder: 'sent',
      },
    })
    synced++
  }

  return { synced, scanned: messages.length }
}

/**
 * Convert plain-text / light markdown → clean HTML body for sending.
 */
function markdownToHtml(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" style="color:#7c3aed;text-decoration:underline;">$1</a>'
    )
    // Auto-link bare URLs. Two guards prevent re-wrapping URLs that
    // already live inside the markdown-link <a href="..."> output of
    // the previous step:
    //   1. negative lookbehind (?<!=") skips URLs preceded by `="`
    //      (i.e. inside an HTML attribute value)
    //   2. char class excludes `"` so even if lookbehind misses, the
    //      match stops before the closing quote of the attribute
    //      and doesn't drag stray HTML into the wrapped <a>
    .replace(
      /(?<!=")(https?:\/\/[^\s<"]+)/g,
      '<a href="$1" style="color:#7c3aed;text-decoration:underline;">$1</a>'
    )
    .replace(/^[\*\-]\s+(.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;">$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;">$1</li>')

  html = html
    .split('\n\n')
    .map((para) => {
      const trimmed = para.trim()
      if (!trimmed) return ''
      if (trimmed.includes('<li'))
        return '<ul style="list-style-type:disc;padding-left:8px;margin:8px 0;">' + trimmed + '</ul>'
      return '<p style="margin:0 0 12px 0;line-height:1.6;">' + trimmed.replace(/\n/g, '<br>') + '</p>'
    })
    .join('\n')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;">${html}</body></html>`
}

/** RFC 2047 encoded-word for non-ASCII Subject headers.
 *
 *  Mail headers are spec'd as ASCII; non-ASCII content (em-dashes,
 *  arrows, accented chars, etc.) needs to be wrapped in
 *  `=?charset?encoding?content?=` form. Without this wrapping, strict
 *  clients (Outlook is one) fall back to Latin-1 interpretation of
 *  raw UTF-8 bytes — producing the classic `Ã¢Â€Â"` mojibake.
 *
 *  Pure-ASCII subjects pass through untouched. */
function encodeSubject(subject: string): string {
  // Fast path — ASCII only, nothing to encode.
  if (/^[\x00-\x7F]*$/.test(subject)) return subject
  const encoded = Buffer.from(subject, 'utf-8').toString('base64')
  return `=?UTF-8?B?${encoded}?=`
}

export async function sendEmail(params: {
  accountEmail: string
  to: string
  subject: string
  body: string
  inReplyTo?: string
  threadId?: string
}) {
  const { gmail } = await getAuthenticatedClient(params.accountEmail)

  const htmlBody =
    params.body.trim().startsWith('<!DOCTYPE') || params.body.trim().startsWith('<html')
      ? params.body
      : markdownToHtml(params.body)

  const headers = [
    `To: ${params.to}`,
    `From: ${params.accountEmail}`,
    `Subject: ${encodeSubject(params.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    // 8bit signals that the body contains raw UTF-8 octets (em-dashes,
    // arrows, etc.) rather than 7-bit ASCII. Without this, some
    // strict clients fall back to ASCII interpretation of the body.
    'Content-Transfer-Encoding: 8bit',
  ]
  if (params.inReplyTo) {
    headers.push(`In-Reply-To: ${params.inReplyTo}`)
    headers.push(`References: ${params.inReplyTo}`)
  }

  const message = headers.join('\r\n') + '\r\n\r\n' + htmlBody
  const encodedMessage = Buffer.from(message).toString('base64url')

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: params.threadId || undefined,
    },
  })

  return result.data
}

export async function listConnectedAccounts() {
  return prisma.gmailAccount.findMany({
    select: {
      id: true,
      email: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { emails: true } },
    },
    orderBy: { email: 'asc' },
  })
}

export async function disconnectAccount(email: string) {
  return prisma.gmailAccount.delete({ where: { email } })
}
