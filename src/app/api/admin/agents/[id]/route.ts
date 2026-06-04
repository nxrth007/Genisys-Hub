import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { ensureAgentTab, cleanupAgentSheetData } from '@/lib/drive'

/**
 * GET    /api/admin/agents/[id]  → full agent detail (+ appointments)
 * PATCH  /api/admin/agents/[id]  → approve / deny / edit / reset password
 *   Body can include:
 *     action: 'approve' | 'deny' | 'reset_password'
 *     name?: string
 *     email?: string
 *     newPassword?: string (used by reset_password)
 * DELETE /api/admin/agents/[id]  → permanently remove the agent account
 *
 * Admin-only — middleware enforces role=admin.
 */

const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || 'alex@leadgenisys.com'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const agent = await prisma.user.findFirst({
    where: { id, role: { in: ['agent_pending', 'agent', 'agent_denied'] } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      agentSheetTab: true,
      approvedAt: true,
      approvedById: true,
      managesTeamNumber: true,
      createdAt: true,
      updatedAt: true,
      appointments: {
        orderBy: { apptDateTime: 'desc' },
        take: 50,
      },
    },
  })
  if (!agent) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({ agent })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  let body: {
    action?: 'approve' | 'deny' | 'reset_password'
    name?: string
    email?: string
    newPassword?: string
    /** Toggle this agent's team-manager flag. Number = team they
     *  manage (typically 1 for Mary). Null = revoke. Independent
     *  of action — admin can set this without approving/denying
     *  in the same request. */
    managesTeamNumber?: number | null
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const existing = await prisma.user.findFirst({
    where: { id, role: { in: ['agent_pending', 'agent', 'agent_denied'] } },
  })
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data: Record<string, unknown> = {}

  if (typeof body.name === 'string' && body.name.trim()) {
    data.name = body.name.trim()
  }
  if (body.managesTeamNumber === null) {
    data.managesTeamNumber = null
  } else if (
    typeof body.managesTeamNumber === 'number' &&
    Number.isInteger(body.managesTeamNumber) &&
    body.managesTeamNumber > 0
  ) {
    data.managesTeamNumber = body.managesTeamNumber
  }
  if (typeof body.email === 'string' && body.email.trim()) {
    const normalized = body.email.trim().toLowerCase()
    if (normalized !== existing.email) {
      // Check collision
      const collision = await prisma.user.findUnique({ where: { email: normalized } })
      if (collision && collision.id !== id) {
        return NextResponse.json({ error: 'That email is already in use.' }, { status: 409 })
      }
      data.email = normalized
    }
  }

  if (body.action === 'approve') {
    data.role = 'agent'
    data.approvedAt = new Date()
    data.approvedById = session.user.id
    // Create the agent's dedicated tab in the master spreadsheet so their
    // first appointment has somewhere to go. Best-effort — if Drive isn't
    // connected yet we still approve them, and `agentSheetTab` stays null
    // (later sync attempts will retry tab creation on demand).
    try {
      const tab = await ensureAgentTab({
        agentName: existing.name,
        agentEmail: existing.email,
      })
      data.agentSheetTab = tab
    } catch (err) {
      console.error('[admin/agents approve] ensureAgentTab failed:', err)
      data.agentSheetTab = null
    }
  } else if (body.action === 'deny') {
    data.role = 'agent_denied'
    data.approvedAt = null
    data.approvedById = session.user.id
  } else if (body.action === 'reset_password') {
    if (!body.newPassword || body.newPassword.length < 8) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters.' },
        { status: 400 }
      )
    }
    data.passwordHash = await bcrypt.hash(body.newPassword, 10)
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      agentSheetTab: true,
      approvedAt: true,
      createdAt: true,
    },
  })

  // Fire a notification email on approve/deny. Best-effort — don't fail the
  // admin action if Gmail send hiccups.
  if (body.action === 'approve' || body.action === 'deny') {
    try {
      const origin = getPublicOrigin(req)
      const agentName = updated.name || updated.email
      if (body.action === 'approve') {
        await sendEmail({
          accountEmail: FROM_GMAIL_ACCOUNT,
          to: updated.email,
          subject: 'Your Genisys Hub agent account is approved',
          body: [
            `Hi ${agentName},`,
            '',
            'Your Genisys Hub agent account has been approved. You can now sign in and start logging your booked solar appointments:',
            '',
            `[Sign in →](${origin}/signin/agent)`,
            '',
            'Welcome aboard.',
            '— Genisys',
          ].join('\n'),
        })
      } else {
        await sendEmail({
          accountEmail: FROM_GMAIL_ACCOUNT,
          to: updated.email,
          subject: 'Genisys Hub agent registration update',
          body: [
            `Hi ${agentName},`,
            '',
            'Your agent registration on Genisys Hub was not approved. If you think this is a mistake, please reach out to your Genisys contact.',
            '',
            '— Genisys',
          ].join('\n'),
        })
      }
    } catch (err) {
      console.error('[admin/agents PATCH] notification failed:', err)
    }
  }

  return NextResponse.json({ ok: true, agent: updated })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  // Capture the agent's sheet state BEFORE the delete — Prisma's cascade
  // will wipe their Appointment rows, so we need the master-row numbers
  // and tab title in memory before that happens.
  const existing = await prisma.user.findFirst({
    where: { id, role: { in: ['agent_pending', 'agent', 'agent_denied'] } },
    select: {
      id: true,
      name: true,
      email: true,
      agentSheetTab: true,
      appointments: {
        select: { masterSheetRowNumber: true },
      },
    },
  })
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const masterRowsToClear = existing.appointments
    .map((a) => a.masterSheetRowNumber)
    .filter((n): n is number => typeof n === 'number')

  await prisma.user.delete({ where: { id } })

  // Fire-and-forget sheet cleanup so the admin response isn't held up by
  // Google API round-trips. Any failure is logged; the DB is already
  // consistent at this point and the admin can re-run cleanup manually
  // from Sheet Maintenance if needed.
  cleanupAgentSheetData({
    masterRowsToClear,
    agentTabTitle: existing.agentSheetTab,
  }).catch((err) => console.error('[admin/agents DELETE] sheet cleanup failed:', err))

  return NextResponse.json({ ok: true })
}

function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}
