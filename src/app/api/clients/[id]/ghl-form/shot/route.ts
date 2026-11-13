import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/** GET /api/clients/:id/ghl-form/shot — the latest page image from this client's site-form run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const job = await prisma.ghlFormJob.findUnique({ where: { clientId: id }, select: { shot: true } })
  if (!job?.shot) return NextResponse.json({ error: 'no screenshot' }, { status: 404 })
  return new NextResponse(Buffer.from(job.shot), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } })
}
