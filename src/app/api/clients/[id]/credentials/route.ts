import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getPublicOrigin } from '@/lib/gmail'
import {
  provisionClientCredentials,
  sendClientWelcomeMessages,
} from '@/lib/client-credentials'

/**
 * Single-client login provisioning. Admin clicks "Generate login" /
 * "Reset password" on the Credentials tab → we mint a temp password,
 * email it to the client with a professional welcome layout, and SMS
 * the client a heads-up to check their email.
 *
 * Idempotent: re-running on a client that already has a login
 * rotates the password (same UX as a password reset).
 *
 * Provisioning + delivery logic lives in lib/client-credentials.ts —
 * same code path the bulk endpoint uses, so the two can't drift.
 */

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

  // Fetch the client for email + SMS delivery context. provisionClientCredentials
  // also reads it internally, but we need contactPhone + contactName
  // for the welcome SMS / email greeting, which the lib's narrowed
  // result doesn't return.
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactName: true,
      contactPhone: true,
    },
  })
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }

  const provision = await provisionClientCredentials(id)
  if (!provision.ok) {
    // Map lib error codes to HTTP statuses. 400 for "missing input"
    // shape (no email), 409 for collisions.
    const status =
      provision.code === 'no_contact_email' ? 400 : 409
    return NextResponse.json({ error: provision.error }, { status })
  }

  // Welcome email + SMS — awaited so the response can report whether
  // delivery succeeded. The lib captures errors per-channel without
  // throwing, so failures here are reported in the response, not as
  // 500s.
  const delivery = await sendClientWelcomeMessages({
    client: {
      id: client.id,
      name: client.name,
      contactName: client.contactName,
      contactEmail: provision.email,
      contactPhone: client.contactPhone,
    },
    email: provision.email,
    tempPassword: provision.tempPassword,
    hubOrigin: getPublicOrigin(req),
  })

  return NextResponse.json({
    user: { id: provision.userId, email: provision.email },
    client: { id: client.id, name: client.name },
    /** Returned only on the immediate response so admin can copy it
     *  if the welcome email send failed. Never persisted in plaintext
     *  anywhere — the only DB record is the bcrypt hash. */
    tempPassword: provision.tempPassword,
    isNewLogin: provision.isNewLogin,
    delivery,
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
