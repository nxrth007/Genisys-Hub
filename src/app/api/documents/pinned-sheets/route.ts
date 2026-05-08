import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { PINNED_SHEETS, getEmbedUrl, getViewUrl } from '@/lib/pinned-sheets'
import { getSheetData } from '@/lib/drive'
import { summarize } from '@/lib/pinned-sheets-analysis'

/**
 * GET /api/documents/pinned-sheets
 *
 * Returns the static config for each pinned sheet + a lightweight
 * read of the default tab so the listing on /documents can render
 * summary stats above each iframe.
 *
 * For the deeper tab-by-tab breakdown (every tab read, full per-tab
 * analysis, structured row layouts) see the per-sheet detail
 * endpoint at /api/documents/pinned-sheets/[key].
 *
 * Read-source: the first connected DriveAccount that has access.
 * If neither sheet is shared with any connected account, the
 * iframe still works for the user (their Google session in the
 * browser handles auth) — we just don't show summary stats.
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const account = await prisma.driveAccount.findFirst({
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })

  const results = await Promise.all(
    PINNED_SHEETS.map(async (sheet) => {
      const base = {
        key: sheet.key,
        title: sheet.title,
        description: sheet.description,
        spreadsheetId: sheet.spreadsheetId,
        defaultGid: sheet.defaultGid,
        embedUrl: getEmbedUrl(sheet),
        viewUrl: getViewUrl(sheet),
        accent: sheet.accent,
      }

      if (!account) {
        return { ...base, tabs: null, summary: null, readError: null }
      }

      try {
        const data = await getSheetData(account.email, sheet.spreadsheetId)
        return {
          ...base,
          tabs: data.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            rowCount: t.rowCount,
            columnCount: t.columnCount,
          })),
          summary: summarize(sheet.key, data.activeTab, data.values),
          readError: null,
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Failed to read sheet'
        return {
          ...base,
          tabs: null,
          summary: null,
          readError: message,
        }
      }
    }),
  )

  return NextResponse.json({
    sourceAccountEmail: account?.email ?? null,
    sheets: results,
  })
}
