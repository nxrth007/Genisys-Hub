import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from './prisma'

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
export async function createApiToken(name: string, createdById?: string) {
  const plain = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
  const token = await prisma.apiToken.create({
    data: {
      name: name.trim() || 'Untitled token',
      tokenHash: hashToken(plain),
      prefix: plain.slice(0, TOKEN_PREFIX.length + 6),
      createdById: createdById ?? null,
    },
  })
  return { token, plaintext: plain }
}

export type ExternalAuth = { tokenId: string; name: string; scope: string }

/**
 * Resolve a bearer token to a live, non-revoked, non-expired record.
 * Returns null on any failure — callers must not distinguish reasons to
 * the client beyond a generic 401.
 */
async function verifyToken(req: NextRequest): Promise<ExternalAuth | null> {
  const header = req.headers.get('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '').trim()
  if (!provided || !provided.startsWith(TOKEN_PREFIX)) return null

  // Hash lookup is O(1) and constant-time-safe: we compare hashes, and
  // the DB lookup is on the hash itself rather than a scan.
  const hash = hashToken(provided)
  const record = await prisma.apiToken.findUnique({ where: { tokenHash: hash } })
  if (!record) return null

  // Belt-and-braces constant-time compare of the stored vs computed hash.
  const a = Buffer.from(record.tokenHash)
  const b = Buffer.from(hash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  if (record.revokedAt) return null
  if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return null

  // Fire-and-forget: "last used" is nice-to-have telemetry and must not
  // add latency or fail the request.
  void prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return { tokenId: record.id, name: record.name, scope: record.scope }
}

/* -------------------------------------------------------------------------- */
/*  CORS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Origins allowed to call the external API from a browser.
 *
 * Lovable gives each project a generated subdomain and previews from a
 * few different hosts, so this matches by pattern rather than exact
 * string. Extra origins can be added via EXTERNAL_API_ORIGINS
 * (comma-separated) without a deploy.
 *
 * Worth being clear: CORS is not the security boundary here — the
 * bearer token is. This just stops casual cross-site calls from
 * unrelated pages.
 */
const ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.app$/,
  /^https:\/\/([a-z0-9-]+\.)*lovableproject\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.dev$/,
  /^https:\/\/([a-z0-9-]+\.)*sandbox\.lovable\.dev$/,
]

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (ORIGIN_PATTERNS.some((re) => re.test(origin))) return true
  const extra = (process.env.EXTERNAL_API_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return extra.includes(origin)
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin)
  return {
    // Echo the specific origin rather than "*" so the header stays
    // accurate if we ever add credentialed requests.
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
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
            'Missing or invalid API token. Send it as: Authorization: Bearer ghub_…',
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
export function externalOptions(req: NextRequest): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  })
}
