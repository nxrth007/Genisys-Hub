import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { getSheetSyncStatus, reconcileOnboardingSheet } from '@/lib/onboarding-sheet'
import { maybeCheckStripeOnboarding, stripeGateStatus } from '@/lib/stripe-onboarding'

/**
 * GET /api/clients/onboarding-health
 *
 * Is the onboarding form → Hub pipeline healthy? The webhook's own
 * config, when the last submission arrived, how many this month, whether
 * any submission never became a Client, how the Hub's own read of the
 * form's Google Sheet is going, and the Stripe sign-up gate (the Hub's
 * check of its Stripe key and Vault entries, the form's last question to
 * the Hub, Stripe's last event, the last sign-up).
 *
 * POST runs the sheet read now instead of waiting for the schedule;
 * POST { action: "stripe" } runs the Stripe check now. Staff only.
 */

async function staff(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}

async function health() {
  const since = new Date(Date.now() - 30 * 86_400_000)
  const [secretConfigured, lastIntake, intakes30d, unlinked, total, sheet, stripe] = await Promise.all([
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
    getSheetSyncStatus().catch(() => null),
    stripeGateStatus().catch(() => null),
  ])
  const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return {
    webhookUrl: `${base}/api/webhooks/client-onboarding`,
    secretConfigured,
    lastIntake: lastIntake
      ? { id: lastIntake.id, at: lastIntake.receivedAt.toISOString(), businessName: lastIntake.businessName, clientId: lastIntake.clientId }
      : null,
    intakes30d,
    unlinked,
    total,
    sheet,
    stripe,
  }
}

export async function GET() {
  const denied = await staff()
  if (denied) return denied
  return NextResponse.json(await health())
}

export async function POST(req: NextRequest) {
  const denied = await staff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { action?: unknown } | null
  if (body?.action === 'stripe') await maybeCheckStripeOnboarding(true)
  else await reconcileOnboardingSheet()
  return NextResponse.json(await health())
}
