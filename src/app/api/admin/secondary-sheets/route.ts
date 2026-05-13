import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/admin/secondary-sheets  — list every registered sheet
 * POST /api/admin/secondary-sheets  — register a new one
 *
 * Powers the "Partner sheets" section on /settings. Lets admin point
 * the Master Tracker ingestion at additional Google Sheets without us
 * having to do a SQL insert + redeploy every time a new partner call
 * center comes on board.
 *
 * Auth: admin/member. Sheets are an admin-tooling surface, not
 * something agents or clients should configure.
 */
function requireStaff(role: string | undefined): boolean {
  return role === 'admin' || role === 'member'
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!requireStaff((session.user as { role?: string }).role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const sheets = await prisma.secondarySheet.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      spreadsheetId: true,
      tabTitle: true,
      clientId: true,
      columnMappingKey: true,
      enabled: true,
      label: true,
      createdAt: true,
      updatedAt: true,
      client: { select: { id: true, name: true } },
    },
  })
  return NextResponse.json({ sheets })
}

/** POST body shape:
 *    { spreadsheetId, tabTitle?, clientId, columnMappingKey?, label?, enabled? }
 *
 *  Sensible defaults: tabTitle defaults to 'Sheet1' (the reader has a
 *  fallback that auto-detects the first tab if this is wrong),
 *  columnMappingKey defaults to 'yassin' (the only preset that exists
 *  today — partner sheets are all the same shape so far),
 *  enabled defaults to true. */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!requireStaff((session.user as { role?: string }).role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const spreadsheetId = String(body.spreadsheetId ?? '').trim()
  const tabTitle = String(body.tabTitle ?? 'Sheet1').trim() || 'Sheet1'
  const clientId = String(body.clientId ?? '').trim()
  const columnMappingKey =
    String(body.columnMappingKey ?? 'yassin').trim() || 'yassin'
  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim()
      : null
  const enabled = body.enabled !== false

  if (!spreadsheetId) {
    return NextResponse.json(
      { error: 'spreadsheetId is required (the ID from the sheet URL)' },
      { status: 400 },
    )
  }
  if (!clientId) {
    return NextResponse.json(
      { error: 'clientId is required (pick which client owns these appointments)' },
      { status: 400 },
    )
  }
  // Spot-check the spreadsheet ID. Google's IDs are URL-safe-base64-ish
  // and roughly 30-50 chars. Reject obviously-wrong values like a full
  // URL pasted in by mistake before we hand them to the API.
  if (/[\/\s]/.test(spreadsheetId)) {
    return NextResponse.json(
      {
        error:
          'spreadsheetId looks like a URL. Paste just the ID from between /d/ and /edit in the sheet URL.',
      },
      { status: 400 },
    )
  }
  // Reject unknown column mapping presets up front rather than letting
  // the cron silently skip rows from a misconfigured sheet.
  if (columnMappingKey !== 'yassin') {
    return NextResponse.json(
      {
        error: `Unknown columnMappingKey "${columnMappingKey}". Only "yassin" is supported today.`,
      },
      { status: 400 },
    )
  }
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  })
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }
  // Unique on (spreadsheetId, tabTitle) — duplicate registration is a
  // user error worth surfacing clearly.
  const existing = await prisma.secondarySheet.findFirst({
    where: { spreadsheetId, tabTitle },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      {
        error:
          'This sheet + tab is already registered. Edit or remove the existing entry instead.',
      },
      { status: 409 },
    )
  }

  const created = await prisma.secondarySheet.create({
    data: {
      spreadsheetId,
      tabTitle,
      clientId,
      columnMappingKey,
      label,
      enabled,
      createdById: session.user.id,
    },
    select: {
      id: true,
      spreadsheetId: true,
      tabTitle: true,
      clientId: true,
      columnMappingKey: true,
      enabled: true,
      label: true,
      createdAt: true,
      updatedAt: true,
      client: { select: { id: true, name: true } },
    },
  })
  return NextResponse.json({ sheet: created })
}
