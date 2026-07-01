import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { readAllSheetRows } from '@/lib/secondary-sheets'
import { deleteMasterTableRow } from '@/lib/drive'

/**
 * GET  /api/admin/duplicate-cleanup                            → dry-run report
 * GET  /api/admin/duplicate-cleanup?confirm=yes-remove-duplicate-rows → delete
 *
 * Removes duplicate rows from the master Google Sheet (which is what the
 * master tracker displays). Groups master-table rows by customer
 * identity — normalized phone + exact appointment time — and per group
 * KEEPS the newest (by the sheet's "Logged At" timestamp, tie-break the
 * lowest row number = the original) and deletes the rest.
 *
 * Deletes are done bottom-up (highest row number first) so removing one
 * row can't shift the position of a not-yet-deleted row. Only touches
 * MASTER-table (primary) rows; secondary partner sheets are untouched.
 *
 * Admin-only. Default GET is read-only. Capped per run as a backstop.
 */

const DELETE_TOKEN = 'yes-remove-duplicate-rows'
const MAX_DELETIONS_PER_RUN = 60

function digits10(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10)
}

function loggedAtMs(raw: string | null): number {
  if (!raw) return 0
  const t = new Date(raw).getTime()
  return Number.isFinite(t) ? t : 0
}

async function requireAdmin() {
  const session = await auth()
  return (session?.user as { role?: string } | undefined)?.role === 'admin'
}

async function buildPlan() {
  const rows = await readAllSheetRows()

  // Master-table rows only (deleteMasterTableRow operates on that sheet),
  // with a usable phone + appointment time.
  const primary = rows.filter(
    (r) =>
      r.source.kind === 'primary' &&
      !!digits10(r.customerPhone) &&
      !!r.apptDateTime,
  )

  const groups = new Map<string, typeof primary>()
  for (const r of primary) {
    const key = `${digits10(r.customerPhone)}|${r.apptDateTime}`
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }

  const plan: Array<{
    customer: string
    phone: string
    when: string | null
    keep: { row: number; agent: string | null; loggedAt: string | null }
    delete: Array<{ row: number; agent: string | null; loggedAt: string | null }>
  }> = []
  const deleteRowNumbers: number[] = []

  for (const [, arr] of groups) {
    if (arr.length < 2) continue
    // Newest first by Logged At; tie → lowest row number (the original).
    const sorted = [...arr].sort((a, b) => {
      const d = loggedAtMs(b.loggedAt) - loggedAtMs(a.loggedAt)
      return d !== 0 ? d : a.rowNumber - b.rowNumber
    })
    const keeper = sorted[0]
    const dels = sorted.slice(1)
    plan.push({
      customer: keeper.customerName,
      phone: digits10(keeper.customerPhone),
      when: keeper.apptDateTime,
      keep: {
        row: keeper.rowNumber,
        agent: keeper.agentName,
        loggedAt: keeper.loggedAt,
      },
      delete: dels.map((d) => ({
        row: d.rowNumber,
        agent: d.agentName,
        loggedAt: d.loggedAt,
      })),
    })
    deleteRowNumbers.push(...dels.map((d) => d.rowNumber))
  }

  // Delete bottom-up so earlier deletions don't shift later row numbers.
  deleteRowNumbers.sort((a, b) => b - a)
  return { plan, deleteRowNumbers }
}

async function handle(req: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const confirm = new URL(req.url).searchParams.get('confirm')
  const { plan, deleteRowNumbers } = await buildPlan()

  if (confirm === DELETE_TOKEN) {
    if (deleteRowNumbers.length > MAX_DELETIONS_PER_RUN) {
      return NextResponse.json(
        {
          error: `Safety cap: ${deleteRowNumbers.length} rows flagged (max ${MAX_DELETIONS_PER_RUN}/run). That's more than expected — look at the dry-run before proceeding, then tell Claude.`,
        },
        { status: 400 },
      )
    }
    let deleted = 0
    const failed: number[] = []
    // Descending order — see buildPlan().
    for (const rowNumber of deleteRowNumbers) {
      try {
        await deleteMasterTableRow(rowNumber)
        deleted++
      } catch {
        failed.push(rowNumber)
      }
    }
    return NextResponse.json({
      ok: true,
      deleted,
      failedRows: failed,
      note: `Deleted ${deleted} duplicate sheet rows (kept the newest of each). Refresh the master tracker — the DUP chips should be gone. Re-run the dry-run to confirm 0 groups remain.`,
    })
  }

  return NextResponse.json({
    ok: true,
    dryRun: true,
    duplicateCustomers: plan.length,
    rowsToDelete: deleteRowNumbers.length,
    plan,
    howToDelete: `Read-only. Each group KEEPs the newest row (by Logged At) and lists the rows it will DELETE. To actually remove them from the sheet, re-open with ?confirm=${DELETE_TOKEN}. This deletes real Google-Sheet rows, so glance over the plan first.`,
  })
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
