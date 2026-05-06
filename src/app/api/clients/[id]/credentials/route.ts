import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'

/**
 * Phase 1 of client-access: lets admin generate a login for an
 * already-onboarded client. Spec from Alex:
 *
 *   "I was thinking you could create them user-names and passwords
 *   for now instead of having to use their email. I want you to
 *   create these log ins/Accounts for all current Clients and store
 *   that information on a tab on the 'onboarding' page called
 *   Credentials."
 *
 * We use the client's contactEmail (cleaner than a separate username
 * column — emails are unique already and the client has one we can
 * write to). Admin clicks "Generate login" on the Credentials tab,
 * we provision a User row with role=client_active, mustChangePassword=
 * true, link clientId, generate a 16-char temp password, bcrypt it,
 * and email the password to both the client and to alex@leadgenisys
 * .com (so Alex has a record before the client logs in).
 *
 * Idempotent on regeneration: if a client_active User already exists
 * for this client, we rotate its password rather than creating a
 * duplicate row. Admin can use this same flow to reset a forgotten
 * password.
 */
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || 'alex@leadgenisys.com'

/** Length of generated temp passwords. 16 random bytes → ~21 chars in
 *  base64url, comfortably above the 10-char minimum on the change-
 *  password screen. */
const TEMP_PASSWORD_BYTES = 16

function generateTempPassword(): string {
  // base64url avoids ambiguous characters (no + / =) and is shell-safe
  // for emails. 16 bytes → 22 chars.
  return randomBytes(TEMP_PASSWORD_BYTES).toString('base64url')
}

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
  const client = await prisma.client.findUnique({
    where: { id },
    select: { id: true, name: true, contactEmail: true, contactName: true },
  })
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }
  const email = client.contactEmail?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json(
      {
        error:
          'This client has no contact email — add one on the client edit form first, then generate credentials.',
      },
      { status: 400 },
    )
  }

  // Block accidentally repurposing a staff/agent account as a client
  // login. If the email collides with a non-client user, admin needs
  // to use a different one — we don't silently overwrite roles.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, clientId: true },
  })
  if (
    existing &&
    existing.role !== 'client_active' &&
    existing.role !== 'client_pending' &&
    existing.role !== 'client_onboarding' &&
    existing.role !== 'client_denied'
  ) {
    return NextResponse.json(
      {
        error: `An account with email ${email} already exists for a non-client user (role=${existing.role}). Use a different contact email.`,
      },
      { status: 409 },
    )
  }
  if (existing && existing.clientId && existing.clientId !== id) {
    return NextResponse.json(
      {
        error: `An account with email ${email} is already linked to a different client. Resolve the conflict before generating credentials here.`,
      },
      { status: 409 },
    )
  }

  // Generate a fresh temp password every time. Even on regenerate
  // (admin "reset password"), the old one is invalidated.
  const tempPassword = generateTempPassword()
  const passwordHash = await bcrypt.hash(tempPassword, 12)

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          mustChangePassword: true,
          role: 'client_active',
          clientId: id,
        },
        select: { id: true, email: true, name: true, createdAt: true },
      })
    : await prisma.user.create({
        data: {
          email,
          name: client.contactName ?? client.name,
          passwordHash,
          mustChangePassword: true,
          role: 'client_active',
          clientId: id,
        },
        select: { id: true, email: true, name: true, createdAt: true },
      })

  // Best-effort email — don't fail the API call if Gmail hiccups; the
  // admin can copy the temp password out of the response and resend
  // manually if needed.
  const origin = getPublicOrigin(req)
  const signinUrl = `${origin}/signin/client`
  const recipient = client.contactName
    ? `${client.contactName} (${client.name})`
    : client.name
  let emailSent = false
  try {
    await sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: email,
      subject: 'Your Genisys Hub client login is ready',
      body: [
        `Hi ${client.contactName || 'there'},`,
        '',
        'We just provisioned a Genisys Hub login for you. Sign in to see the appointments we are delivering for your business in real time.',
        '',
        `**Sign in:** ${signinUrl}`,
        `**Email:** ${email}`,
        `**Temporary password:** ${tempPassword}`,
        '',
        'You will be asked to set your own password the first time you sign in.',
        '',
        '— Genisys',
      ].join('\n'),
    })
    emailSent = true
  } catch (err) {
    console.error('[clients/credentials] email send failed:', err)
  }

  // Notify Alex too so he has a paper trail of provisioned logins.
  // Same best-effort posture.
  try {
    await sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: 'alex@leadgenisys.com',
      subject: `[Genisys Hub] Login provisioned for ${client.name}`,
      body: [
        `Login generated for ${recipient}.`,
        '',
        `Email: ${email}`,
        `Sign in: ${signinUrl}`,
        '',
        'The temp password was emailed to the client.',
        '',
        '— Genisys Hub',
      ].join('\n'),
    })
  } catch (err) {
    console.error('[clients/credentials] alex notify failed:', err)
  }

  return NextResponse.json({
    user,
    client: { id: client.id, name: client.name },
    /** Returned only on the immediate response so admin can copy it
     *  if the email send failed. Never persisted in plaintext. */
    tempPassword,
    emailSent,
  })
}

/**
 * GET /api/clients/[id]/credentials
 *
 * Returns metadata about the client_* User row (or null if none).
 * Used by the Credentials tab to show "active login since X" / "no
 * login provisioned yet" without exposing password hashes.
 */
export async function GET(
  _req: NextRequest,
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
  const user = await prisma.user.findFirst({
    where: { clientId: id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      mustChangePassword: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return NextResponse.json({ user })
}
