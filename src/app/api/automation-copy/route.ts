import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { AUTOMATION_IDS } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, parseSavedCopy } from '@/lib/automation-copy-saved'

/**
 * GET /api/automation-copy — every active client, A–Z, with how many of
 * its automations are ticked as set up in GHL. Staff only, like the A2P board.
 */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  const [clients, rows] = await Promise.all([
    prisma.client.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, siteUrl: true, _count: { select: { intakes: true } } },
    }),
    prisma.appSetting.findMany({ where: { key: { startsWith: AUTOMATION_COPY_PREFIX } }, select: { key: true, value: true } }),
  ])
  const done = new Map(rows.map((r) => [r.key.slice(AUTOMATION_COPY_PREFIX.length), parseSavedCopy(r.value).done.length]))
  const list = clients
    .map((c) => ({ id: c.id, name: c.name, siteUrl: c.siteUrl, hasIntake: c._count.intakes > 0, done: done.get(c.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
  return NextResponse.json({ clients: list, total: AUTOMATION_IDS.length })
}
