import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto'

/**
 * Publishing Lovable projects without a Business-plan API key.
 *
 * Lovable runs an MCP server (https://mcp.lovable.dev) for AI tools, on
 * every plan, whose `deploy_project` tool publishes a project to
 * production — the same thing as clicking Publish in the builder. It
 * signs in with OAuth: a client registers itself, the person logs in to
 * Lovable in their browser, and Lovable hands back a code at a local
 * address. With the `offline` scope the sign-in can be refreshed, so it
 * is done once.
 *
 * The Hub is a hosted app, and Lovable only redirects to local addresses
 * without prior approval. So the login finishes at
 * http://127.0.0.1:53682/callback — nothing listens there; the person
 * copies that address out of the browser and pastes it into the Hub,
 * which exchanges the code. (The same shape as `gcloud auth login
 * --no-browser`.) The code is single-use and bound to a verifier that
 * never leaves the server.
 *
 * Tokens are encrypted with the Vault's master key and kept in an
 * AppSetting rather than a Vault entry, because the refresh token
 * rotates and has to be rewritten without a person in the loop.
 */

const MCP_URL = 'https://mcp.lovable.dev'
const OAUTH = {
  authorize: 'https://lovable.dev/oauth/authorize',
  token: 'https://lovable.dev/oauth/token',
  register: 'https://lovable.dev/oauth/register',
  revoke: 'https://lovable.dev/oauth/revoke',
}
/** A loopback address: Lovable accepts these for self-registered clients. Nothing needs to listen on it. */
const REDIRECT_URI = 'http://127.0.0.1:53682/callback'
/** Keep the sign-in (offline) and act on projects. Nothing about workspaces, nothing that creates. */
const SCOPE = 'offline projects:read projects:write'
const PROTOCOL = '2025-06-18'

const CONNECTION_KEY = 'seo.lovable.connection'
const PENDING_KEY = 'seo.lovable.pending'
const PENDING_TTL_MS = 30 * 60_000

export class LovableMcpError extends Error {
  constructor(
    message: string,
    /** The sign-in is gone or was revoked; the person has to connect again. */
    readonly reconnect = false,
  ) {
    super(message)
  }
}

type Connection = {
  clientId: string
  accessToken: string
  refreshToken: string | null
  /** Epoch ms. */
  expiresAt: number
  scope: string | null
  account: string | null
  connectedBy: string
  connectedAt: string
  /** Set when a refresh was refused; cleared on reconnect. */
  broken?: string
}

type Pending = { clientId: string; verifier: string; state: string; createdAt: number }

// ---------------------------------------------------------------------------
// Encrypted storage
// ---------------------------------------------------------------------------

async function readSecret<T>(key: string): Promise<T | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } })
  if (!row) return null
  try {
    const { c, n } = JSON.parse(row.value) as { c: string; n: string }
    return JSON.parse(decryptSecret(Buffer.from(c, 'base64'), Buffer.from(n, 'base64'))) as T
  } catch {
    return null
  }
}

async function writeSecret(key: string, value: unknown): Promise<void> {
  const { ciphertext, nonce } = encryptSecret(JSON.stringify(value))
  const stored = JSON.stringify({ c: Buffer.from(ciphertext).toString('base64'), n: Buffer.from(nonce).toString('base64') })
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } })
}

async function deleteSecret(key: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key } })
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

const oauthMessage = (d: Record<string, unknown>, fallback: string) =>
  [d.error, d.error_description].filter((x) => typeof x === 'string' && x).join(': ') || fallback

/** Step 1: register a client and hand back the Lovable login URL to open. */
export async function startLovableConnect(): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const reg = await postJson(OAUTH.register, {
    client_name: 'Genisys Hub',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  })
  const clientId = typeof reg.data.client_id === 'string' ? reg.data.client_id : null
  if (reg.status >= 300 || !clientId) {
    throw new LovableMcpError(`Lovable wouldn’t register the Hub as a client (${oauthMessage(reg.data, `HTTP ${reg.status}`)}).`)
  }
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  await writeSecret(PENDING_KEY, { clientId, verifier, state, createdAt: Date.now() } satisfies Pending)

  const url = new URL(OAUTH.authorize)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
  url.searchParams.set('code_challenge_method', 'S256')
  // Which server the token is for (RFC 8707) — the MCP spec asks for it.
  url.searchParams.set('resource', MCP_URL)
  return { authorizeUrl: url.toString(), redirectUri: REDIRECT_URI }
}

/**
 * Step 2: the person pastes the address their browser ended up at
 * (http://127.0.0.1:53682/callback?code=…&state=…). Exchange the code and
 * keep the sign-in.
 */
export async function finishLovableConnect(pasted: string, by: string): Promise<{ account: string | null }> {
  const pending = await readSecret<Pending>(PENDING_KEY)
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new LovableMcpError('That sign-in attempt expired. Click Connect Lovable again.')
  }
  const raw = pasted.trim()
  let params: URLSearchParams
  try {
    params = raw.includes('?') ? new URL(raw).searchParams : new URLSearchParams(raw.replace(/^[?#]/, ''))
  } catch {
    throw new LovableMcpError('That doesn’t look like the address from the browser. Copy the whole address bar — it starts with http://127.0.0.1:53682/callback?code=')
  }
  if (params.get('error')) {
    throw new LovableMcpError(`Lovable didn’t approve the connection (${params.get('error_description') ?? params.get('error')}).`)
  }
  const code = params.get('code')
  if (!code) {
    throw new LovableMcpError('No sign-in code in that address. Copy the whole address bar after Lovable sends you to 127.0.0.1 — it contains "code=".')
  }
  if (params.get('state') !== pending.state) {
    throw new LovableMcpError('That address is from a different sign-in attempt. Click Connect Lovable again and use the newest tab.')
  }

  const tok = await postForm(OAUTH.token, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    resource: MCP_URL,
  })
  const accessToken = typeof tok.data.access_token === 'string' ? tok.data.access_token : null
  if (tok.status >= 300 || !accessToken) {
    throw new LovableMcpError(`Lovable refused the sign-in code (${oauthMessage(tok.data, `HTTP ${tok.status}`)}). Codes are single-use and short-lived — click Connect Lovable again.`)
  }
  const conn: Connection = {
    clientId: pending.clientId,
    accessToken,
    refreshToken: typeof tok.data.refresh_token === 'string' ? tok.data.refresh_token : null,
    expiresAt: Date.now() + (typeof tok.data.expires_in === 'number' ? tok.data.expires_in : 3600) * 1000,
    scope: typeof tok.data.scope === 'string' ? tok.data.scope : null,
    account: null,
    connectedBy: by,
    connectedAt: new Date().toISOString(),
  }
  await writeSecret(CONNECTION_KEY, conn)
  await deleteSecret(PENDING_KEY)

  // Who did we connect as? Best-effort — the connection stands either way.
  try {
    const me = await lovableMcpCall('get_me', {})
    conn.account = accountFrom(me)
    await writeSecret(CONNECTION_KEY, conn)
  } catch (err) {
    console.warn('[lovable-mcp] connected, but get_me failed:', err)
  }
  return { account: conn.account }
}

export async function disconnectLovable(): Promise<void> {
  const conn = await readSecret<Connection>(CONNECTION_KEY)
  if (conn?.refreshToken) {
    await postForm(OAUTH.revoke, { token: conn.refreshToken, client_id: conn.clientId }).catch(() => undefined)
  }
  await deleteSecret(CONNECTION_KEY)
  await deleteSecret(PENDING_KEY)
}

export type LovableMcpStatus = {
  connected: boolean
  account: string | null
  connectedAt: string | null
  connectedBy: string | null
  /** Why the sign-in stopped working, when it did. */
  broken: string | null
}

export async function lovableMcpStatus(): Promise<LovableMcpStatus> {
  const conn = await readSecret<Connection>(CONNECTION_KEY).catch(() => null)
  return {
    connected: !!conn && !conn.broken,
    account: conn?.account ?? null,
    connectedAt: conn?.connectedAt ?? null,
    connectedBy: conn?.connectedBy ?? null,
    broken: conn?.broken ?? null,
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __lovableRefresh?: Promise<string> | null }

async function accessToken(): Promise<string> {
  const conn = await readSecret<Connection>(CONNECTION_KEY)
  if (!conn) throw new LovableMcpError('Lovable isn’t connected.', true)
  if (conn.broken) throw new LovableMcpError(`The Lovable sign-in stopped working (${conn.broken}). Connect again.`, true)
  if (conn.expiresAt - Date.now() > 60_000) return conn.accessToken
  // One refresh at a time: the refresh token rotates, and two refreshes with
  // the same token would invalidate each other.
  if (!g.__lovableRefresh) {
    g.__lovableRefresh = refresh(conn).finally(() => {
      g.__lovableRefresh = null
    })
  }
  return g.__lovableRefresh
}

async function refresh(conn: Connection): Promise<string> {
  if (!conn.refreshToken) {
    await writeSecret(CONNECTION_KEY, { ...conn, broken: 'Lovable issued no refresh token' })
    throw new LovableMcpError('The Lovable sign-in expired and can’t be renewed. Connect again.', true)
  }
  const tok = await postForm(OAUTH.token, {
    grant_type: 'refresh_token',
    refresh_token: conn.refreshToken,
    client_id: conn.clientId,
    resource: MCP_URL,
  })
  const fresh = typeof tok.data.access_token === 'string' ? tok.data.access_token : null
  if (tok.status >= 400 && tok.status < 500) {
    // Refused outright (revoked, expired, rotated elsewhere): only a new login fixes it.
    const why = oauthMessage(tok.data, `HTTP ${tok.status}`)
    await writeSecret(CONNECTION_KEY, { ...conn, broken: why })
    throw new LovableMcpError(`The Lovable sign-in was refused (${why}). Connect again.`, true)
  }
  if (!fresh) throw new LovableMcpError(`Lovable’s sign-in service didn’t answer (HTTP ${tok.status}). Will try again.`)
  await writeSecret(CONNECTION_KEY, {
    ...conn,
    accessToken: fresh,
    refreshToken: typeof tok.data.refresh_token === 'string' ? tok.data.refresh_token : conn.refreshToken,
    expiresAt: Date.now() + (typeof tok.data.expires_in === 'number' ? tok.data.expires_in : 3600) * 1000,
  } satisfies Connection)
  return fresh
}

// ---------------------------------------------------------------------------
// MCP calls
// ---------------------------------------------------------------------------

type Rpc = { jsonrpc: '2.0'; id?: number; result?: unknown; error?: { code?: number; message?: string } }

/** The JSON-RPC reply with this id, from either a plain JSON body or an SSE stream. */
function pickReply(body: string, contentType: string, id: number): Rpc | null {
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        const msg = JSON.parse(data) as Rpc
        if (msg.id === id) return msg
      } catch {
        /* not JSON — a comment or keep-alive */
      }
    }
    return null
  }
  try {
    const msg = JSON.parse(body) as Rpc | Rpc[]
    return Array.isArray(msg) ? (msg.find((m) => m.id === id) ?? null) : msg
  } catch {
    return null
  }
}

async function rpc(
  token: string,
  session: string | null,
  message: { id?: number; method: string; params?: unknown },
  timeoutMs: number,
): Promise<{ reply: Rpc | null; session: string | null; status: number }> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => '')
  if (res.status === 401) throw new LovableMcpError('Lovable rejected the Hub’s sign-in. Connect again.', true)
  if (res.status === 403) throw new LovableMcpError(`Lovable refused that (403): ${text.slice(0, 200)}`)
  if (res.status >= 400) throw new LovableMcpError(`Lovable’s MCP server answered ${res.status}: ${text.slice(0, 200)}`)
  return {
    reply: message.id === undefined ? null : pickReply(text, res.headers.get('content-type') ?? '', message.id),
    session: res.headers.get('mcp-session-id') ?? session,
    status: res.status,
  }
}

export type McpToolResult = { text: string; structured: Record<string, unknown> | null }

/** Call one Lovable MCP tool: initialize a session, then tools/call. */
export async function lovableMcpCall(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpToolResult> {
  const token = await accessToken()
  const init = await rpc(
    token,
    null,
    { id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'genisys-hub', version: '1.0' } } },
    30_000,
  )
  if (init.reply?.error) throw new LovableMcpError(`Lovable’s MCP server wouldn’t start a session: ${init.reply.error.message ?? 'unknown error'}`)
  // Required by the protocol before any request; servers that keep no session ignore it.
  await rpc(token, init.session, { method: 'notifications/initialized' }, 15_000).catch(() => undefined)

  const call = await rpc(token, init.session, { id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, timeoutMs)
  if (!call.reply) throw new LovableMcpError(`Lovable’s MCP server gave no answer to ${tool}.`)
  if (call.reply.error) throw new LovableMcpError(`${tool} failed: ${call.reply.error.message ?? 'unknown error'}`)
  const result = (call.reply.result ?? {}) as { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim()
  if (result.isError) throw new LovableMcpError(`${tool} failed: ${text.slice(0, 300) || 'Lovable reported an error.'}`)
  let structured: Record<string, unknown> | null =
    result.structuredContent && typeof result.structuredContent === 'object' ? (result.structuredContent as Record<string, unknown>) : null
  if (!structured && text.startsWith('{')) {
    try {
      structured = JSON.parse(text) as Record<string, unknown>
    } catch {
      structured = null
    }
  }
  return { text, structured }
}

function accountFrom(me: McpToolResult): string | null {
  const s = me.structured ?? {}
  const user = (typeof s.user === 'object' && s.user ? s.user : s) as Record<string, unknown>
  for (const k of ['email', 'name', 'username', 'display_name']) {
    if (typeof user[k] === 'string' && user[k]) return user[k] as string
  }
  return me.text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null
}

/** Check the connection end to end; returns who the Hub is signed in as. */
export async function testLovableConnection(): Promise<{ account: string | null }> {
  return { account: accountFrom(await lovableMcpCall('get_me', {}, 30_000)) }
}

/** Publish a project to production — the same as clicking Publish in Lovable. */
export async function lovableMcpDeploy(projectId: string): Promise<{ url: string | null; detail: string }> {
  // Kept under the publish poller's five-minute lease, with room for its live checks.
  const res = await lovableMcpCall('deploy_project', { project_id: projectId }, 150_000)
  const s = res.structured ?? {}
  const url =
    (['url', 'live_url', 'published_url', 'deployment_url'].map((k) => s[k]).find((v) => typeof v === 'string' && v) as string | undefined) ??
    res.text.match(/https?:\/\/[^\s)"']+/)?.[0] ??
    null
  return { url, detail: res.text.slice(0, 300) }
}
