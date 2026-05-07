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

  // Find every linked user. The original spec assumed exactly one
  // (the User from the self-registration → onboarding-form flow), but
  // the credentials endpoint can create a second linked User if the
  // Client.contactEmail differs from a self-registered user's email
  // and admin uses "Generate login" before approving. We flip all of
  // them so no one's left stranded in client_onboarding /
  // client_pending while the Client itself is approved or denied.
  const linkedUsers = await prisma.user.findMany({
    where: { clientId: client.id, role: { startsWith: 'client_' } },
    select: { id: true, email: true, role: true, name: true },
  })

  // Single transaction: flip the client lifecycle + every linked
  // User. If a future bug ever leaves zero linked users, the client
  // still gets the decision applied — admin's intent shouldn't be
  // blocked by a missing pointer.
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.client.update({
      where: { id: client.id },
      data:
        action === 'approve'
          ? { lifecycle: 'active', active: true }
          : { lifecycle: 'denied', active: false },
      select: { id: true, name: true, lifecycle: true, active: true },
    })
    const newRole = action === 'approve' ? 'client_active' : 'client_denied'
    if (linkedUsers.length > 0) {
      await tx.user.updateMany({
        where: { id: { in: linkedUsers.map((u) => u.id) } },
        data: { role: newRole },
      })
    }
    // Re-read so the response carries the post-flip role values
    // rather than the stale pre-flip ones.
    const us = await tx.user.findMany({
      where: { id: { in: linkedUsers.map((u) => u.id) } },
      select: { id: true, email: true, role: true, name: true },
    })
    return { client: c, users: us }
  })

  // Email every linked user. Fire-and-forget so a slow Gmail send
  // doesn't make the admin sit on the spinner; errors land in the
  // server log via .catch.
  const origin = getPublicOrigin(req)
  const signinUrl = `${origin}/signin/client`
  for (const u of updated.users) {
    if (!u.email) continue
    const greeting = client.contactName || u.name || 'there'
    const body =
      action === 'approve'
        ? [
            `Hi ${greeting},`,
            '',
            `Your **${client.name}** account is approved. You can sign in and watch your appointments come through in real time.`,
            '',
            `[Sign in →](${signinUrl})`,
            '',
            'If you have any questions, just reply to this email.',
            '',
            '— Lead Genisys',
          ].join('\n')
        : [
            `Hi ${greeting},`,
            '',
            `Thanks for your interest in working with Lead Genisys. Your application for **${client.name}** isn't moving forward at this time. If you think this is a mistake, please reach out and we'll take another look.`,
            '',
            '— Lead Genisys',
          ].join('\n')
    sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: u.email,
      subject:
        action === 'approve'
          ? 'Welcome to Lead Genisys — your account is approved'
          : 'Lead Genisys application update',
      body,
    }).catch((err) => {
      console.error(
        `[clients/onboarding-decision] email failed for ${u.email}:`,
        err,
      )
    })
  }

  return NextResponse.json({
    ok: true,
    client: updated.client,
    users: updated.users,
  })
}
