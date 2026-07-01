import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/admin/duplicate-cleanup            → dry-run report (read-only)
 * POST /api/admin/duplicate-cleanup?confirm=1  → delete the sheet-import copies
 *
 * Cleans up the duplicate appointments the 5-min sheet-import created
 * before the dedup fix (commit 51c0f02). SAFE target only: an appointment
 * with importedFromSheet=true whose masterSheetRowNumber is ALSO claimed
 * by a REAL Hub booking (importedFromSheet=false) — i.e. the import made
 * a second copy of a row an agent already booked. We delete the import
 * copy and keep the real booking. AppointmentReminder + edit logs cascade
 * on delete, so no orphans.
 *
 * `otherSuspected` surfaces content-based look-alikes (same phone + same
 * appt hour) that are NOT the safe import-copy pattern — e.g. an agent
 * re-booking at a different time. These are REPORTED only, never
 * auto-deleted, because either copy could be the real one.
 *
 * Admin-only. The dry-run GET touches nothing.
 */

function digits10(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10)
}

async function requireAdmin() {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  return role === 'admin'
}

async function buildReport() {
  // Real Hub bookings that own a master-sheet row.
  const realRows = await prisma.appointment.findMany({
    where: { importedFromSheet: false, masterSheetRowNumber: { not: null } },
    select: { masterSheetRowNumber: true },
  })
  const realRowSet = new Set(
    realRows.map((r) => r.masterSheetRowNumber).filter((n): n is number => n != null),
  )

  // Import copies sitting on one of those same rows → safe to remove.
  const importCopies = realRowSet.size
    ? await prisma.appointment.findMany({
        where: {
          importedFromSheet: true,
          masterSheetRowNumber: { in: [...realRowSet] },
        },
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          apptDateTime: true,
          masterSheetRowNumber: true,
          client: { select: { name: true } },
          agent: { select: { email: true } },
        },
        orderBy: { masterSheetRowNumber: 'asc' },
      })
    : []

  // For each import copy, show the real booking on the same row it maps to.
  const keepersByRow = new Map<
    number,
    { id: string; customerName: string; client: string | null; agent: string }
  >()
  if (importCopies.length) {
    const keepers = await prisma.appointment.findMany({
      where: {
        importedFromSheet: false,
        masterSheetRowNumber: {
          in: importCopies
            .map((c) => c.masterSheetRowNumber)
            .filter((n): n is number => n != null),
        },
      },
      select: {
        id: true,
        customerName: true,
        masterSheetRowNumber: true,
        client: { select: { name: true } },
        agent: { select: { email: true } },
      },
    })
    for (const k of keepers) {
      if (k.masterSheetRowNumber != null && !keepersByRow.has(k.masterSheetRowNumber)) {
        keepersByRow.set(k.masterSheetRowNumber, {
          id: k.id,
          customerName: k.customerName,
          client: k.client?.name ?? null,
          agent: k.agent?.email ?? '',
        })
      }
    }
  }

  const toRemove = importCopies.map((c) => ({
    row: c.masterSheetRowNumber,
    remove: {
      id: c.id,
      customer: c.customerName,
      phone: c.customerPhone,
      when: c.apptDateTime,
      client: c.client?.name ?? null,
      agent: c.agent?.email ?? '',
    },
    keep: c.masterSheetRowNumber != null ? keepersByRow.get(c.masterSheetRowNumber) : null,
  }))

  // Content-based look-alikes NOT covered above (e.g. agent re-books at a
  // different time). Report only.
  const removeIds = new Set(importCopies.map((c) => c.id))
  const all = await prisma.appointment.findMany({
    where: { status: { not: 'cancelled' } },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      apptDateTime: true,
      clientId: true,
      importedFromSheet: true,
      client: { select: { name: true } },
      agent: { select: { email: true } },
    },
  })
  const byContent = new Map<string, typeof all>()
  for (const a of all) {
    const p = digits10(a.customerPhone)
    if (!p) continue
    const key = `${p}|${a.apptDateTime.toISOString().slice(0, 13)}` // phone + hour
    const arr = byContent.get(key) ?? []
    arr.push(a)
    byContent.set(key, arr)
  }
  const otherSuspected: Array<{
    phone: string
    copies: Array<{
      id: string
      customer: string
      when: Date
      client: string | null
      agent: string
      imported: boolean
    }>
  }> = []
  for (const [, arr] of byContent) {
    if (arr.length < 2) continue
    // Skip groups already fully handled by the safe import-copy pass.
    const remaining = arr.filter((a) => !removeIds.has(a.id))
    if (remaining.length < 2) continue
    otherSuspected.push({
      phone: digits10(remaining[0].customerPhone),
      copies: remaining.map((a) => ({
        id: a.id,
        customer: a.customerName,
        when: a.apptDateTime,
        client: a.client?.name ?? null,
        agent: a.agent?.email ?? '',
        imported: a.importedFromSheet,
      })),
    })
  }

  return { toRemove, otherSuspected, safeRemoveIds: [...removeIds] }
}

// Explicit token required to actually delete — an admin has to type it
// into the URL, so no prefetch/bookmark can trigger a deletion.
const DELETE_TOKEN = 'yes-remove-import-copies'

async function handle(req: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const url = new URL(req.url)
  const confirm = url.searchParams.get('confirm')

  const { toRemove, otherSuspected, safeRemoveIds } = await buildReport()

  // DELETE path — plain GET/POST with ?confirm=<token>.
  if (confirm === DELETE_TOKEN) {
    if (safeRemoveIds.length === 0) {
      return NextResponse.json({
        ok: true,
        deleted: 0,
        note: 'No import-copy duplicates found — nothing to delete.',
      })
    }
    const res = await prisma.appointment.deleteMany({
      where: { id: { in: safeRemoveIds }, importedFromSheet: true },
    })
    return NextResponse.json({
      ok: true,
      deleted: res.count,
      note: `Deleted ${res.count} sheet-import duplicate copies; every real Hub booking was kept.`,
      otherSuspectedRemaining: otherSuspected.length,
    })
  }

  // Default — read-only report.
  return NextResponse.json({
    ok: true,
    dryRun: true,
    importCopiesToRemove: toRemove,
    importCopyCount: toRemove.length,
    otherSuspectedGroups: otherSuspected,
    otherSuspectedCount: otherSuspected.length,
    howToDelete: `Re-open this URL with ?confirm=${DELETE_TOKEN} to delete the ${toRemove.length} import copies (keeps every real booking). The "otherSuspected" groups are look-alikes (e.g. agent re-books) that are NOT auto-deleted — review by hand.`,
  })
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
