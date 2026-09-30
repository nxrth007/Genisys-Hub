import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/clients/onboarding-health
 *
 * Is the onboarding form → Hub pipeline healthy? The webhook's own
 * config, when the last submission arrived, how many this month, and
 * whether any submission never became a Client. Staff only.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const since = new Date(Date.now() - 30 * 86_400_000)
  const [secretConfigured, lastIntake, intakes30d, unlinked, total] = await Promise.all([
    getSecretByName('Client Onboarding Webhook Secret')
      .then((v) => v.trim().length > 0)
      .catch(() => false),
    prisma.clientIntake.findFirst({
      orderBy: { receivedAt: 'desc' },
      select: { id: true, receivedAt: true, businessName: true, clientId: true },
    }),
    prisma.clientIntake.count({ where: { receivedAt: { gte: since } } }),
    prisma.clientIntake.count({ where: { clientId: null, status: { not: 'archived' } } }),
    prisma.clientIntake.count(),
  ])

  const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return NextResponse.json({
    webhookUrl: `${base}/api/webhooks/client-onboarding`,
    secretConfigured,
    lastIntake: lastIntake
      ? { id: lastIntake.id, at: lastIntake.receivedAt.toISOString(), businessName: lastIntake.businessName, clientId: lastIntake.clientId }
      : null,
    intakes30d,
    unlinked,
    total,
  })
}
