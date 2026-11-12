import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/ghl-subaccount-worker/shots/:id
 *
 * One screenshot the sub-account worker saved while driving GHL. Admin-only.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdmin()
  if (denial) return denial
  const { id } = await params
  const shot = await prisma.ghlSubaccountJobShot.findUnique({ where: { id }, select: { mime: true, data: true } })
  if (!shot) return NextResponse.json({ error: 'screenshot not found' }, { status: 404 })
  return new NextResponse(Buffer.from(shot.data), {
    headers: { 'Content-Type': shot.mime || 'image/jpeg', 'Cache-Control': 'private, no-store' },
  })
}
