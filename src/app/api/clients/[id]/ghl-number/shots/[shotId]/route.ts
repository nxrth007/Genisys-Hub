import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/** GET /api/clients/:id/ghl-number/shots/:shotId — one page image from this client's toll-free number run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; shotId: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id, shotId } = await params
  const shot = await prisma.ghlNumberJobShot.findFirst({
    where: { id: shotId, job: { clientId: id } },
    select: { mime: true, data: true },
  })
  if (!shot) return NextResponse.json({ error: 'screenshot not found' }, { status: 404 })
  return new NextResponse(Buffer.from(shot.data), {
    headers: { 'Content-Type': shot.mime || 'image/jpeg', 'Cache-Control': 'private, no-store' },
  })
}
