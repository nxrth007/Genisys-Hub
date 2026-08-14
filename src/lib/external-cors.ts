import { NextRequest, NextResponse } from 'next/server'

/**
 * CORS for the external API surface.
 *
 * Lives in its own module because the authenticated endpoints and the
 * public auth endpoints (register / login) both need it, and importing
 * external-api.ts from a public route would drag Prisma and token
 * verification into a path that shouldn't need them.
 *
 * Worth restating: CORS is not the security boundary. The bearer token
 * is, and the auth endpoints have their own rate limits. This only stops
 * casual cross-site calls from unrelated pages.
 */

const ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.app$/,
  /^https:\/\/([a-z0-9-]+\.)*lovableproject\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.dev$/,
  /^https:\/\/([a-z0-9-]+\.)*sandbox\.lovable\.dev$/,
]

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (ORIGIN_PATTERNS.some((re) => re.test(origin))) return true
  const extra = (process.env.EXTERNAL_API_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return extra.includes(origin)
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin)
  return {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    // Must list every method the API actually serves. A missing one fails
    // the browser's preflight before the request is sent, which surfaces
    // as a bare "Failed to fetch" with no status and no server log —
    // PATCH and DELETE were missing, so every write 404'd invisibly.
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/** Attach CORS headers to an already-built response. */
export function withCors(res: NextResponse, origin: string | null): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    res.headers.set(k, v)
  }
  return res
}

/** Shared OPTIONS handler for external routes. */
export function corsPreflight(req: NextRequest): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  })
}
