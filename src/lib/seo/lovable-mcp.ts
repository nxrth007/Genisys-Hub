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
/** Keep the sign-in (offline), act on projects, and read workspaces to list their projects. Nothing that creates. */
const SCOPE = 'offline projects:read projects:write workspaces:read'
/** What the first connections asked for, before the Lovable → GitHub watch needed workspaces. */
const LEGACY_SCOPE = 'offline projects:read projects:write'
/** Permissions the Hub's features need; a sign-in missing one shows "reconnect" rather than failing later. */
export const REQUIRED_SCOPES = ['projects:read', 'projects:write', 'workspaces:read']
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
  /** The scope the Hub asked for at sign-in; absent on connections made before this was recorded. */
  requestedScope?: string
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
    requestedScope: SCOPE,
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
  /** Permissions the Hub needs that this sign-in doesn't carry — a reconnect grants them. */
  missingScopes: string[]
}

/** The permissions a stored connection actually carries. */
function grantedScopes(conn: Connection): string[] {
  const s = conn.scope?.trim() || conn.requestedScope?.trim() || LEGACY_SCOPE
  return s.split(/\s+/)
}

export async function lovableMcpStatus(): Promise<LovableMcpStatus> {
  const conn = await readSecret<Connection>(CONNECTION_KEY).catch(() => null)
  const granted = conn ? grantedScopes(conn) : []
  return {
    connected: !!conn && !conn.broken,
    account: conn?.account ?? null,
    connectedAt: conn?.connectedAt ?? null,
    connectedBy: conn?.connectedBy ?? null,
    broken: conn?.broken ?? null,
    missingScopes: conn ? REQUIRED_SCOPES.filter((s) => !granted.includes(s)) : [],
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

/** Lovable's "scope X is required" answers tell people to fix it in ChatGPT; say what to do in the Hub instead. */
function scopeHint(text: string): string | null {
  const m = /scope '([^']+)' is required/i.exec(text)
  if (!m) return null
  return `The Hub\u2019s Lovable sign-in was made before it asked for "${m[1]}" access. Reconnect Lovable on the SEO page (Setup card \u2192 Reconnect), signing in with the same Genisys account \u2014 publishing keeps working meanwhile.`
}

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
  if (call.reply.error) {
    const hint = scopeHint(call.reply.error.message ?? '')
    throw new LovableMcpError(hint ?? `${tool} failed: ${call.reply.error.message ?? 'unknown error'}`)
  }
  const result = (call.reply.result ?? {}) as { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim()
  if (result.isError) throw new LovableMcpError(scopeHint(text) ?? `${tool} failed: ${text.slice(0, 300) || 'Lovable reported an error.'}`)
  let structured: Record<string, unknown> | null =
    result.structuredContent && typeof result.structuredContent === 'object' ? (result.structuredContent as Record<string, unknown>) : null
  if (!structured) {
    // Lovable's tools answer with a JSON text block (get_project adds a screenshot block before it).
    for (const c of result.content ?? []) {
      if (c.type !== 'text' || typeof c.text !== 'string' || !c.text.trimStart().startsWith('{')) continue
      try {
        structured = JSON.parse(c.text) as Record<string, unknown>
        break
      } catch {
        /* not this block */
      }
    }
  }
  return { text, structured }
}

/**
 * Lovable's own preview of a project's latest build, for an iframe on one
 * exact https origin, valid an hour, with no Lovable login: the documented
 * POST /v1/projects/{id}/embed-url. Lovable's /v1 API accepts the Hub's MCP
 * sign-in (checked 2026-11-14). It shows the site only: Lovable's builder
 * can't be shown inside another site at all (X-Frame-Options: DENY).
 */
export async function lovableEmbedUrl(projectId: string, parentOrigin: string): Promise<{ url: string; expiresAt: string | null }> {
  const token = await accessToken()
  const res = await fetch(`https://api.lovable.dev/v1/projects/${encodeURIComponent(projectId)}/embed-url`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Lovable-Version': '2026-09-11' },
    body: JSON.stringify({ parent_origin: parentOrigin }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const why = (typeof data.detail === 'string' && data.detail) || (typeof data.title === 'string' && data.title) || `HTTP ${res.status}`
    if (res.status === 402 || data.type === 'payment_required') throw new LovableMcpError(`Lovable shows its preview inside other sites only on a Business plan (${why}).`)
    throw new LovableMcpError(`Lovable wouldn’t make a preview (${why}).`)
  }
  const url = typeof data.embed_url === 'string' ? data.embed_url : null
  if (!url) throw new LovableMcpError('Lovable gave no preview address.')
  return { url, expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null }
}

/**
 * Whether a project is published, and its public id ("lovp_…"), from the documented
 * GET /v1/projects/{id} with the Hub's sign-in. The public id is in the project's
 * screenshot address, and Lovable puts the same id in a published page's preview image:
 * how the Hub tells that a domain shows this very project (src/lib/hl/site-request.ts).
 */
export async function lovableProjectPublic(projectId: string): Promise<{ isPublished: boolean | null; publicId: string | null; screenshotUrl: string | null }> {
  const token = await accessToken()
  const res = await fetch(`https://api.lovable.dev/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Lovable-Version': '2026-09-11' },
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const why = (typeof data.detail === 'string' && data.detail) || (typeof data.title === 'string' && data.title) || `HTTP ${res.status}`
    throw new LovableMcpError(`Lovable wouldn’t say whether the project is published (${why}).`)
  }
  const shot = typeof data.latest_screenshot_url === 'string' ? data.latest_screenshot_url : ''
  return {
    isPublished: typeof data.is_published === 'boolean' ? data.is_published : null,
    publicId: /lovp_[a-z0-9]{8,}/i.exec(shot)?.[0] ?? null,
    // A picture of the latest build, public (Hell-level → Sites → Websites shows it).
    screenshotUrl: /^https:\/\//i.test(shot) ? shot : null,
  }
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

export type LovableMcpProject = {
  name: string | null
  latestCommitSha: string | null
  lastEditedAt: string | null
  isPublished: boolean | null
}

/**
 * A project's details through the sign-in. Null when Lovable says there is
 * no such project — which is also its answer for a project the signed-in
 * account can't see.
 */
export async function lovableMcpGetProject(projectId: string): Promise<LovableMcpProject | null> {
  let res: McpToolResult
  try {
    res = await lovableMcpCall('get_project', { project_id: projectId }, 30_000)
  } catch (err) {
    if (err instanceof LovableMcpError && !err.reconnect && /not[_ ]found|\b404\b/i.test(err.message)) return null
    throw err
  }
  const s = res.structured ?? {}
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    name: str(s.name),
    latestCommitSha: str(s.latest_commit_sha),
    lastEditedAt: str(s.last_edited_at),
    isPublished: typeof s.is_published === 'boolean' ? s.is_published : null,
  }
}

// ---------------------------------------------------------------------------
// Building a site (src/lib/hl/site-request.ts): copy a template project, send
// the copy a prompt, and watch the agent until it's done. Remixing is free;
// a message to the agent uses the workspace's Lovable credits.
// ---------------------------------------------------------------------------

const strOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const recOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export type LovableProjectRef = { id: string; name: string | null; workspaceId: string | null; editorUrl: string | null; previewUrl: string | null; createdAt: string | null }

function projectRef(v: unknown): LovableProjectRef | null {
  const p = recOf(v)
  const id = p && (strOf(p.id) ?? strOf(p.project_id))
  if (!p || !id) return null
  return {
    id,
    name: strOf(p.name) ?? strOf(p.display_name),
    workspaceId: strOf(p.workspace_id),
    editorUrl: strOf(p.editor_url) ?? `https://lovable.dev/projects/${id}`,
    previewUrl: strOf(p.preview_url),
    createdAt: strOf(p.created_at),
  }
}

/** A project's workspace and addresses (null when the sign-in can't see it). */
export async function lovableMcpProjectRef(projectId: string): Promise<LovableProjectRef | null> {
  let res: McpToolResult
  try {
    res = await lovableMcpCall('get_project', { project_id: projectId }, 30_000)
  } catch (err) {
    if (err instanceof LovableMcpError && !err.reconnect && /not[_ ]found|\b404\b/i.test(err.message)) return null
    throw err
  }
  const s = res.structured ?? {}
  // The details (name, workspace_id, editor_url) are top level; the nested `project` is only its build status.
  return projectRef({ ...(recOf(s.project) ?? {}), ...s })
}

/** Projects in a workspace whose name matches `query` (Lovable's fuzzy search), newest first as Lovable lists them. */
export async function lovableMcpFindProjects(workspaceId: string, query: string): Promise<LovableProjectRef[]> {
  const res = await lovableMcpCall('list_projects', { workspace_id: workspaceId, query, limit: 50 }, 60_000)
  const s = res.structured ?? {}
  const list = Array.isArray(s.projects) ? s.projects : Array.isArray(s.data) ? s.data : []
  return list.map(projectRef).filter((p): p is LovableProjectRef => !!p)
}

export type LovableRemix = { project: LovableProjectRef | null; status: string; error: string | null }

/**
 * Copy a project into a workspace and wait for the copy (up to
 * `timeoutSeconds`). Lovable says not to retry a remix that timed out: the
 * copy may still appear, so callers look for it by name instead.
 */
export async function lovableMcpRemix(o: { projectId: string; workspaceId: string; name: string; timeoutSeconds: number }): Promise<LovableRemix> {
  const res = await lovableMcpCall(
    'remix_project',
    { project_id: o.projectId, workspace_id: o.workspaceId, project_name: o.name, include_history: false, include_custom_knowledge: false, timeout_seconds: o.timeoutSeconds },
    (o.timeoutSeconds + 60) * 1000,
  )
  const s = res.structured ?? {}
  const status = strOf(s.remix_status) ?? strOf(s.status) ?? 'unknown'
  const flat = (id: string | null) => (id ? projectRef({ id, name: o.name, editor_url: s.editor_url, preview_url: s.preview_url, workspace_id: o.workspaceId }) : null)
  // A link to a project anywhere in the answer ("…lovable.dev/projects/<id>", or a preview address).
  const linked = [...res.text.matchAll(/lovable\.dev\/projects\/([0-9a-f-]{36})|id-preview--([0-9a-f-]{36})/gi)].map((m) => flat(m[1] ?? m[2]))
  // The answer may echo the source project's id too: the copy is whichever project isn't the source.
  const project =
    [projectRef(s.project), projectRef(s.new_project), flat(strOf(s.new_project_id)), flat(strOf(s.project_id)), projectRef(recOf(s.result)), ...linked].find((p) => !!p && p.id !== o.projectId) ??
    null
  if (status === 'completed' && !project) console.warn(`[lovable-mcp] remix completed but no new project id in the answer (keys: ${Object.keys(s).join(', ')})`)
  return { project: status === 'completed' ? project : null, status, error: strOf(s.error) ?? strOf(s.message) ?? (status === 'completed' ? null : res.text.slice(0, 300) || null) }
}

/** Send the project's agent a message without waiting; the agent works on it in the background. */
export async function lovableMcpSend(projectId: string, message: string): Promise<{ messageId: string; threadId: string | null; status: string | null }> {
  const res = await lovableMcpCall('send_message', { project_id: projectId, message, wait: false }, 90_000)
  const s = res.structured ?? {}
  const messageId = strOf(s.message_id) ?? strOf(recOf(s.message)?.message_id)
  if (!messageId) throw new LovableMcpError(`Lovable took the message but gave no message id (${res.text.slice(0, 200) || 'empty answer'}).`)
  return { messageId, threadId: strOf(s.thread_id), status: strOf(s.status) }
}

/** The project's latest messages (newest first), to find one sent before a restart. */
export async function lovableMcpRecentMessages(projectId: string, limit = 5): Promise<{ id: string; role: string | null; content: string; createdAt: string | null; status: string | null }[]> {
  const res = await lovableMcpCall('list_messages', { project_id: projectId, limit }, 60_000)
  const s = res.structured ?? {}
  const list = Array.isArray(s.messages) ? s.messages : Array.isArray(s.data) ? s.data : []
  return list.flatMap((m) => {
    const r = recOf(m)
    const id = r && strOf(r.message_id)
    return r && id ? [{ id, role: strOf(r.role), content: typeof r.content === 'string' ? r.content : '', createdAt: strOf(r.created_at), status: strOf(r.status) }] : []
  })
}

/**
 * Every line in the project's files holding `query` (literal text, any case), as Lovable's
 * grep_files finds it: { data: [{ path, matches: [{ line, line_content }] }], truncated }.
 * An answer in another shape throws rather than reading as "no matches".
 */
export async function lovableMcpGrep(projectId: string, query: string, limit = 200): Promise<{ hits: { path: string; line: number; text: string }[]; truncated: boolean }> {
  const res = await lovableMcpCall('grep_files', { project_id: projectId, query, limit }, 60_000)
  const s = res.structured
  if (!s || !Array.isArray(s.data)) throw new LovableMcpError(`Lovable’s code search answered in a shape the Hub can’t read (${res.text.slice(0, 200) || 'empty answer'}).`)
  const hits = s.data.flatMap((f) => {
    const r = recOf(f)
    const path = r && strOf(r.path)
    const matches = r && Array.isArray(r.matches) ? r.matches : []
    return path
      ? matches.map((m) => {
          const x = recOf(m)
          return { path, line: typeof x?.line === 'number' ? x.line : 0, text: typeof x?.line_content === 'string' ? x.line_content.slice(0, 300) : '' }
        })
      : []
  })
  return { hits, truncated: s.truncated === true }
}

/**
 * Answer a pause the agent is on: a tool approval, or its questions
 * (`userInput` holds the answers for awaiting_input.input_schema). Lovable's
 * rule is that a person decides: callers pass a person's answer, or one the
 * brief the person approved already gives (src/lib/hl/site-pause.ts).
 * Doesn't wait for the resumed turn.
 */
export async function lovableMcpRespond(o: {
  projectId: string
  messageId: string
  threadId: string | null
  eventId: string
  decision: 'approved' | 'rejected'
  userInput?: Record<string, unknown> | string
}): Promise<{ status: string | null; alreadyAnswered: boolean; text: string }> {
  const res = await lovableMcpCall(
    'respond_to_approval',
    {
      project_id: o.projectId,
      message_id: o.messageId,
      event_id: o.eventId,
      decision: o.decision,
      ...(o.threadId ? { thread_id: o.threadId } : {}),
      ...(o.userInput !== undefined ? { user_input: o.userInput } : {}),
      wait: false,
    },
    90_000,
  )
  const s = res.structured ?? {}
  return { status: strOf(s.status), alreadyAnswered: s.already_answered === true, text: res.text.slice(0, 500) }
}

export type LovableAgentState = {
  /** working: still on it. done: finished. stopped / error: ended without finishing. waiting: paused for a person in Lovable's editor. */
  state: 'working' | 'done' | 'stopped' | 'error' | 'waiting'
  /** Lovable's own words: the agent's summary when done, or why it stopped or waits. */
  note: string | null
  credits: number | null
  previewUrl: string | null
  /** The agent's reply, as written (when there is one). */
  reply?: string | null
  /**
   * What it paused on: a tool it wants approved (eventId, the tool and its
   * params, Lovable's proposal) or questions for a person (input_schema).
   */
  awaiting?: { eventId: string | null; toolId: string | null; params: unknown; asks: boolean } | null
  /** Lovable's awaiting_input object as it sent it (src/lib/hl/site-pause.ts reads the questions from it). */
  awaitingRaw?: Record<string, unknown> | null
  /**
   * The message hasn't started: it's queued. `paused` with reason "hitl_tool"
   * means an earlier turn in the project is paused for a person and this one
   * runs once that's answered (Cnc transportation, 2026-11-14: Lovable's own
   * message after a copy had stopped on a question).
   */
  queue?: { paused: boolean; reason: string | null } | null
}

/** Where the agent is with a message sent by lovableMcpSend. */
export async function lovableMcpAgentState(projectId: string, messageId: string, threadId: string | null): Promise<LovableAgentState> {
  const res = await lovableMcpCall('get_message', { project_id: projectId, message_id: messageId, ...(threadId ? { thread_id: threadId } : {}), wait_seconds: 0 }, 60_000)
  const s = res.structured ?? {}
  const r = recOf(s.response)
  const top = strOf(s.status)
  const agent = strOf(r?.status)
  const awaiting = recOf(r?.awaiting_input) ?? recOf(s.awaiting_input)
  const why = (x: Record<string, unknown> | null) => (x ? (strOf(x.summary) ?? strOf(x.error) ?? strOf(x.completion_reason) ?? strOf(x.message)) : null)
  const credits = typeof r?.cost_credits === 'number' ? r.cost_credits : null
  const previewUrl = strOf(s.preview_url)
  const reply = typeof r?.content === 'string' ? r.content : null
  if (agent === 'completed') return { state: 'done', note: why(r), credits, previewUrl, reply }
  if (agent === 'awaiting_input' || top === 'awaiting_input' || awaiting) {
    const tool = awaiting ? (strOf(awaiting.tool_id) ?? strOf(awaiting.tool_name)) : null
    return {
      state: 'waiting',
      note: tool ? `Lovable wants a person to approve “${tool}”.` : (why(r) ?? 'Lovable paused for a person (a check-in in its editor).'),
      credits,
      previewUrl,
      reply,
      awaiting: awaiting ? { eventId: strOf(awaiting.event_id), toolId: tool, params: awaiting.params ?? null, asks: !!awaiting.input_schema } : null,
      awaitingRaw: awaiting,
    }
  }
  if (agent === 'stopped' || top === 'stopped') return { state: 'stopped', note: why(r) ?? strOf(s.error), credits, previewUrl }
  if (agent === 'error' || top === 'error') return { state: 'error', note: why(r) ?? strOf(s.error) ?? res.text.slice(0, 300), credits, previewUrl }
  const paused = s.queue_paused === true || s.queue_paused === 'true'
  const queue = top === 'queued' ? { paused, reason: strOf(s.queue_pause_reason) } : null
  return { state: 'working', note: null, credits, previewUrl, queue }
}

/**
 * Publish a project to production — the same as clicking Publish in Lovable.
 * `name` asks for that lovable.app address on a first publish (Lovable picks
 * one without it). Lovable answers "pending" with the intended address:
 * that it loads is the proof it's live.
 */
export async function lovableMcpDeploy(projectId: string, name?: string): Promise<{ url: string | null; detail: string }> {
  // Kept under the publish poller's five-minute lease, with room for its live checks.
  const res = await lovableMcpCall('deploy_project', { project_id: projectId, ...(name ? { name } : {}) }, 150_000)
  const s = res.structured ?? {}
  const url =
    (['url', 'live_url', 'published_url', 'deployment_url'].map((k) => s[k]).find((v) => typeof v === 'string' && v) as string | undefined) ??
    res.text.match(/https?:\/\/[^\s)"']+/)?.[0] ??
    null
  return { url, detail: res.text.slice(0, 300) }
}
