import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSheetData } from '@/lib/drive'

/**
 * GET /api/drive/sheet?id=<spreadsheetId>&account=<email>&tab=<tabName?>
 *
 * Returns { title, tabs, activeTab, values } for one tab of a Google
 * spreadsheet using the Sheets API via the stored OAuth token — so it
 * works regardless of what Google account Chrome's signed into.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  const account = req.nextUrl.searchParams.get('account')
  const tab = req.nextUrl.searchParams.get('tab') || undefined
  if (!id || !account) {
    return NextResponse.json({ error: 'missing id or account' }, { status: 400 })
  }

  try {
    const data = await getSheetData(account, id, tab)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[drive/sheet] failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to load sheet'
    // Surface Google's real error shape for scope issues etc.
    const googleMsg =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message
    return NextResponse.json(
      { error: googleMsg || message },
      { status: googleMsg?.includes('insufficient') ? 403 : 500 }
    )
  }
}
