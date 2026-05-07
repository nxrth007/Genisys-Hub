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
  // Client self-registration — anonymous email + password POST that
  // creates a client_pending User. The follow-up onboarding form is
  // signed-in (client_pending), gated normally.
  '/api/client/register',
]

// Routes approved clients are allowed to hit. Anything else bounces
// back to /client. Same shape as AGENT_ALLOWED_PREFIXES below.
const CLIENT_ALLOWED_PREFIXES = [
  '/client',
  '/api/client',
  '/api/auth',
]

// Routes agents are allowed to hit. Anything else bounces back to /agent.
const AGENT_ALLOWED_PREFIXES = [
  '/agent',
  '/api/agent',
  '/api/auth',
  // Read-only client list — the agent booking form needs to populate
  // its client picker (Brighton / Spring / Energy Upgrade). Without
  // this, the picker errored and the form rendered "No clients
  // configured yet. Contact an admin." even though the DB was fine.
  '/api/clients',
  // Mary (sole agent-role user actually booking) needs the Master
  // Tracker view + its inline status / sent-to-client mutations.
  // Both list reads and per-row PATCHes live under this prefix.
  '/api/call-center/master-tracker',
  // Reminders management — Mary needs to see which reminders are
  // pending/failed and cancel or send-now per row. The /api/admin/*
  // template-editing endpoints stay staff-only.
  '/api/call-center/reminders',
  '/api/admin/reminders',
  // Reminder messages — Mary needs to see customer SMS replies and
  // respond inline from the agent view. Limited to the reminder
  // namespace; main /api/crm conversations stay staff-only.
  '/api/crm/reminders',
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

  // Self-registered clients in mid-flow. The signup is a multi-step
  // funnel — register → onboarding form → admin approval — and we
  // pin each role to its dedicated screen so users can't jump ahead.
  //   client_pending     → onboarding form (next step)
  //   client_onboarding  → "we're reviewing" waiting screen
  //   client_denied      → terminal denied screen
  if (role === 'client_pending') {
    const allowed =
      pathname === '/signin/client/onboarding-form' ||
      pathname.startsWith('/api/client/onboarding-form') ||
      // Google Places autocomplete on the business-address field —
      // the prospect needs this while filling out the onboarding
      // form, before they're approved.
      pathname.startsWith('/api/client/maps/places') ||
      pathname.startsWith('/api/auth')
    if (allowed) return NextResponse.next()
    return NextResponse.redirect(
      new URL('/signin/client/onboarding-form', req.nextUrl.origin),
    )
  }
  if (role === 'client_onboarding') {
    // /payment is the post-onboarding step where they get the
    // QuickBooks link for their package. /pending is the terminal
    // waiting screen. /api/client/me is used by /payment to look up
    // which package they picked. Anything else bounces to /pending.
    const allowed =
      pathname === '/signin/client/pending' ||
      pathname === '/signin/client/payment' ||
      pathname.startsWith('/api/client/me') ||
      pathname.startsWith('/api/auth')
    if (allowed) return NextResponse.next()
    return NextResponse.redirect(
      new URL('/signin/client/pending', req.nextUrl.origin),
    )
  }
  if (role === 'client_denied') {
    const allowed =
      pathname === '/signin/client/denied' || pathname.startsWith('/api/auth')
    if (allowed) return NextResponse.next()
    return NextResponse.redirect(
      new URL('/signin/client/denied', req.nextUrl.origin),
    )
  }

  // Approved clients: /client/* only. If they have a pending password
  // change, force them to /client/change-password before anything else.
  if (role === 'client_active') {
    const mustChange = (session.user as { mustChangePassword?: boolean })
      ?.mustChangePassword
    if (mustChange) {
      const allowed =
        pathname === '/client/change-password' ||
        pathname.startsWith('/api/client/change-password') ||
        pathname.startsWith('/api/auth')
      if (!allowed) {
        return NextResponse.redirect(
          new URL('/client/change-password', req.nextUrl.origin),
        )
      }
    }
    if (matchesPrefix(pathname, CLIENT_ALLOWED_PREFIXES)) {
      return NextResponse.next()
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/client', req.nextUrl.origin))
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
