import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/ghl-subaccount-worker/jobs/:id
 *
 * One sub-account job's step log and the list of its screenshots, so a
 * failed create can be read without a database client. Read-only.
 * Each screenshot is at /api/admin/ghl-subaccount-worker/shots/:shotId.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdmin()
  if (denial) return denial
  const { id } = await params
  const job = await prisma.ghlSubaccountJob.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      attempts: true,
      detail: true,
      lastError: true,
      locationId: true,
      updatedAt: true,
      log: true,
      client: { select: { id: true, name: true } },
      shots: { orderBy: { createdAt: 'asc' }, select: { id: true, step: true, createdAt: true } },
    },
  })
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 })
  return NextResponse.json({
    ...job,
    log: Array.isArray(job.log) ? job.log : [],
    shots: job.shots.map((shot) => ({ ...shot, url: `/api/admin/ghl-subaccount-worker/shots/${shot.id}` })),
  })
}
