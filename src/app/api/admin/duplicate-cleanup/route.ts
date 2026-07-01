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
  createdAt: Date
  masterSheetRowNumber: number | null
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
      createdAt: true,
      masterSheetRowNumber: true,
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
    copies: Array<{
      action: string
      client: string | null
      agent: string
      imported: boolean
      loggedAt: string
      masterSheetRow: number | null
    }>
  }> = []

  for (const [, arr] of groups) {
    if (arr.length < 2) continue

    // Newest first — KEEP the newest, everything below it is a hand-delete
    // target (per Alex: keep the newest copy of each).
    const sorted = [...arr].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )

    duplicateGroups.push({
      customer: arr[0].customerName,
      phone: digits10(arr[0].customerPhone),
      when: arr[0].apptDateTime.toISOString(),
      copies: sorted.map((a, i) => ({
        action: i === 0 ? 'KEEP (newest)' : 'DELETE',
        client: a.client?.name ?? null,
        agent: a.agent?.email ?? '',
        imported: a.importedFromSheet,
        loggedAt: a.createdAt.toISOString(),
        masterSheetRow: a.masterSheetRowNumber,
      })),
    })

    // For the optional auto-delete path, only ever queue IMPORT copies
    // (never a real agent booking), keeping the newest of the whole group.
    safeDeleteIds.push(
      ...sorted.slice(1).filter((a) => a.importedFromSheet).map((a) => a.id),
    )
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

  return NextResponse.json({
    ok: true,
    dryRun: true,
    duplicateGroups,
    duplicateCustomers: duplicateGroups.length,
    note: `Each group is one customer's duplicate rows, newest first. On the master tracker, KEEP the "KEEP (newest)" copy and delete the ones marked DELETE (match them by customer + agent + logged-at). NOTE: deleting on the master tracker removes the SHEET row, which is what you want here — the DB-only ?confirm delete does NOT change the tracker.`,
  })
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
