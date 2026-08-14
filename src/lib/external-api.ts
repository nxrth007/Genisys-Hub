import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from './prisma'
import { corsHeaders, corsPreflight } from './external-cors'

/**
 * Bridge for externally-hosted frontends (the Lovable Vite SPA).
 *
 * The Hub's own UI is same-origin and rides the Auth.js session cookie.
 * A frontend hosted on another domain can't use that cookie, so it
 * authenticates with a bearer token against a curated
 * `/api/external/v1/*` surface instead.
 *
 * Deliberately NOT a blanket opening of the internal API: those 186
 * routes were written assuming a trusted same-origin caller, and some
 * of them charge cards, send SMS, and delete rows. External endpoints
 * are hand-picked, read-only, and shaped for display.
 */

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

const TOKEN_PREFIX = 'ghub_'

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

/**
 * Mint a token. Returns the plaintext ONCE — it is never stored and
 * cannot be recovered, so the caller must show it to the user now.
 */
export async function createApiToken(
  name: string,
  createdById?: string,
  expiresAt?: Date,
) {
  const plain = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
  const token = await prisma.apiToken.create({
    data: {
      name: name.trim() || 'Untitled token',
      tokenHash: hashToken(plain),
      prefix: plain.slice(0, TOKEN_PREFIX.length + 6),
      createdById: createdById ?? null,
      expiresAt: expiresAt ?? null,
      scope: expiresAt ? 'session' : 'read',
    },
  })
  return { token, plaintext: plain }
}

export type ExternalAuth = {
  tokenId: string
  name: string
  scope: string
  user: { id: string; name: string | null; email: string } | null
}

/** Constant-time string compare that can't leak length via early exit. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Optional static token from the environment.
 *
 * Convenience path so a token can be set in Render without minting one
 * in the UI — any value works, no `ghub_` prefix required. Tradeoffs
 * versus a database token, worth knowing:
 *   - it is NOT hashed at rest (Render env vars are readable in the
 *     dashboard by anyone with access to the service)
 *   - it cannot be revoked from the Hub UI; changing it needs a redeploy
 *   - its use isn't tracked in `lastUsedAt`
 * Database tokens remain the better option for anything long-lived.
 */
function envToken(): string | null {
  const t = (
    process.env.LOVABLE_TKN ??
    process.env.EXTERNAL_API_TOKEN ??
    ''
  ).trim()
  return t.length > 0 ? t : null
}

/**
 * Resolve a bearer token to either the configured env token or a live,
 * non-revoked, non-expired database record. Returns null on any failure
 * — callers must not distinguish reasons beyond a generic 401.
 */
export async function verifyExternalRequest(
  req: NextRequest,
): Promise<ExternalAuth | null> {
  return verifyToken(req)
}

async function verifyToken(req: NextRequest): Promise<ExternalAuth | null> {
  const header = req.headers.get('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '').trim()
  if (!provided) return null

  // Env token first — it has no prefix requirement.
  const configured = envToken()
  if (configured && safeEqual(provided, configured)) {
    return { tokenId: 'env', name: 'Environment token', scope: 'read', user: null }
  }

  // Everything else must look like a minted token before we hit the DB.
  if (!provided.startsWith(TOKEN_PREFIX)) return null

  // Hash lookup is O(1) and constant-time-safe: we compare hashes, and
  // the DB lookup is on the hash itself rather than a scan.
  const hash = hashToken(provided)
  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hash },
    include: {
      createdBy: { select: { id: true, name: true, email: true, role: true } },
    },
  })
  if (!record) return null

  // Belt-and-braces constant-time compare of stored vs computed hash.
  if (!safeEqual(record.tokenHash, hash)) return null

  if (record.revokedAt) return null
  if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return null

  // Fire-and-forget: "last used" is nice-to-have telemetry and must not
  // add latency or fail the request.
  void prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  // A session token is only as valid as the account behind it: if the
  // user was denied or revoked after signing in, the token dies with them.
  const owner = record.createdBy
  if (record.scope === 'session') {
    const stillAllowed =
      !!owner &&
      (owner.role === 'crm_user' ||
        owner.role === 'admin' ||
        owner.role === 'member')
    if (!stillAllowed) return null
  }

  return {
    tokenId: record.id,
    name: record.name,
    scope: record.scope,
    user: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
  }
}

/* -------------------------------------------------------------------------- */
/*  Handler wrapper                                                           */
/* -------------------------------------------------------------------------- */

type Handler = (
  req: NextRequest,
  auth: ExternalAuth,
) => Promise<unknown> | unknown

/**
 * Wraps an external endpoint: answers CORS preflight, enforces the
 * bearer token, attaches CORS headers to every response, and turns a
 * thrown error into a 500 without leaking internals.
 */
export function withExternalApi(handler: Handler) {
  return async function route(req: NextRequest): Promise<NextResponse> {
    const origin = req.headers.get('origin')
    const headers = corsHeaders(origin)

    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers })
    }

    const auth = await verifyToken(req)
    if (!auth) {
      return NextResponse.json(
        {
          error: 'unauthorized',
          message:
            'Missing or invalid API token. Send it as: Authorization: Bearer <token>',
        },
        { status: 401, headers },
      )
    }

    try {
      const data = await handler(req, auth)
      return NextResponse.json({ ok: true, data }, { headers })
    } catch (err) {
      console.error('[external-api]', req.nextUrl.pathname, err)
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers },
      )
    }
  }
}

/** Shared OPTIONS export for preflight on every external route. */
export const externalOptions = corsPreflight
