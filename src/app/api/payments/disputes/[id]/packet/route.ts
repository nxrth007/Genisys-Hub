import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { prisma } from '@/lib/prisma'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await ctx.params
  const row = await prisma.stripeDispute.findUnique({ where: { id }, select: { packetPdf: true, stripeDisputeId: true } })
  if (!row?.packetPdf) return NextResponse.json({ error: 'no packet yet' }, { status: 404 })
  const pdf = new Uint8Array(row.packetPdf.byteLength)
  pdf.set(row.packetPdf)
  return new NextResponse(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="dispute-${row.stripeDisputeId}.pdf"`,
    },
  })
}
