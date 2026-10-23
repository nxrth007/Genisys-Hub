import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessPayments } from '@/lib/payments-access'
import { whopFieldMap } from '@/lib/whop'

/**
 * GET /api/payments/whop/fields — the field names (no values) Whop sends on a
 * payment and a membership, and the sign-up texter's state (when it started
 * watching, how many memberships it has seen). Payments allowlist only.
 */
export async function GET() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const row = await prisma.appSetting.findUnique({ where: { key: 'whop.signupAlerts' } })
  let watcher: { since: string | null; seen: number } | null = null
  try {
    const s = row ? (JSON.parse(row.value) as { since?: string; seen?: string[] }) : null
    watcher = s ? { since: s.since ?? null, seen: s.seen?.length ?? 0 } : null
  } catch {
    watcher = null
  }
  return NextResponse.json({ watcher, ...(await whopFieldMap()) })
}
