import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getPublicOrigin } from '@/lib/gmail'
import {
  provisionClientCredentials,
  sendClientWelcomeMessages,
} from '@/lib/client-credentials'

/**
 * POST /api/admin/clients/bulk-credentials
 *
 * Provision a login for every active client that doesn't already
 * have one, then send each a professional welcome email (credentials
 * inside) + a heads-up SMS (no credentials — just "check your email").
 * Built for Alex's 2026-05-29 roll-out of the 9 existing clients
 * who onboarded before the registration flow existed; reusable for
 * any future batch of legacy clients we onboard later.
 *
 * Selection rules (server-side; nothing trusted from the request):
 *   - active=true clients only
 *   - clients with NO existing User row pointing at them
 *     (`role: 'client_*'`)
 *   - contactEmail must be set (otherwise we have nowhere to send
 *     the credentials)
 *
 * Returns a per-client summary so the UI can render "9 logins
 * generated, 9 emails sent, 7 SMS sent (2 skipped — no phone), 0
 * failed" without inferring counts.
 *
 * Sequential rather than parallel — bcrypt + Gmail send are both
 * non-trivial CPU/IO each, and serializing 9 of them keeps total
 * runtime ~10-20s vs risking Gmail rate limits or hot-looping the
 * bcrypt cost-12 hashing. Future versions can parallelize if the
 * batch ever grows past ~25.
 */

type ProvisionSummary = {
  generated: number
  failed: number
  emailsSent: number
  smsSent: number
  smsSkippedNoPhone: number
  smsFailed: number
}

type ClientResult = {
  clientId: string
  clientName: string
  ok: boolean
  emailSent: boolean
  smsSent: boolean
  smsSkippedReason: string | null
  /** When ok=false, the human-readable reason. Same codes the
   *  single-client endpoint uses (no_contact_email, etc.). */
  error: string | null
  /** Returned ONLY in the immediate response so admin can copy a
   *  temp password if the welcome email failed for that client.
   *  Never persisted in plaintext. */
  tempPassword: string | null
  isNewLogin: boolean
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Find every active client that doesn't already have a linked
  // client_* User row. We over-fetch slightly (every active client)
  // and filter in code so the "already has a login" check uses the
  // same role-prefix logic the lib does — cheaper than a complex
  // EXISTS subquery and the active-client count is bounded
  // (typically <50).
  const allActiveClients = await prisma.client.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactName: true,
      contactPhone: true,
      users: {
        where: { role: { startsWith: 'client_' } },
        select: { id: true },
        take: 1,
      },
    },
  })
  const candidates = allActiveClients.filter(
    (c) => c.users.length === 0,
  )

  const hubOrigin = getPublicOrigin(req)
  const results: ClientResult[] = []
  const summary: ProvisionSummary = {
    generated: 0,
    failed: 0,
    emailsSent: 0,
    smsSent: 0,
    smsSkippedNoPhone: 0,
    smsFailed: 0,
  }

  for (const client of candidates) {
    const provision = await provisionClientCredentials(client.id)
    if (!provision.ok) {
      results.push({
        clientId: client.id,
        clientName: client.name,
        ok: false,
        emailSent: false,
        smsSent: false,
        smsSkippedReason: null,
        error: provision.error,
        tempPassword: null,
        isNewLogin: false,
      })
      summary.failed++
      continue
    }

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
      hubOrigin,
    })

    summary.generated++
    if (delivery.emailSent) summary.emailsSent++
    if (delivery.smsSent) summary.smsSent++
    if (delivery.smsSkippedReason === 'no_phone') summary.smsSkippedNoPhone++
    if (delivery.smsError) summary.smsFailed++

    results.push({
      clientId: client.id,
      clientName: client.name,
      ok: true,
      emailSent: delivery.emailSent,
      smsSent: delivery.smsSent,
      smsSkippedReason: delivery.smsSkippedReason,
      // If the welcome email failed but the user was created OK,
      // surface the temp password so admin can copy + share by hand.
      // For successful sends we still return it so the UI can show
      // a "show password" toggle on each row if needed; it's not
      // displayed by default.
      tempPassword: provision.tempPassword,
      isNewLogin: provision.isNewLogin,
      error: delivery.emailError ?? delivery.smsError ?? null,
    })
  }

  return NextResponse.json({
    summary,
    results,
    /** Total candidates considered (clients without a login). Lets
     *  the UI confirm "we found N unprovisioned clients" matches
     *  what admin expected to see before they fired the bulk run. */
    candidatesConsidered: candidates.length,
  })
}

/**
 * GET /api/admin/clients/bulk-credentials
 *
 * Preview: returns the list of clients that would be provisioned if
 * admin clicked the bulk button right now. Lets the UI show a count
 * + list before the destructive call.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const allActiveClients = await prisma.client.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      users: {
        where: { role: { startsWith: 'client_' } },
        select: { id: true },
        take: 1,
      },
    },
  })
  const candidates = allActiveClients
    .filter((c) => c.users.length === 0)
    .map((c) => ({
      id: c.id,
      name: c.name,
      contactEmail: c.contactEmail,
      hasContactPhone: !!c.contactPhone?.trim(),
      // Clients without an email can't be provisioned — surface that
      // so the UI can warn admin before they hit go.
      provisionable: !!c.contactEmail?.trim(),
    }))
  return NextResponse.json({ candidates })
}
