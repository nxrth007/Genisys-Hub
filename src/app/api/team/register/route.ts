import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { canonicalizeStateName, isKnownState } from '@/lib/address'

/**
 * POST /api/team/register
 *
 * Public endpoint (whitelisted in middleware). Creates a User row with
 * role="team_pending", teamNumber=1 (Mary's team — hardcoded today,
 * could be extended later), and a bcrypt passwordHash. Notifies the
 * admin so they can approve / deny from the admin queue.
 *
 * Mirror of /api/agent/register with two extra required fields
 * (servicingState, whatsappNumber) and a tagged "Team #1" subject so
 * admin sees the new registration in the right bucket of their inbox.
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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Same window as /api/agent/register: 5 per IP / 10 min. */
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

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
    email?: string
    password?: string
    servicingState?: string
    whatsappNumber?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const servicingStateRaw =
    typeof body.servicingState === 'string' ? body.servicingState.trim() : ''
  const whatsappNumber =
    typeof body.whatsappNumber === 'string' ? body.whatsappNumber.trim() : ''

  if (!name) {
    return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
  }
  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { error: 'A valid email is required.' },
      { status: 400 },
    )
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
  if (!whatsappNumber) {
    return NextResponse.json(
      { error: 'WhatsApp number is required so admin can reach you.' },
      { status: 400 },
    )
  }

  // Generic-response pattern — same as /api/agent/register. We always
  // return 200 whether the email is new or already taken, so this
  // endpoint can't be used to enumerate existing accounts. Hash the
  // password before the existence check so timing stays consistent
  // across both paths.
  const passwordHash = await bcrypt.hash(password, 10)
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: 'team_pending',
        servicingState,
        whatsappNumber,
        teamNumber: TEAM_NUMBER_FOR_THIS_REGISTRATION,
      },
      select: { id: true, email: true, name: true, createdAt: true },
    })

    // Best-effort admin notification — don't block registration on
    // Gmail latency. Subject is tagged "Team #1" so admin can filter
    // these distinct from regular agent applications.
    const origin = getPublicOrigin(req)
    const reviewUrl = `${origin}/admin/agents/${user.id}`
    sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: ADMIN_NOTIFY_EMAIL,
      subject: `[Team #1] New registration: ${name}`,
      body: [
        `**${name}** (${email}) just registered for **Team #1** on Genisys Hub.`,
        '',
        `Servicing state: ${servicingState ?? servicingStateRaw}`,
        `WhatsApp: ${whatsappNumber}`,
        '',
        `Review and approve or deny here:`,
        '',
        `[Review registration](${reviewUrl})`,
        '',
        `Registered at: ${user.createdAt.toISOString()}`,
        '',
        `If you didn't expect this Team #1 registration, deny it — they won't be able to sign in.`,
      ].join('\n'),
    }).catch((err) => {
      console.error('[team/register] Gmail notification failed:', err)
    })
  } else {
    console.log(
      `[team/register] Duplicate registration attempt for ${email} — silently ignored`,
    )
  }

  return NextResponse.json({ ok: true })
}

function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}
