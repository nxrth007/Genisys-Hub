import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'

/**
 * POST /api/agent/register
 *
 * Public endpoint (whitelisted in middleware). Creates a User row with
 * role="agent_pending" and a bcrypt passwordHash. Sends an approval
 * notification to alex@leadgenisys.com via his connected Gmail account.
 * If email delivery fails we still succeed — Alex can check the /admin/agents
 * page periodically.
 */

const ADMIN_NOTIFY_EMAIL =
  process.env.AGENT_APPROVAL_NOTIFY_EMAIL || 'alex@leadgenisys.com'
const FROM_GMAIL_ACCOUNT = process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function POST(req: NextRequest) {
  let body: { name?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!name) {
    return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
  }
  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 }
    )
  }

  // Generic-response pattern: return the same 200 ok whether the email
  // is new OR already taken. Prevents attackers from probing this public
  // endpoint to enumerate staff + agent emails. If the email is already
  // on file we quietly skip the create/notify — the legitimate user
  // lands on the pending screen and contacts Alex directly if they
  // expected to sign in. Hash the password first so the timing looks
  // similar between the duplicate-skip and new-user paths.
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
        role: 'agent_pending',
      },
      select: { id: true, email: true, name: true, createdAt: true },
    })

    // Notify the admin. Best-effort — don't fail registration if email is broken.
    const origin = getPublicOrigin(req)
    const reviewUrl = `${origin}/admin/agents/${user.id}`

    try {
      await sendEmail({
        accountEmail: FROM_GMAIL_ACCOUNT,
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New agent registration: ${name}`,
        body: [
          `**${name}** (${email}) just registered as a call-center agent on Genisys Hub.`,
          '',
          `Review and approve or deny their registration here:`,
          '',
          `[Review registration](${reviewUrl})`,
          '',
          `Registered at: ${user.createdAt.toISOString()}`,
          '',
          `If you didn't expect this, deny the registration — they won't be able to sign in.`,
        ].join('\n'),
      })
    } catch (err) {
      console.error('[agent/register] Gmail notification failed:', err)
      // Swallow — Alex can still approve via /admin/agents manually.
    }
  } else {
    // Log for ops visibility; don't expose to the client.
    console.log(
      `[agent/register] Duplicate registration attempt for ${email} — silently ignored`
    )
  }

  // Always return a neutral 200 so the two paths are indistinguishable.
  return NextResponse.json({ ok: true })
}

function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}
