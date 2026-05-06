import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'

/**
 * POST /api/clients/[id]/onboarding-decision
 *
 * Approve or deny a Client whose lifecycle is "pending" (came in via
 * /signin/client/register + /signin/client/onboarding-form).
 *
 * Approve  → Client.lifecycle = "active"  + active=true
 *            User.role        = "client_active"
 *            (User keeps the password they picked at registration)
 * Deny     → Client.lifecycle = "denied"
 *            User.role        = "client_denied"
 *
 * Either way the client gets an email. Approval includes the sign-in
 * URL; denial is a polite generic note (matches the agent-denied
 * email tone — we're not auto-disclosing reasons).
 */
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || 'alex@leadgenisys.com'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown
  }
  const action = typeof body.action === 'string' ? body.action : ''
  if (action !== 'approve' && action !== 'deny') {
    return NextResponse.json(
      { error: 'action must be "approve" or "deny"' },
      { status: 400 },
    )
  }

  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      lifecycle: true,
      contactName: true,
      contactEmail: true,
      package: true,
    },
  })
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }
  if (client.lifecycle !== 'pending') {
    return NextResponse.json(
      {
        error: `Client is not awaiting onboarding approval (lifecycle=${client.lifecycle}).`,
      },
      { status: 409 },
    )
  }

  // Find the linked user (the one who registered + filled the form).
  // Should always be exactly one — onboarding form submission set it.
  const linkedUser = await prisma.user.findFirst({
    where: { clientId: client.id },
    select: { id: true, email: true, role: true, name: true },
  })

  // Two writes in a transaction: client lifecycle/active + user role.
  // The user write is best-effort — if for some reason the link got
  // lost, we still flip the client so admin's decision sticks.
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.client.update({
      where: { id: client.id },
      data:
        action === 'approve'
          ? { lifecycle: 'active', active: true }
          : { lifecycle: 'denied', active: false },
      select: { id: true, name: true, lifecycle: true, active: true },
    })
    let u = null as typeof linkedUser
    if (linkedUser) {
      u = await tx.user.update({
        where: { id: linkedUser.id },
        data: {
          role: action === 'approve' ? 'client_active' : 'client_denied',
        },
        select: { id: true, email: true, role: true, name: true },
      })
    }
    return { client: c, user: u }
  })

  // Email the client. Best-effort.
  if (updated.user?.email) {
    const origin = getPublicOrigin(req)
    const signinUrl = `${origin}/signin/client`
    try {
      if (action === 'approve') {
        await sendEmail({
          accountEmail: FROM_GMAIL_ACCOUNT,
          to: updated.user.email,
          subject: 'Welcome to Lead Genisys — your account is approved',
          body: [
            `Hi ${client.contactName || updated.user.name || 'there'},`,
            '',
            `Your **${client.name}** account is approved. You can sign in and watch your appointments come through in real time.`,
            '',
            `[Sign in →](${signinUrl})`,
            '',
            'If you have any questions, just reply to this email.',
            '',
            '— Lead Genisys',
          ].join('\n'),
        })
      } else {
        await sendEmail({
          accountEmail: FROM_GMAIL_ACCOUNT,
          to: updated.user.email,
          subject: 'Lead Genisys application update',
          body: [
            `Hi ${client.contactName || updated.user.name || 'there'},`,
            '',
            `Thanks for your interest in working with Lead Genisys. Your application for **${client.name}** isn't moving forward at this time. If you think this is a mistake, please reach out and we'll take another look.`,
            '',
            '— Lead Genisys',
          ].join('\n'),
        })
      }
    } catch (err) {
      console.error('[clients/onboarding-decision] email failed:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    client: updated.client,
    user: updated.user,
  })
}
