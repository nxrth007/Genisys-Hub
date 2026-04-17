/**
 * Global auth + role-based routing middleware.
 *
 * Forces sign-in for every page and every /api/* route, with a small
 * whitelist for auth endpoints themselves and the health check.
 *
 * Role-based routing:
 * - role=agent: restricted to /agent/* and a tiny set of shared routes.
 *   Any other route bounces to /agent.
 * - role=agent_pending or agent_denied: bounced to /signin/agent/pending or
 *   /signin/agent/denied respectively. No authenticated access anywhere.
 * - role=member or admin: full Hub access. /agent/* still loads (staff can
 *   preview the agent UI for QA) but all non-admin routes under /admin/* are
 *   blocked for non-admins.
 *
 * Any unauthenticated request to a protected path is redirected (for pages)
 * or returns 401 JSON (for API routes).
 */
import { NextResponse } from 'next/server'
import { auth } from '@/auth'

const PUBLIC_PATHS = [
  '/signin',
  '/api/auth', // NextAuth's own routes
  '/api/health',
  // Agent registration endpoint needs to be reachable anonymously.
  '/api/agent/register',
]

// Routes agents are allowed to hit. Anything else bounces back to /agent.
const AGENT_ALLOWED_PREFIXES = [
  '/agent',
  '/api/agent',
  '/api/auth',
]

// Admin-only areas — even "member" staff can't access these.
const ADMIN_ONLY_PREFIXES = [
  '/admin',
  '/api/admin',
  // /agents is the admin agent-management section in the main Hub sidebar.
  // /agent (singular) is the agent-facing portal and is gated separately above.
  '/agents',
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (isPublic(pathname)) return NextResponse.next()

  const session = req.auth
  if (!session) {
    // API requests → 401 JSON so the client can show a clean error.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    // Pages → redirect to signin, preserving where the user was trying to go.
    const signInUrl = new URL('/signin', req.nextUrl.origin)
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.href)
    return NextResponse.redirect(signInUrl)
  }

  const role = (session.user as { role?: string } | undefined)?.role || 'member'

  // Pending/denied agents shouldn't be able to reach anything authenticated —
  // we block them up front and direct them to the appropriate screen.
  if (role === 'agent_pending') {
    if (pathname === '/signin/agent/pending') return NextResponse.next()
    return NextResponse.redirect(new URL('/signin/agent/pending', req.nextUrl.origin))
  }
  if (role === 'agent_denied') {
    if (pathname === '/signin/agent/denied') return NextResponse.next()
    return NextResponse.redirect(new URL('/signin/agent/denied', req.nextUrl.origin))
  }

  // Approved agents: /agent/* only (plus NextAuth endpoints).
  if (role === 'agent') {
    if (matchesPrefix(pathname, AGENT_ALLOWED_PREFIXES)) return NextResponse.next()
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/agent', req.nextUrl.origin))
  }

  // Admin-only gating for staff
  if (matchesPrefix(pathname, ADMIN_ONLY_PREFIXES) && role !== 'admin') {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/', req.nextUrl.origin))
  }

  return NextResponse.next()
})

export const config = {
  // Auth.js's PrismaAdapter transitively uses Node builtins (node:path, etc.)
  // that aren't available in the Edge runtime, so we explicitly run middleware
  // on the Node runtime. Slightly heavier cold start, but correct.
  runtime: 'nodejs',
  // Skip static assets and Next.js internals.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp)).*)'],
}
