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
 * - role=hl_user: a contractor on their own Hell-level sub-account
 *   (src/lib/hl/member-access.ts): /hell-level's day-to-day screens and the
 *   /api/hl routes that let them in (hlAccountGuard), nothing else.
 * - role=member or admin: full Hub access. /agent/* still loads (staff can
 *   preview the agent UI for QA) but all non-admin routes under /admin/* are
 *   blocked for non-admins.
 *
 * Any unauthenticated request to a protected path is redirected (for pages)
 * or returns 401 JSON (for API routes).
 */
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { HL_MEMBER_ROLE, memberPagePath } from '@/lib/hl/member-access'

const PUBLIC_PATHS = [
  '/signin',
  // Contractors' sign-in (Hell-level sub-account logins), its "choose your
  // password" page, and their forgot/set-password posts under /api/hl/public.
  '/login',
  '/api/auth', // NextAuth's own routes
  '/api/health',
  // Agent registration endpoint needs to be reachable anonymously.
  '/api/agent/register',
  // Client self-registration — anonymous email + password POST that
  // creates a client_pending User. The follow-up onboarding form is
  // signed-in (client_pending), gated normally.
  '/api/client/register',
  // Team #N self-registration — anonymous POST that creates a
  // team_pending User (Mary's offshore agents, EOD-only access).
  '/api/team/register',
  // Forgot/reset password endpoints — both reachable anonymously
  // because the user can't sign in (that's why they're resetting).
  // Rate-limited per IP inside each handler. Agent + client + team
  // parallel tracks — staff use Google OAuth and don't have password
  // resets.
  '/api/client/forgot-password',
  '/api/client/reset-password',
  '/api/agent/forgot-password',
  '/api/agent/reset-password',
  '/api/team/forgot-password',
  '/api/team/reset-password',
  // Public recording proxy — Slack/email recipients on client
  // channels click signed URLs to play call recordings, they don't
  // have Hub accounts. Security is HMAC signature + host allowlist +
  // per-IP rate limit, all enforced inside the route. Don't gate
  // here.
  '/api/recordings/proxy',
  // Retired NCT Media lead webhook — answers 410 Gone so NCT's sender
  // gets a clear "stop" instead of a login redirect.
  '/api/webhooks/nct-leads',
  // A client's Google Business Profile setup page and its "done" post: no Hub
  // account; the secret token in the URL is the access (src/lib/gbp-setup.ts).
  '/gbp-setup',
  '/api/public/gbp',
  // Address suggestions for the client onboarding form's Business Address box:
  // its visitors have no Hub login; the route answers only the form's origins
  // and rate-limits itself (src/app/api/public/address/route.ts).
  '/api/public/address',
  // Client onboarding intake form posts here with a shared secret.
  '/api/webhooks/client-onboarding',
  // Whop membership webhooks; the route verifies Whop's signature itself.
  '/api/webhooks/whop',
  // Client sub-account workflows post form / chat leads here (?secret=).
  '/api/webhooks/ghl-lead',
  // Hell-level (src/lib/hl): what the public and Twilio reach. /hl serves the
  // forms, chat widget and legal pages embedded on client websites; the
  // Twilio webhooks check Twilio's signature themselves; form posts are
  // rate-limited per IP. The staff app is /hell-level and /api/hl/*, gated.
  '/hl',
  '/api/hl/twilio',
  '/api/hl/public',
  // External API for separately-hosted frontends (the Lovable Vite SPA).
  // Those callers are on another domain and have no session cookie, so
  // middleware would 401 them before the handler runs. Every route under
  // here is wrapped in withExternalApi(), which enforces a bearer token
  // and CORS itself — and the surface is curated + read-only, not the
  // internal API. Don't gate here.
  '/api/external',
]

// Routes approved clients are allowed to hit. Anything else bounces
// back to /client. Same shape as AGENT_ALLOWED_PREFIXES below.
const CLIENT_ALLOWED_PREFIXES = [
  '/client',
  '/api/client',
  '/api/auth',
]

// Routes Team #N members are allowed to hit. Everything else bounces
// back to /team. Intentionally tight — Team #1 agents must never reach
// the master tracker, the booking surface, the client list, or any
// data from other teams.
const TEAM_ALLOWED_PREFIXES = [
  '/team',
  '/api/team',
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
  // Team manager surface (Mary). Approves Team #1 registrations +
  // assigns initial call-center numbers without admin acting as
  // a bottleneck. The endpoints themselves enforce
  // User.managesTeamNumber === <requested team> — this prefix
  // allowlist is only the coarse "agents can reach this URL" gate.
  '/team/manage',
  '/api/team/manage',
]

// Routes a Hell-level sub-account login may hit. Every /api/hl handler checks
// for itself (hlGuard: Genisys only; hlAccountGuard: their own sub-account).
const HL_MEMBER_ALLOWED_PREFIXES = [
  '/hell-level',
  '/api/hl',
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
  // Hell-level's Google Calendar connections come back through the Hub's one
  // registered Google return address, and a team member connecting from the
  // link they were sent has no Hub account: the signed state is the access
  // there (src/lib/hl/google-calendar.ts). Every other use stays gated.
  if (pathname === '/api/drive/callback' && req.nextUrl.searchParams.get('state')?.startsWith('hl-cal.')) return NextResponse.next()
  // Google Search Console's ownership files (public/google<16 hex>.html): Google fetches them signed out.
  // Only files committed there exist, so nobody else can verify the Hub as theirs.
  if (/^\/google[0-9a-f]{16}\.html$/.test(pathname)) return NextResponse.next()

  const session = req.auth
  if (!session) {
    // API requests → 401 JSON so the client can show a clean error.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    // Pages → redirect to signin, preserving where the user was trying to go.
    // Hell-level goes to /login, where contractors sign in (Genisys has the
    // Google button there too).
    const signInUrl = new URL(matchesPrefix(pathname, ['/hell-level']) ? '/login' : '/signin', req.nextUrl.origin)
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

  // Mary's Team #N agents — pending/denied bounce to their own screens.
  // Approved team members can ONLY reach /team/* and /api/team/* — no
  // master tracker, no clients, no booking, no other-team data. The
  // tight prefix list above + the page bounce below enforce this.
  if (role === 'team_pending') {
    if (pathname === '/signin/team/pending') return NextResponse.next()
    return NextResponse.redirect(new URL('/signin/team/pending', req.nextUrl.origin))
  }
  if (role === 'team_denied') {
    if (pathname === '/signin/team/denied') return NextResponse.next()
    return NextResponse.redirect(new URL('/signin/team/denied', req.nextUrl.origin))
  }
  if (role === 'team_member') {
    if (matchesPrefix(pathname, TEAM_ALLOWED_PREFIXES)) return NextResponse.next()
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/team', req.nextUrl.origin))
  }

  // Hell-level sub-account logins: their sub-account's day-to-day screens.
  if (role === HL_MEMBER_ROLE) {
    if (matchesPrefix(pathname, HL_MEMBER_ALLOWED_PREFIXES)) {
      if (pathname.startsWith('/api/')) return NextResponse.next()
      const page = memberPagePath(pathname, req.nextUrl.searchParams.get('tab'))
      if (page.ok) return NextResponse.next()
      return NextResponse.redirect(new URL(page.to, req.nextUrl.origin))
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/hell-level', req.nextUrl.origin))
  }

  // Approved agents: /agent/* only (plus NextAuth endpoints).
  if (role === 'agent') {
    if (matchesPrefix(pathname, AGENT_ALLOWED_PREFIXES)) return NextResponse.next()
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/agent', req.nextUrl.origin))
  }

  // Self-registered clients in mid-flow. As of 2026-05-11 the flow
  // is: register → /client (pre-pay welcome + plan picker) → admin
  // approves → /client (onboarding form embedded) → /client (live
  // tracker). One destination, content adapts to role — feels like
  // the user is "in" the product instead of navigating a funnel.
  //   client_pending     → /client renders pre-pay welcome + plan picker
  //   client_onboarding  → /client renders the onboarding form
  //   client_denied      → terminal denied screen
  if (role === 'client_pending' || role === 'client_onboarding') {
    const allowed =
      pathname === '/client' ||
      pathname.startsWith('/api/client/') ||
      pathname.startsWith('/api/auth') ||
      // Legacy redirects — kept alive so any bookmarks from the old
      // funnel land on /client cleanly. The pages themselves now
      // redirect to /client.
      pathname === '/signin/client/onboarding-form' ||
      pathname === '/signin/client/payment' ||
      pathname === '/signin/client/pending'
    if (allowed) return NextResponse.next()
    return NextResponse.redirect(new URL('/client', req.nextUrl.origin))
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
