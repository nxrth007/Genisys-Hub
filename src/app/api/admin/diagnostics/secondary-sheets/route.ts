import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readSecondarySheetRows } from '@/lib/secondary-sheets'
import {
  getSheetsClient,
  getWriterAccountEmail,
} from '@/lib/drive'

/**
 * GET /api/admin/diagnostics/secondary-sheets
 *
 * Admin-only debug endpoint. Walks every registered SecondarySheet
 * and reports:
 *   - Whether the row exists in the DB at all (seed migration ran?)
 *   - Whether the linked Client.id resolves to an actual Client row
 *   - Whether the Google Drive account can actually fetch the sheet
 *     (sharing permissions OK, sheet ID valid, tab name correct)
 *   - How many rows came back from each sheet
 *   - The first 3 rows of mapped data so we can eyeball whether
 *     the column mapping is working
 *
 * Built to chase the 2026-05-13 "I deployed Yassin's sheet integration
 * but no appointments are showing up" question. Lets us tell at a
 * glance whether the failure is:
 *   - seed migration silently inserted no rows (Client name mismatch)
 *   - Drive account lacks share access to the sheet
 *   - tab title wrong
 *   - sheet is empty
 *   - column mapping is broken
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string }).role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // 1. All known client names — used to surface a clean "is the seed
  //    migration's name lookup likely to hit?" check.
  const clients = await prisma.client.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  // 2. Every registered SecondarySheet row, with the linked Client
  //    (or null if the seed couldn't match a name).
  const sheets = await prisma.secondarySheet.findMany({
    select: {
      id: true,
      spreadsheetId: true,
      tabTitle: true,
      clientId: true,
      columnMappingKey: true,
      enabled: true,
      label: true,
      createdAt: true,
      client: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // 3. Try to fetch each sheet directly so we can distinguish "Drive
  //    permission denied" from "no rows present" from "tab name
  //    wrong." One try/catch per sheet so a broken sheet doesn't
  //    short-circuit the others.
  const writerEmail = await getWriterAccountEmail().catch(() => null)
  let driveClient: Awaited<ReturnType<typeof getSheetsClient>> | null = null
  if (writerEmail) {
    driveClient = await getSheetsClient(writerEmail).catch(() => null)
  }

  const perSheetDiagnostics = await Promise.all(
    sheets.map(async (s) => {
      const result: Record<string, unknown> = {
        spreadsheetId: s.spreadsheetId,
        tabTitle: s.tabTitle,
        clientId: s.clientId,
        clientName: s.client?.name ?? null,
        enabled: s.enabled,
        label: s.label,
      }
      if (!driveClient) {
        result.error = 'No Drive client available (no writer account configured)'
        return result
      }
      try {
        const range = `'${s.tabTitle.replace(/'/g, "''")}'!A1:Z`
        const res = await driveClient.spreadsheets.values.get({
          spreadsheetId: s.spreadsheetId,
          range,
          valueRenderOption: 'FORMATTED_VALUE',
        })
        const allRows = (res.data.values ?? []) as string[][]
        const headerRow = allRows[0] ?? []
        const dataRows = allRows.slice(1)
        result.fetchOk = true
        result.headerRow = headerRow
        result.dataRowCount = dataRows.length
        result.firstThreeDataRows = dataRows.slice(0, 3)
      } catch (err) {
        result.fetchOk = false
        result.error =
          err instanceof Error
            ? `${err.name}: ${err.message}`
            : 'Unknown error fetching sheet'
      }
      return result
    }),
  )

  // 4. Run the actual readSecondarySheetRows pipeline so we know what
  //    the scheduler / consumers would see, including column mapping.
  let mappedRows: unknown = null
  let mappedError: string | null = null
  try {
    const rows = await readSecondarySheetRows()
    mappedRows = {
      count: rows.length,
      first3: rows.slice(0, 3).map((r) => ({
        rowNumber: r.rowNumber,
        apptDateTime: r.apptDateTime,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        address: r.address,
        client: r.client,
        status: r.status,
        source: r.source,
      })),
    }
  } catch (err) {
    mappedError =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }

  return NextResponse.json({
    summary: {
      registeredSheets: sheets.length,
      driveAccount: writerEmail,
      driveClientAvailable: !!driveClient,
      mappedRowsCount:
        typeof mappedRows === 'object' && mappedRows && 'count' in mappedRows
          ? (mappedRows as { count: number }).count
          : null,
    },
    // All your clients (so we can match names against the seed)
    clients,
    // Each registered sheet + a direct fetch attempt
    sheets: perSheetDiagnostics,
    // What the actual readSecondarySheetRows pipeline produces
    mappedRows,
    mappedError,
  })
}
