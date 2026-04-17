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

  // Reject duplicates — whether it's an existing staff Google user or another
  // agent. We don't want to collide with or shadow an existing account.
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists.' },
      { status: 409 }
    )
  }

  const passwordHash = await bcrypt.hash(password, 10)

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

  return NextResponse.json({ ok: true, id: user.id })
}

function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}
