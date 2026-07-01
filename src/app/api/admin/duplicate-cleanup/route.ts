import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/admin/duplicate-cleanup                            → report (read-only)
 * GET  /api/admin/duplicate-cleanup?confirm=yes-remove-import-copies → delete
 *
 * Removes the duplicate appointments the sheet-import created before the
 * dedup fix. Matching is by CUSTOMER IDENTITY — normalized phone + exact
 * appointment time — NOT masterSheetRowNumber (that field is corrupted:
 * different customers share the same row number, so it can't be trusted).
 *
 * Rules, per identity group (same phone + same apptDateTime, >1 row):
 *   - If a REAL booking (importedFromSheet=false) exists → delete every
 *     import copy in the group, keep all real bookings.
 *   - If the group is ALL import copies → keep one, delete the rest.
 * A real agent booking is NEVER deleted. Groups with more than one REAL
 * booking (e.g. same customer entered under two clients) are flagged for
 * manual review, but their import copies are still safe to remove.
 *
 * Admin-only. The default GET is read-only.
 */

const DELETE_TOKEN = 'yes-remove-import-copies'

function digits10(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10)
}

async function requireAdmin() {
  const session = await auth()
  return (session?.user as { role?: string } | undefined)?.role === 'admin'
}

type Row = {
  id: string
  customerName: string
  customerPhone: string
  apptDateTime: Date
  importedFromSheet: boolean
  client: { name: string } | null
  agent: { email: string } | null
}

async function buildReport() {
  const all: Row[] = await prisma.appointment.findMany({
    where: { status: { not: 'cancelled' } },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      apptDateTime: true,
      importedFromSheet: true,
      client: { select: { name: true } },
      agent: { select: { email: true } },
    },
  })

  // Group by identity: normalized phone + exact appointment time.
  const groups = new Map<string, Row[]>()
  for (const a of all) {
    const p = digits10(a.customerPhone)
    if (!p) continue
    const key = `${p}|${a.apptDateTime.toISOString()}`
    const arr = groups.get(key)
    if (arr) arr.push(a)
    else groups.set(key, [a])
  }

  const safeDeleteIds: string[] = []
  const duplicateGroups: Array<{
    customer: string
    phone: string
    when: string
    keep: Array<{ id: string; client: string | null; agent: string; imported: boolean }>
    delete: Array<{ id: string; client: string | null; agent: string }>
    multipleRealBookings: boolean
  }> = []

  for (const [, arr] of groups) {
    if (arr.length < 2) continue
    const reals = arr.filter((a) => !a.importedFromSheet)
    const imports = arr.filter((a) => a.importedFromSheet)

    let del: Row[]
    let keep: Row[]
    if (reals.length > 0) {
      del = imports // drop every import copy, keep the real booking(s)
      keep = reals
    } else {
      // All import copies — keep the lexicographically-first id, drop rest.
      const sorted = [...imports].sort((a, b) => a.id.localeCompare(b.id))
      keep = [sorted[0]]
      del = sorted.slice(1)
    }
    if (del.length === 0) continue

    safeDeleteIds.push(...del.map((a) => a.id))
    duplicateGroups.push({
      customer: arr[0].customerName,
      phone: digits10(arr[0].customerPhone),
      when: arr[0].apptDateTime.toISOString(),
      keep: keep.map((a) => ({
        id: a.id,
        client: a.client?.name ?? null,
        agent: a.agent?.email ?? '',
        imported: a.importedFromSheet,
      })),
      delete: del.map((a) => ({
        id: a.id,
        client: a.client?.name ?? null,
        agent: a.agent?.email ?? '',
      })),
      multipleRealBookings: reals.length > 1,
    })
  }

  return { duplicateGroups, safeDeleteIds }
}

async function handle(req: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const confirm = new URL(req.url).searchParams.get('confirm')
  const { duplicateGroups, safeDeleteIds } = await buildReport()

  if (confirm === DELETE_TOKEN) {
    if (safeDeleteIds.length === 0) {
      return NextResponse.json({ ok: true, deleted: 0, note: 'Nothing to delete.' })
    }
    // Belt-and-suspenders: the delete filter ITSELF requires
    // importedFromSheet=true, so a real booking can never be removed even
    // if the id list were somehow wrong.
    const res = await prisma.appointment.deleteMany({
      where: { id: { in: safeDeleteIds }, importedFromSheet: true },
    })
    return NextResponse.json({
      ok: true,
      deleted: res.count,
      note: `Deleted ${res.count} duplicate import copies. Every real agent booking was kept.`,
    })
  }

  const flagged = duplicateGroups.filter((g) => g.multipleRealBookings)
  return NextResponse.json({
    ok: true,
    dryRun: true,
    duplicateGroups,
    groupCount: duplicateGroups.length,
    importCopiesToDelete: safeDeleteIds.length,
    reviewFlaggedGroups: flagged.length,
    howToDelete: `Re-open this URL with ?confirm=${DELETE_TOKEN} to delete the ${safeDeleteIds.length} import copies. Every "keep" is the same customer as its "delete" (matched by phone + exact time), and the delete filter only ever removes importedFromSheet=true rows. Groups where multipleRealBookings=true have the SAME customer under two real client bookings — the import copies are still removed, but you should pick the correct client for those by hand.`,
  })
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
