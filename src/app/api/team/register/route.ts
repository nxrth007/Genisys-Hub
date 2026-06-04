import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { canonicalizeStateName, isKnownState } from '@/lib/address'

/**
 * POST /api/team/register
 *
 * Public endpoint (whitelisted in middleware). Creates a User row
 * with role="team_pending" and a generated registrationLookupCode
 * the user shows to their supervisor for out-of-band approval.
 *
 * As of 2026-06-03 (Team #1 cutover):
 *   - NO email collected from the user. The User.email column is
 *     still required by NextAuth's PrismaAdapter, so we synthesize
 *     a placeholder like `team1-<lookupCode>@team1.local`. That
 *     synthesized email is never shown to anyone and never used
 *     for sign-in.
 *   - NO whatsappNumber collected (column kept for historical rows
 *     but new registrations skip it).
 *   - NO callCenterNumber at registration — admin assigns it after
 *     approval through /admin/team-members.
 *
 * Returns the lookup code so the register page can display it to
 * the user.
 */

const ADMIN_NOTIFY_EMAIL =
  process.env.TEAM_APPROVAL_NOTIFY_EMAIL ||
  process.env.AGENT_APPROVAL_NOTIFY_EMAIL ||
  'alex@leadgenisys.com'
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

/** Hardcoded for now — Mary's team. If a second team ever onboards
 *  we'll split this into a per-flow constant. Documented in the
 *  schema's User.teamNumber comment. */
const TEAM_NUMBER_FOR_THIS_REGISTRATION = 1

/** Same window as /api/agent/register: 5 per IP / 10 min. */
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

/** Generate a 6-character lookup code from random bytes. Uppercase
 *  alphanumeric, excluding visually-confusing chars (0, O, 1, I, L)
 *  so a supervisor can read it off a phone screen without
 *  misreading. ~1.7B possible codes per 6 chars — collision is
 *  astronomically unlikely for the foreseeable Team #1 volume. */
function generateLookupCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length]
  }
  return out
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const limit = checkRateLimit(
    `team-register:${ip}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!limit.ok) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000)
    return NextResponse.json(
      {
        error:
          'Too many registration attempts. Please try again in a few minutes.',
      },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSeconds) },
      },
    )
  }

  let body: {
    name?: string
    password?: string
    servicingState?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const servicingStateRaw =
    typeof body.servicingState === 'string' ? body.servicingState.trim() : ''

  if (!name) {
    return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 },
    )
  }
  if (!servicingStateRaw) {
    return NextResponse.json(
      { error: 'Pick the state you are servicing.' },
      { status: 400 },
    )
  }
  if (!isKnownState(servicingStateRaw)) {
    return NextResponse.json(
      {
        error:
          'Pick a valid US state. You can change this later from your profile.',
      },
      { status: 400 },
    )
  }
  const servicingState = canonicalizeStateName(servicingStateRaw)

  // Generate the lookup code + synthesized placeholder email. The
  // .local TLD is RFC 6762 reserved — never a real address. The
  // placeholder is what satisfies the User.email @unique constraint
  // (and NextAuth's PrismaAdapter expectations) without exposing
  // the user to email anywhere.
  let lookupCode = ''
  let placeholderEmail = ''
  // Retry a handful of times if a generated code happens to collide
  // with an existing pending row (vanishingly unlikely but cheap to
  // guard).
  for (let attempt = 0; attempt < 5; attempt++) {
    lookupCode = generateLookupCode()
    placeholderEmail = `team1-${lookupCode.toLowerCase()}@team1.local`
    const collision = await prisma.user.findUnique({
      where: { email: placeholderEmail },
      select: { id: true },
    })
    if (!collision) break
    if (attempt === 4) {
      console.error(
        '[team/register] 5 lookup-code collisions — aborting to avoid a hot loop',
      )
      return NextResponse.json(
        {
          error: 'Something went wrong generating your account. Try again.',
        },
        { status: 500 },
      )
    }
  }

  const passwordHash = await bcrypt.hash(password, 10)

  const user = await prisma.user.create({
    data: {
      email: placeholderEmail,
      name,
      passwordHash,
      role: 'team_pending',
      servicingState,
      teamNumber: TEAM_NUMBER_FOR_THIS_REGISTRATION,
      registrationLookupCode: lookupCode,
      // callCenterNumber stays null — admin assigns it on approval.
      // whatsappNumber stays null — no longer collected.
    },
    select: { id: true, name: true, createdAt: true },
  })

  // Best-effort admin notification. Subject is tagged "Team #1" so
  // Alex's filter keeps catching these. Link points to the new
  // /admin/team-members page where Alex can approve + assign the
  // call-center number in one click.
  const origin = getPublicOrigin(req)
  const reviewUrl = `${origin}/admin/team-members`
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[Team #1] New registration: ${name}`,
    body: [
      `**${name}** just registered for **Team #1** on Genisys Hub.`,
      '',
      `Lookup code: \`${lookupCode}\``,
      `Servicing state: ${servicingState ?? servicingStateRaw}`,
      '',
      `Approve them + assign a call-center number here:`,
      '',
      `[Review Team #1 registrations](${reviewUrl})`,
      '',
      `Registered at: ${user.createdAt.toISOString()}`,
      '',
      `Once approved, give the user their call-center number through Mary / WhatsApp — they sign in with that number, not email.`,
    ].join('\n'),
  }).catch((err) => {
    console.error('[team/register] Gmail notification failed:', err)
  })

  // Return the lookup code so the register page can display it.
  // Safe to surface: it's only useful for admin disambiguation, not
  // an auth credential.
  return NextResponse.json({ ok: true, lookupCode })
}

function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}
