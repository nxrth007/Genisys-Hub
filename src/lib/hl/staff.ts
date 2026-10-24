import { prisma } from '@/lib/prisma'

/** A sub-account's staff (GHL's My Staff): users imported from GHL and people added here, kept as HlRecord kind "user". */
export type StaffRow = { id: string; ghlId: string | null; name: string; email: string | null; phone: string | null }

export async function staffOf(accountId: string): Promise<StaffRow[]> {
  const rows = await prisma.hlRecord.findMany({ where: { accountId, kind: 'user' }, orderBy: { name: 'asc' }, select: { id: true, ghlId: true, name: true, data: true } })
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>
    return { id: r.id, ghlId: r.ghlId, name: r.name, email: typeof d.email === 'string' ? d.email : null, phone: typeof d.phone === 'string' ? d.phone : null }
  })
}
